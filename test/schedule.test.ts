import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { draftFiles, drafts, messages, users } from "~/db/schema";
import { folderCounts } from "~/lib/mail/mailbox.server";
import {
  ScheduleError,
  listScheduled,
  scheduleDraft,
  scheduleMoment,
  sendDueDrafts,
  unscheduleDraft,
} from "~/lib/mail/schedule.server";
import {
  addDraftFiles,
  draftForThread,
  listDrafts,
  saveDraft,
  sendMail,
} from "~/lib/mail/send.server";
import type { DraftInput } from "~/lib/mail/send.server";
import { saveSignature } from "~/lib/mail/signatures.server";
import { sendLaterPresets } from "~/lib/mail/snooze";

import { db, mailbox, recordingEmail } from "./fixtures";

const draft = (from: string, over: Partial<DraftInput> = {}): DraftInput => ({
  mode: "new",
  from,
  to: [{ email: "jane@acme.com", name: "Jane" }],
  cc: [],
  bcc: [],
  subject: "Later",
  text: "",
  html: "<div>Sent while you sleep.</div>",
  ...over,
});

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

describe("scheduled send", () => {
  it("checks the moment: a real one, not past, at most a year on", () => {
    const now = new Date("2026-10-25T12:00:00Z");
    expect({
      nextDay: scheduleMoment("2026-10-26T08:00:00+01:00", now),
      grace: scheduleMoment("2026-10-25T11:59:30Z", now),
    }).toStrictEqual({
      nextDay: "2026-10-26T07:00:00.000Z",
      grace: "2026-10-25T11:59:30.000Z",
    });

    expect(() => scheduleMoment("", now)).toThrow(ScheduleError);
    expect(() => scheduleMoment("tomorrow", now)).toThrow(
      "Pick when to send it."
    );
    expect(() => scheduleMoment("2026-10-25T11:00:00Z", now)).toThrow(
      "That moment has passed"
    );
    expect(() => scheduleMoment("2027-12-01T08:00:00Z", now)).toThrow(
      "up to a year ahead"
    );
  });

  it("offers tomorrow morning and afternoon and Monday morning, once each", () => {
    const friday = new Date(2026, 9, 23, 15, 0);
    expect(
      sendLaterPresets(friday).map((p) => [
        p.key,
        p.at.getDate(),
        p.at.getHours(),
      ])
    ).toStrictEqual([
      ["morning", 24, 8],
      ["afternoon", 24, 13],
      ["monday", 26, 8],
    ]);
    // On Sunday tomorrow morning is Monday morning.
    const sunday = new Date(2026, 9, 25, 15, 0);
    expect(sendLaterPresets(sunday).map((p) => p.key)).toStrictEqual([
      "morning",
      "afternoon",
    ]);
  });

  it("moves a scheduled message from Drafts to Scheduled, and back with Cancel send", async () => {
    const user = await mailbox("petra");
    const id = await saveDraft(db, user.id, draft(user.email));
    await scheduleDraft(db, user.id, id, minutes(60));
    const listedDrafts = await listDrafts(db, user.id);
    const scheduled = await listScheduled(db, user.id);
    const counts = await folderCounts(db, user.id);

    expect({
      draftContains: listedDrafts.map((d) => d.id).includes(id),
      scheduledIds: scheduled.map((d) => d.id),
      counts,
    }).toMatchObject({
      draftContains: false,
      scheduledIds: [id],
      counts: {
        drafts: 0,
        scheduled: 1,
      },
    });

    await expect(unscheduleDraft(db, user.id, id)).resolves.toBeTruthy();
    const listedDrafts2 = await listDrafts(db, user.id);
    expect({
      listDraftsMap: listedDrafts2.map((d) => d.id).includes(id),
      listScheduled: await listScheduled(db, user.id),
    }).toStrictEqual({ listDraftsMap: true, listScheduled: [] });
    // Cancelling twice, or someone else's, does nothing.
    await expect(unscheduleDraft(db, user.id, id)).resolves.toBeFalsy();
    const other = await mailbox("pieter");
    await expect(scheduleDraft(db, other.id, id, minutes(5))).rejects.toThrow(
      ScheduleError
    );
  });

  it("keeps a scheduled reply out of the thread's reply box", async () => {
    const user = await mailbox("rosa");
    const { env: testEnv } = recordingEmail();

    const { threadId, messageId } = await sendMail(testEnv, db, user, {
      from: user.email,
      to: [{ email: "jane@acme.com", name: null }],
      cc: [],
      bcc: [],
      subject: "Start",
      text: "Hello",
      files: [],
    });

    const id = await saveDraft(
      db,
      user.id,
      draft(user.email, { mode: "reply", threadId, inReplyToId: messageId })
    );

    const foundDraft = await draftForThread(db, user.id, threadId);
    expect(foundDraft?.id).toBe(id);
    await scheduleDraft(db, user.id, id, minutes(30));
    await expect(
      draftForThread(db, user.id, threadId)
    ).resolves.toBeUndefined();
  });

  it("sends what is due with its files and signature, once, and leaves the rest", async () => {
    const user = await mailbox("otis", "Otis");

    const signatureId = await saveSignature(db, user.id, {
      name: "Work",
      text: "Otis",
    });

    const due = await saveDraft(
      db,
      user.id,
      draft(user.email, { signatureId })
    );

    await addDraftFiles(db, env, user.id, due, [
      {
        filename: "notes.txt",
        contentType: "text/plain",
        content: new TextEncoder().encode("notes").buffer,
      },
    ]);

    const later = await saveDraft(
      db,
      user.id,
      draft(user.email, { subject: "Not yet" })
    );

    await scheduleDraft(db, user.id, due, minutes(-2));
    await scheduleDraft(db, user.id, later, minutes(90));

    const { sent, env: testEnv } = recordingEmail();

    // Two runs at once: the claim lets one of them send it.
    const runs = await Promise.all([
      sendDueDrafts(testEnv, db),
      sendDueDrafts(testEnv, db),
    ]);

    expect({
      reduce: runs.reduce((n, r) => n + r.sent, 0),
      sent: sent.length,
    }).toStrictEqual({ reduce: 1, sent: 1 });
    expect(sent[0]).toMatchObject({
      subject: "Later",
      text: "Sent while you sleep.\n\n-- \nOtis",
      attachments: [expect.objectContaining({ filename: "notes.txt" })],
    });
    // Sent: the draft and its files are gone, the message is under Sent; the later one still waits.
    expect({
      draftsFindFirst: await db.query.drafts.findFirst({
        where: eq(drafts.id, due),
      }),
      draftFilesFindMany: await db.query.draftFiles.findMany({
        where: eq(draftFiles.draftId, due),
      }),
    }).toStrictEqual({ draftsFindFirst: undefined, draftFilesFindMany: [] });
    await expect(
      db.query.messages.findFirst({
        where: and(eq(messages.subject, "Later"), eq(messages.userId, user.id)),
      })
    ).resolves.toMatchObject({
      direction: "outbound",
      deliveryStatus: "sent",
      userId: user.id,
    });
    const scheduled = await listScheduled(db, user.id);
    const dueResult = await sendDueDrafts(testEnv, db);

    expect({
      listScheduledMap: scheduled.map((d) => d.id),
      sent: dueResult.sent,
    }).toStrictEqual({ listScheduledMap: [later], sent: 0 });
  });

  it("puts a message that cannot go back among the drafts, with the reason", async () => {
    const user = await mailbox("fenna");

    const failing = await saveDraft(
      db,
      user.id,
      draft(user.email, { subject: "Refused" })
    );

    await scheduleDraft(db, user.id, failing, minutes(-1));
    const { sent, env: testEnv } = recordingEmail("Sender not verified");
    await expect(sendDueDrafts(testEnv, db)).resolves.toMatchObject({
      sent: 0,
      failed: 1,
    });
    expect(sent).toStrictEqual([]);

    const row = await db.query.drafts.findFirst({
      where: eq(drafts.id, failing),
    });

    expect(row).toMatchObject({
      scheduledAt: null,
      sendError: "The message was not sent: EMAIL_FAILED Sender not verified",
    });
    const listedDrafts = await listDrafts(db, user.id);
    expect(listedDrafts.map((d) => d.id)).toContain(failing);
    // Scheduling it again forgets the failure.
    await scheduleDraft(db, user.id, failing, minutes(10));

    const draftRow = await db.query.drafts.findFirst({
      where: eq(drafts.id, failing),
    });

    expect(draftRow?.sendError).toBeNull();
  });

  it("sends nothing from a mailbox deactivated since", async () => {
    const user = await mailbox("gone");
    const id = await saveDraft(db, user.id, draft(user.email));
    await scheduleDraft(db, user.id, id, minutes(-1));
    await db.update(users).set({ active: false }).where(eq(users.id, user.id));
    const { sent, env: testEnv } = recordingEmail();
    await sendDueDrafts(testEnv, db);
    expect(sent).toStrictEqual([]);

    const draftRow = await db.query.drafts.findFirst({
      where: eq(drafts.id, id),
    });

    expect(draftRow?.sendError).toMatch(/deactivated/u);
  });
});
