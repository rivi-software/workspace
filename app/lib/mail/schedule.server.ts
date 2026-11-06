/**
 * Scheduled send: a scheduled message is a draft with a `scheduled_at`, which the cron (`workers/scheduled.ts`)
 * sends once its moment has come, through the same `sendMail` as the composer, with the draft's files and the
 * signature it chose. Until then it waits under Scheduled, not Drafts; "Cancel send" makes it a draft again. A send
 * that fails puts it back among the drafts with the reason (`send_error`), so nothing is lost and nothing loops.
 */
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";

import type { Database } from "~/db";
import { drafts, users } from "~/db/schema";
import type { Draft } from "~/db/schema";
import { defined } from "~/lib/guards";

import { parseJsonAddresses } from "./addresses";
import {
  SendError,
  deleteDraft,
  draftFilesForSending,
  sendMail,
  sendableAddresses,
} from "./send.server";

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

  const addresses = await sendableAddresses(db, user);
  const from = addresses.find((a) => a.email === d.fromEmail);

  if (!from) {
    throw new SendError(`You can no longer send as ${d.fromEmail}.`);
  }

  await sendMail(env, db, user, {
    from,
    to: parseJsonAddresses(d.toJson),
    cc: parseJsonAddresses(d.ccJson),
    bcc: parseJsonAddresses(d.bccJson),
    subject: d.subject,
    text: d.text,
    html: d.html,
    inReplyToId: d.inReplyToId,
    signatureId: d.signatureId,
    files: await draftFilesForSending(db, env, user.id, d.id),
  });
  await deleteDraft(db, env, user.id, d.id);
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
