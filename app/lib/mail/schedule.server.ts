/**
 * Scheduled send: a scheduled message is a draft with a `scheduled_at`, which the cron (`workers/scheduled.ts`)
 * sends once its moment has come, through the same `sendComposed` as the composer, with the draft's files and the
 * signature it chose. Scheduling checks it as that send will (`checkComposed`). Until then it waits under Scheduled,
 * not Drafts; "Cancel send" makes it a draft again. A send that fails puts it back among the drafts with the reason
 * (`send_error`), so nothing is lost and nothing loops.
 */
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";

import type { Database } from "~/db";
import { drafts, users } from "~/db/schema";
import type { Draft, User } from "~/db/schema";
import { defined } from "~/lib/guards";

import { parseJsonAddresses } from "./addresses";
import type { AddressList } from "./addresses";
import {
  SendError,
  checkComposed,
  saveDraft,
  sendComposed,
} from "./send.server";
import type { ComposedMail, DraftInput } from "./send.server";

export class ScheduleError extends Error {
  override name = "ScheduleError";
}

/** The furthest ahead a message can be scheduled. */
export const MAX_SCHEDULE_DAYS = 366;

/** How long a run holds a due message while it sends it; one that died midway is tried again after this. */
const CLAIM_MS = 10 * 60_000;

/** The moment a message is to go, checked: a real moment, not past (a minute's grace), at most a year on. */
export const scheduleMoment = (value: string, now = new Date()): string => {
  const at = new Date(value);

  if (!value || Number.isNaN(at.getTime())) {
    throw new ScheduleError("Pick when to send it.");
  }

  if (at.getTime() < now.getTime() - 60_000) {
    throw new ScheduleError("That moment has passed. Pick one in the future.");
  }

  if (at.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * 86_400_000) {
    throw new ScheduleError("A message can be scheduled up to a year ahead.");
  }

  return at.toISOString();
};

/** Schedule one of the owner's drafts. Its last failure, if any, is forgotten. */
export const scheduleDraft = async (
  db: Database,
  userId: string,
  draftId: string,
  at: string
): Promise<void> => {
  const updated = await db
    .update(drafts)
    .set({ scheduledAt: at, sendError: null })
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, userId)))
    .returning({ id: drafts.id });

  if (!updated.length) {
    throw new ScheduleError("That draft no longer exists.");
  }
};

/** "Cancel send": the scheduled message is a draft again. False when it is gone (sent, or deleted). */
export const unscheduleDraft = async (
  db: Database,
  userId: string,
  draftId: string
): Promise<boolean> => {
  const updated = await db
    .update(drafts)
    .set({ scheduledAt: null })
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.userId, userId),
        isNotNull(drafts.scheduledAt)
      )
    )
    .returning({ id: drafts.id });

  return updated.length > 0;
};

/** The owner's scheduled messages, the next to go first. */
export const listScheduled = async (
  db: Database,
  userId: string
): Promise<Draft[]> =>
  await db.query.drafts.findMany({
    where: and(eq(drafts.userId, userId), isNotNull(drafts.scheduledAt)),
    orderBy: [asc(drafts.scheduledAt)],
    limit: 100,
  });

/** What the composer holds, with what its draft keeps besides and the moment it is to go. */
export interface ScheduledMail extends ComposedMail {
  threadId: string | null;
  mode: DraftInput["mode"];
  /** The moment as the composer posts it, checked by `scheduleMoment`. */
  sendAt: string;
}

/**
 * "Send later": what the composer holds is checked as the send will check it (`checkComposed`), saved as its draft,
 * and scheduled for `sendAt`; the cron sends it then (`sendDueDrafts`). Refused, nothing is saved or scheduled.
 */
export const scheduleComposed = async (
  env: Env,
  db: Database,
  user: User,
  mail: ScheduledMail,
  now = new Date()
): Promise<{ draftId: string; scheduledAt: string }> => {
  await checkComposed(env, db, user, mail);
  const at = scheduleMoment(mail.sendAt, now);

  const draftId = await saveDraft(db, user.id, {
    id: mail.draftId,
    threadId: mail.threadId,
    inReplyToId: mail.inReplyToId,
    mode: mail.mode,
    from: mail.from,
    to: mail.to.addresses,
    cc: mail.cc.addresses,
    bcc: mail.bcc.addresses,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    signatureId: mail.signatureId,
    pgp: mail.pgp,
  });

  await scheduleDraft(db, user.id, draftId, at);

  return { draftId, scheduledAt: at };
};

/** A draft's recipients, kept as addresses: nothing typed that is not one was saved. */
const kept = (json: string): AddressList => ({
  addresses: parseJsonAddresses(json),
  invalid: [],
});

const sendScheduled = async (
  env: Env,
  db: Database,
  d: Draft
): Promise<void> => {
  const user = await db.query.users.findFirst({
    where: eq(users.id, d.userId),
  });

  if (!user?.active) {
    throw new SendError(
      "The mailbox is deactivated, so nothing is sent from it."
    );
  }

  await sendComposed(env, db, user, {
    from: d.fromEmail,
    to: kept(d.toJson),
    cc: kept(d.ccJson),
    bcc: kept(d.bccJson),
    subject: d.subject,
    text: d.text,
    html: d.html,
    inReplyToId: d.inReplyToId,
    signatureId: d.signatureId,
    pgp: { sign: d.pgpSign, encrypt: d.pgpEncrypt },
    draftId: d.id,
  });
};

/**
 * Send every scheduled message whose moment has come, oldest first, `limit` at a time. Each is claimed first (its
 * moment moved on by `CLAIM_MS`, if nobody else moved it), so two runs never send one twice; sent, the draft and its
 * files are gone; failed, it is a draft again with the reason on it.
 */
export const sendDueDrafts = async (
  env: Env,
  db: Database,
  now = new Date(),
  limit = 25
): Promise<{ sent: number; failed: number }> => {
  const due = await db.query.drafts.findMany({
    where: and(
      isNotNull(drafts.scheduledAt),
      lte(drafts.scheduledAt, now.toISOString())
    ),
    orderBy: [asc(drafts.scheduledAt)],
    limit,
  });

  let sent = 0;
  let failed = 0;

  for (const d of due) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- scheduled drafts go out one at a time: each is claimed before it is sent, so no run sends one twice
    const claimed = await db
      .update(drafts)
      .set({ scheduledAt: new Date(now.getTime() + CLAIM_MS).toISOString() })
      .where(
        and(
          eq(drafts.id, d.id),
          eq(drafts.scheduledAt, defined(d.scheduledAt, "the scheduled at"))
        )
      )
      .returning({ id: drafts.id });

    if (!claimed.length) {
      continue;
    }

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- scheduled drafts go out one at a time: each is claimed before it is sent, so no run sends one twice
      await sendScheduled(env, db, d);
      sent += 1;
    } catch (error) {
      failed += 1;

      const message =
        error instanceof SendError
          ? error.message
          : `The message was not sent: ${error instanceof Error ? error.message : String(error)}`;

      // oxlint-disable-next-line eslint/no-await-in-loop -- scheduled drafts go out one at a time: each is claimed before it is sent, so no run sends one twice
      await db
        .update(drafts)
        .set({ scheduledAt: null, sendError: message })
        .where(eq(drafts.id, d.id));
      console.log(
        JSON.stringify({
          event: "mail.scheduled.failed",
          draftId: d.id,
          userId: d.userId,
          error: message,
        })
      );
    }
  }

  return { sent, failed };
};
