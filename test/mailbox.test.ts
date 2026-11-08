import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { addImageSender } from "~/lib/mail/images.server";
import { ingestInboundEmail } from "~/lib/mail/ingest.server";
import { createLabel } from "~/lib/mail/labels.server";
import {
  deleteThreadForever,
  folderCounts,
  listThreads,
  loadThread,
} from "~/lib/mail/mailbox.server";
import { listPage, openThread } from "~/lib/mail/reads.server";
import { saveDraft } from "~/lib/mail/send.server";
import { setSenderRule } from "~/lib/mail/spam.server";
import { applyThreadAction, markThreadRead } from "~/lib/mail/threads.server";

import { anyString, db, defined, mail, mailbox } from "./fixtures";

const minutes = (n: number, from = new Date()) =>
  new Date(from.getTime() + n * 60_000);

/** A message delivered to the address, answering its thread's id. */
const deliver = async (
  email: string,
  over: Parameters<typeof mail>[0] = {}
): Promise<string> => {
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

/** A forward from Outlook: its header is a div Outlook also writes above a reply's quote, so only the subject tells. */
const OUTLOOK_FORWARD =
  '<p>FYI</p><div id="divRplyFwdMsg">From: Jane<br>Subject: Plan</div><div>The plan itself</div>';

const FOLDED = '<details class="rivi-quote">';

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

describe("a page of a list", () => {
  it("lists a label's threads from the archive, and the inbox for a folder that does not exist", async () => {
    const user = await mailbox("lisa", "Lisa List");
    const a = await deliver(user.email, { subject: "Quarterly figures" });
    const label = await createLabel(db, user.id, { name: "Finance" });
    await applyThreadAction(db, env, user.id, [a], {
      intent: "label",
      labelId: label.id,
    });
    await applyThreadAction(db, env, user.id, [a], { intent: "archive" });

    const labelled = await listPage(db, env, user, {
      label: label.id,
      folder: "inbox",
    });

    const otherLabel = await listPage(db, env, user, {
      label: "lbl_not_theirs",
      folder: "archive",
    });

    const unknown = await listPage(db, env, user, { folder: "nowhere" });

    expect({
      labelled: {
        folder: labelled.folder,
        label: labelled.label,
        threads: labelled.threads,
      },
      otherLabel: [otherLabel.folder, otherLabel.label],
      unknown: [unknown.folder, unknown.total],
    }).toStrictEqual({
      labelled: {
        folder: "archive",
        label,
        threads: [
          {
            id: a,
            subject: "Quarterly figures",
            snippet: anyString(),
            people: "Jane Doe",
            count: 1,
            unread: true,
            starred: false,
            hasAttachments: false,
            lastMessageAt: anyString(),
            folder: "archive",
            snoozedUntil: null,
            muted: false,
            sent: false,
            labels: [label],
          },
        ],
      },
      otherLabel: ["archive", null],
      unknown: ["inbox", 0],
    });
  });

  it("clamps the page, takes a page size it offers, trims the search and prunes a few times a day", async () => {
    const user = await mailbox("paula", "Paula Pages");
    await deliver(user.email, { subject: "Pizza on Friday" });
    await env.KV.delete(`prune:${user.id}`);

    const asked = [null, "0", "-3", "2.7", "lots", "99999"];

    const pages = await Promise.all(
      asked.map((page) => listPage(db, env, user, { page }))
    );

    const sized = await Promise.all(
      [undefined, "25", 100, "30"].map((pageSize) =>
        listPage(db, env, user, { pageSize })
      )
    );

    const search = await listPage(db, env, user, { q: "  pizza  " });

    expect({
      pages: pages.map((p) => p.page),
      sizes: sized.map((p) => p.pageSize),
      search: [search.q, search.total],
      pruned: await env.KV.get(`prune:${user.id}`),
    }).toStrictEqual({
      pages: [1, 1, 1, 2, 1, 10_000],
      sizes: [50, 25, 100, 50],
      search: ["pizza", 1],
      pruned: "1",
    });
  });

  it("lists drafts under Drafts, each with the opening of its text", async () => {
    const user = await mailbox("dirk", "Dirk Drafts");
    await deliver(user.email, { subject: "Not a draft" });

    const id = await saveDraft(db, user.id, {
      mode: "new",
      from: user.email,
      to: [{ email: "ada@acme.com", name: "Ada" }],
      cc: [],
      bcc: [],
      subject: "Plans",
      text: `Hello\n\n   there,   ${"word ".repeat(40)}`,
    });

    const drafts = await listPage(db, env, user, { folder: "drafts" });
    const scheduled = await listPage(db, env, user, { folder: "scheduled" });

    expect({
      drafts: [drafts.total, drafts.threads, drafts.drafts],
      scheduled: [scheduled.total, scheduled.drafts],
    }).toStrictEqual({
      drafts: [
        1,
        [],
        [
          {
            id,
            to: "Ada",
            subject: "Plans",
            snippet: `Hello there, ${"word ".repeat(40)}`.slice(0, 120),
            updatedAt: anyString(),
            scheduledAt: null,
            sendError: null,
          },
        ],
      ],
      scheduled: [0, []],
    });
  });

  it("wakes a snoozed thread whose moment has come by now, to the top of the inbox", async () => {
    const user = await mailbox("sanne", "Sanne Snooze");
    const a = await deliver(user.email, { subject: "Later" });
    const now = new Date();
    await applyThreadAction(db, env, user.id, [a], {
      intent: "snooze",
      until: minutes(60, now).toISOString(),
    });

    const early = await listPage(db, env, user, {}, minutes(59, now));
    const at = minutes(61, now);
    const due = await listPage(db, env, user, {}, at);

    expect({
      early: early.threads.map((t) => t.id),
      due: due.threads.map((t) => [t.id, t.snoozedUntil, t.lastMessageAt]),
    }).toStrictEqual({
      early: [],
      due: [[a, null, at.toISOString()]],
    });
  });
});

describe("a thread opened", () => {
  it("reads it, unless asked not to, and only for its owner", async () => {
    const user = await mailbox("otto.open", "Otto Open");
    const other = await mailbox("nosy", "Nosy Neighbour");
    const a = await deliver(user.email, { subject: "Read me" });

    const kept = defined(
      await openThread(db, env, user.id, a, { markRead: false })
    );

    const { inboxUnread: unreadAfterKept } = await folderCounts(db, user.id);
    const opened = defined(await openThread(db, env, user.id, a));
    const { inboxUnread: unreadAfterOpened } = await folderCounts(db, user.id);
    const again = defined(await openThread(db, env, user.id, a));

    expect({
      kept: [kept.wasUnread, kept.thread.unreadCount, unreadAfterKept],
      opened: [
        opened.wasUnread,
        opened.thread.unreadCount,
        opened.messages.map((m) => m.read),
        unreadAfterOpened,
      ],
      again: [again.wasUnread, again.messages.map((m) => m.read)],
      byOther: await openThread(db, env, other.id, a),
    }).toStrictEqual({
      kept: [true, 1, 1],
      // The messages say what was unread when it opened, so the page can open those.
      opened: [true, 0, [false], 0],
      again: [false, [true]],
      byOther: null,
    });
  });

  it("keeps a forward's quote in view and folds a reply's, with inline images on their links and the rest as files", async () => {
    const user = await mailbox("fenna", "Fenna Forward");

    const forward = await deliver(user.email, {
      subject: "FW: Plan",
      html: OUTLOOK_FORWARD,
    });

    const reply = await deliver(user.email, {
      subject: "RE: Roadmap",
      html: OUTLOOK_FORWARD,
    });

    const withFiles = await deliver(user.email, {
      subject: "Logo",
      html: '<p>Our logo:</p><img src="cid:logo">',
      attachments: [
        {
          filename: "logo.png",
          mimeType: "image/png",
          content: new Uint8Array([1, 2, 3]),
          contentId: "logo",
          inline: true,
        },
        {
          filename: "report.pdf",
          mimeType: "application/pdf",
          content: new Uint8Array([4, 5, 6]),
          contentId: null,
          inline: false,
        },
      ],
    });

    const first = async (threadId: string) => {
      const opened = await openThread(db, env, user.id, threadId);

      return defined(opened?.messages[0]);
    };

    const forwarded = await first(forward);
    const replied = await first(reply);
    const files = await first(withFiles);
    const logo = defined(files.attachments.find((f) => f.contentId === "logo"));

    expect({
      forward: forwarded.html?.includes(FOLDED),
      reply: replied.html?.includes(FOLDED),
      logo: files.html?.includes(`src="${logo.url.replaceAll("&", "&amp;")}"`),
      files: files.files.map((f) => f.filename),
      attachments: files.attachments.length,
    }).toStrictEqual({
      forward: false,
      reply: true,
      logo: true,
      files: ["report.pdf"],
      attachments: 2,
    });
  });

  it("loads images only from a sender the owner always loads, never in Spam, and names each sender's rule", async () => {
    const user = await mailbox("ilse", "Ilse Images");
    const html = '<p>Sale</p><img src="https://shop.example/banner.png">';

    const fromShop = await deliver(user.email, {
      subject: "Deals",
      from: { email: "deals@shop.example", name: "Shop" },
      html,
    });

    const fromStranger = await deliver(user.email, {
      subject: "Hello",
      from: { email: "someone@else.example", name: null },
      html,
    });

    await addImageSender(db, user.id, "shop.example");
    await setSenderRule(db, user.id, "else.example", "allow");

    const shop = defined(await openThread(db, env, user.id, fromShop));
    const stranger = defined(await openThread(db, env, user.id, fromStranger));

    await applyThreadAction(db, env, user.id, [fromShop], { intent: "spam" });
    await setSenderRule(db, user.id, "deals@shop.example", "block");
    const inSpam = defined(await openThread(db, env, user.id, fromShop));

    expect({
      shop: [shop.messages[0]?.remoteImages, shop.messages[0]?.loadImages],
      stranger: stranger.messages[0]?.loadImages,
      inSpam: inSpam.messages[0]?.loadImages,
      rules: [shop.senderRules, stranger.senderRules, inSpam.senderRules],
    }).toStrictEqual({
      shop: [true, true],
      stranger: false,
      inSpam: false,
      rules: [
        { "deals@shop.example": null },
        {
          "someone@else.example": { sender: "@else.example", verdict: "allow" },
        },
        {
          "deals@shop.example": {
            sender: "deals@shop.example",
            verdict: "block",
          },
        },
      ],
    });
  });
});
