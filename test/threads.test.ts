import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { ingestInboundEmail } from "~/lib/mail/ingest.server";
import { createLabel, deleteLabel } from "~/lib/mail/labels.server";
import { listThreads, loadThread } from "~/lib/mail/mailbox.server";
import {
  applyThreadAction,
  markThreadRead,
  undoThreadAction,
  wakeSnoozed,
} from "~/lib/mail/threads.server";

import { handleScheduled } from "../workers/scheduled";
import { db, defined, mail, mailbox } from "./fixtures";

const minutes = (n: number, from = new Date()) =>
  new Date(from.getTime() + n * 60_000);

const deliver = async (
  email: string,
  over: Parameters<typeof mail>[0] = {}
) => {
  const r = await ingestInboundEmail(
    env,
    null,
    mail({ to: [{ email, name: null }], ...over }),
    email
  );

  if (r.status !== "stored") {
    throw new Error(`not stored: ${r.status}`);
  }

  return r.threadId;
};

/** The conversation as the list shows it in a view. */
const inView = async (
  userId: string,
  folder: "inbox" | "snoozed" | "trash" | "spam",
  id: string
) => {
  const threads = await listThreads(db, userId, { folder });

  return threads.find((t) => t.id === id);
};

describe("undoing an action on conversations", () => {
  it("puts back a snooze that ends within the minute, though a new one that soon is refused", async () => {
    const user = await mailbox("una");
    const a = await deliver(user.email, { subject: "Back soon" });
    const until = minutes(0.5).toISOString();
    await expect(
      applyThreadAction(db, env, user.id, [a], { intent: "snooze", until })
    ).rejects.toThrow("That moment has passed");
    // Snoozed an hour ago, until half a minute from now; then archived.
    await applyThreadAction(
      db,
      env,
      user.id,
      [a],
      { intent: "snooze", until },
      minutes(-60)
    );

    const { undo } = await applyThreadAction(db, env, user.id, [a], {
      intent: "archive",
    });

    await expect(inView(user.id, "snoozed", a)).resolves.toBeUndefined();
    await expect(
      undoThreadAction(db, env, user.id, defined(undo))
    ).resolves.toBeTruthy();
    await expect(inView(user.id, "snoozed", a)).resolves.toMatchObject({
      folder: "inbox",
      snoozedUntil: until,
    });
  });

  it("puts a conversation back in the trash with the time it went there", async () => {
    const user = await mailbox("ute");
    const a = await deliver(user.email, { subject: "Old news" });
    const binned = minutes(-10 * 24 * 60);
    await applyThreadAction(db, env, user.id, [a], { intent: "trash" }, binned);

    const { undo } = await applyThreadAction(db, env, user.id, [a], {
      intent: "inbox",
    });

    await expect(inView(user.id, "inbox", a)).resolves.toMatchObject({
      trashedAt: null,
    });
    await undoThreadAction(db, env, user.id, defined(undo));
    await expect(inView(user.id, "trash", a)).resolves.toMatchObject({
      trashedAt: binned.toISOString(),
    });
  });

  it("puts back the messages that were unread, not the whole conversation", async () => {
    const user = await mailbox("uri");

    const a = await deliver(user.email, {
      subject: "Two parts",
      messageId: "<part1@acme.com>",
    });

    await markThreadRead(db, user.id, a);
    await deliver(user.email, {
      subject: "Re: Two parts",
      references: ["<part1@acme.com>"],
    });

    const { undo } = await applyThreadAction(db, env, user.id, [a], {
      intent: "read",
    });

    const view = await inView(user.id, "inbox", a);
    expect(view?.unreadCount).toBe(0);
    await undoThreadAction(db, env, user.id, defined(undo));
    const loaded = defined(await loadThread(db, env, user.id, a));
    expect(loaded.thread.unreadCount).toBe(1);
    expect(loaded.messages.map((m) => m.read)).toStrictEqual([true, false]);
  });

  it("puts a muted conversation back in the inbox, unmuted and snoozed as it was", async () => {
    const user = await mailbox("ulla");
    const a = await deliver(user.email, { subject: "Noisy" });
    const until = minutes(120).toISOString();
    await applyThreadAction(db, env, user.id, [a], { intent: "snooze", until });

    const { undo } = await applyThreadAction(db, env, user.id, [a], {
      intent: "mute",
    });

    const thread = await loadThread(db, env, user.id, a);
    expect(thread?.thread).toMatchObject({
      muted: true,
      folder: "archive",
      snoozedUntil: null,
    });
    await undoThreadAction(db, env, user.id, defined(undo));
    await expect(inView(user.id, "snoozed", a)).resolves.toMatchObject({
      muted: false,
      folder: "inbox",
      snoozedUntil: until,
    });
  });

  it("takes a label back off, or puts it back on, and lets a label deleted since go", async () => {
    const user = await mailbox("udo");
    const a = await deliver(user.email, { subject: "Receipts" });
    const kept = await createLabel(db, user.id, { name: "Kept" });
    const gone = await createLabel(db, user.id, { name: "Gone" });

    const on = await applyThreadAction(db, env, user.id, [a], {
      intent: "label",
      labelId: kept.id,
    });

    await undoThreadAction(db, env, user.id, defined(on.undo));
    const thread = await loadThread(db, env, user.id, a);
    expect(thread?.labels).toStrictEqual([]);
    await applyThreadAction(db, env, user.id, [a], {
      intent: "label",
      labelId: gone.id,
    });

    const off = await applyThreadAction(db, env, user.id, [a], {
      intent: "unlabel",
      labelId: gone.id,
    });

    await deleteLabel(db, user.id, gone.id);
    await expect(
      undoThreadAction(db, env, user.id, defined(off.undo))
    ).resolves.toBeTruthy();
    const thread2 = await loadThread(db, env, user.id, a);
    expect(thread2?.labels).toStrictEqual([]);
  });

  it("answers no undo for an action that changed nothing, and takes only the owner's", async () => {
    const user = await mailbox("uwe");
    const other = await mailbox("vic");
    const a = await deliver(user.email, { subject: "Mine" });

    const { undo: threadActionUndo } = await applyThreadAction(
      db,
      env,
      user.id,
      [a],
      { intent: "inbox" }
    );

    expect(threadActionUndo).toBeNull();

    const { undo } = await applyThreadAction(db, env, user.id, [a], {
      intent: "archive",
    });

    await expect(
      undoThreadAction(db, env, other.id, defined(undo))
    ).resolves.toBeFalsy();
    await expect(
      undoThreadAction(db, env, user.id, `${undo}x`)
    ).resolves.toBeFalsy();
    await expect(inView(user.id, "inbox", a)).resolves.toBeUndefined();
  });
});

