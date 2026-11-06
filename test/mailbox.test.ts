import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { ingestInboundEmail } from "~/lib/mail/ingest.server";
import {
  deleteThreadForever,
  folderCounts,
  listThreads,
  loadThread,
} from "~/lib/mail/mailbox.server";
import { applyThreadAction, markThreadRead } from "~/lib/mail/threads.server";

import { db, mail, mailbox } from "./fixtures";

describe("the mailbox", () => {
  let userId: string;
  let threadId: string;
  beforeAll(async () => {
    const user = await mailbox("eva", "Eva");
    userId = user.id;

    const r = await ingestInboundEmail(
      env,
      null,
      mail({
        subject: "Lunch plans",
        text: "Pizza on Friday?",
        to: [{ email: user.email, name: null }],
      }),
      user.email
    );

    if (r.status !== "stored") {
      throw new Error("not stored");
    }

    ({ threadId } = r);
  });

  it("lists, searches, stars, reads, moves and deletes", async () => {
    const threads = await listThreads(db, userId, { folder: "inbox" });

    const found = await listThreads(db, userId, {
      folder: "inbox",
      q: "pizza",
    });

    const missed = await listThreads(db, userId, {
      folder: "inbox",
      q: "sushi",
    });

    const { inboxUnread: unreadAtStart } = await folderCounts(db, userId);

    expect({
      listThreadsMap: threads.map((t) => t.id).includes(threadId),
      listThreadsMap2: found.map((t) => t.id),
      listThreads: missed,
      inboxUnread: unreadAtStart,
    }).toStrictEqual({
      listThreadsMap: true,
      listThreadsMap2: [threadId],
      listThreads: [],
      inboxUnread: 1,
    });

    await applyThreadAction(db, env, userId, [threadId], { intent: "star" });
    const starred = await listThreads(db, userId, { folder: "starred" });
    const loaded = await loadThread(db, env, userId, threadId);
    await markThreadRead(db, userId, threadId);
    const { inboxUnread } = await folderCounts(db, userId);

    expect({
      starred: starred.map((t) => t.id),
      firstMessage: loaded?.messages.at(0),
      inboxUnread,
    }).toMatchObject({
      starred: [threadId],
      firstMessage: {
        subject: "Lunch plans",
        read: false,
        direction: "inbound",
      },
      inboxUnread: 0,
    });

    await applyThreadAction(db, env, userId, [threadId], { intent: "archive" });
    const inbox = await listThreads(db, userId, { folder: "inbox" });
    const archive = await listThreads(db, userId, { folder: "archive" });

    // Deleting forever only works from the trash, and only for the owner.
    const foreverFromArchive = await deleteThreadForever(
      db,
      env,
      userId,
      threadId
    );

    await applyThreadAction(db, env, userId, [threadId], { intent: "trash" });

    const starredAfterTrash = await listThreads(db, userId, {
      folder: "starred",
    });

    const other = await mailbox("ivo", "Ivo");

    const foreverByOther = await deleteThreadForever(
      db,
      env,
      other.id,
      threadId
    );

    const loadedByOther = await loadThread(db, env, other.id, threadId);
    const foreverByOwner = await deleteThreadForever(db, env, userId, threadId);
    const loadedAfter = await loadThread(db, env, userId, threadId);

    expect({
      inboxHasThread: inbox.some((t) => t.id === threadId),
      archiveHasThread: archive.some((t) => t.id === threadId),
      foreverFromArchive: Boolean(foreverFromArchive),
      starredHasThread: starredAfterTrash.some((t) => t.id === threadId),
      foreverByOther: Boolean(foreverByOther),
      loadedByOther,
      foreverByOwner: Boolean(foreverByOwner),
      loadedAfter,
    }).toStrictEqual({
      inboxHasThread: false,
      archiveHasThread: true,
      foreverFromArchive: false,
      starredHasThread: false,
      foreverByOther: false,
      loadedByOther: null,
      foreverByOwner: true,
      loadedAfter: null,
    });
  });
});