describe("waking snoozed conversations", () => {
  it("wakes them by the clock, to the top of the inbox", async () => {
    const user = await mailbox("wim");
    const a = await deliver(user.email, { subject: "Later" });
    const now = new Date();
    await applyThreadAction(db, env, user.id, [a], {
      intent: "snooze",
      until: minutes(60, now).toISOString(),
    });
    await expect(wakeSnoozed(db, minutes(59, now), user.id)).resolves.toBe(0);
    const at = minutes(61, now);
    await expect(wakeSnoozed(db, at, user.id)).resolves.toBe(1);
    const threads = await listThreads(db, user.id, { folder: "inbox" });
    expect(threads[0]).toMatchObject({
      id: a,
      snoozedUntil: null,
      lastMessageAt: at.toISOString(),
    });
  });

  it("wakes every mailbox's from the cron, whether or not anyone opened their mail", async () => {
    const one = await mailbox("xan");
    const two = await mailbox("yva");
    const a = await deliver(one.email, { subject: "Due" });
    const b = await deliver(two.email, { subject: "Due too" });

    // Snoozed an hour ago until a minute ago.
    await Promise.all(
      (
        [
          [one, a],
          [two, b],
        ] as const
      ).map(([user, id]) =>
        applyThreadAction(
          db,
          env,
          user.id,
          [id],
          { intent: "snooze", until: minutes(-1).toISOString() },
          minutes(-60)
        )
      )
    );

    await expect(inView(one.id, "snoozed", a)).resolves.toBeDefined();
    await handleScheduled(env);
    await expect(inView(one.id, "inbox", a)).resolves.toMatchObject({
      snoozedUntil: null,
    });
    await expect(inView(two.id, "inbox", b)).resolves.toMatchObject({
      snoozedUntil: null,
    });
  });
});
