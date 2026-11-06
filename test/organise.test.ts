import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { contacts, threads } from "~/db/schema";
import { searchContacts, touchContacts } from "~/lib/mail/contacts.server";
import { fileMessage } from "~/lib/mail/filing.server";
import {
  filterOutcome,
  saveFilter,
  moveFilter,
  deleteFilter,
  listFilters,
  FilterError,
} from "~/lib/mail/filters.server";
import { ingestInboundEmail } from "~/lib/mail/ingest.server";
import {
  createLabel,
  deleteLabel,
  listLabels,
  updateLabel,
  LabelError,
} from "~/lib/mail/labels.server";
import {
  countThreads,
  deleteThreadForever,
  emptyFolder,
  folderCounts,
  labelsForThreads,
  listThreads,
  pruneExpired,
} from "~/lib/mail/mailbox.server";
import { sendMail } from "~/lib/mail/send.server";
import {
  applyThreadAction,
  markAllRead,
  undoThreadAction,
  wakeSnoozed,
} from "~/lib/mail/threads.server";

import {
  db,
  defined,
  mail,
  mailbox,
  recordingEmail,
  rejectionIncludes,
  sorted,
} from "./fixtures";

const domain = env.MAIL_DOMAIN;

const deliver = async (
  userEmail: string,
  over: Parameters<typeof mail>[0] = {}
) => {
  const r = await ingestInboundEmail(
    env,
    null,
    mail({ to: [{ email: userEmail, name: null }], ...over }),
    userEmail
  );

  if (r.status !== "stored") {
    throw new Error(`not stored: ${r.status}`);
  }

  return r.threadId;
};

const thread = (id: string) =>
  db.query.threads.findFirst({ where: eq(threads.id, id) });

describe("organising mail", () => {
  let userId: string;
  let email: string;
  beforeAll(async () => {
    const user = await mailbox("olga", "Olga Organiser");
    ({ email, id: userId } = user);
  });

  it("moves threads together and undoes the move", async () => {
    const observed: unknown[] = [];

    const a = await deliver(email, { subject: "Org A" });
    const b = await deliver(email, { subject: "Org B" });

    const { undo, count } = await applyThreadAction(
      db,
      env,
      userId,
      [a, b, "th_not_mine"],
      {
        intent: "archive",
      }
    );

    const foundThread = await thread(a);
    observed.push(
      { count, folder: foundThread?.folder },
      Boolean(await undoThreadAction(db, env, userId, defined(undo)))
    );
    const foundThread2 = await thread(a);
    const foundThread3 = await thread(b);
    observed.push({
      folder: foundThread2?.folder,
      folder2: foundThread3?.folder,
    });

    await applyThreadAction(db, env, userId, [a], { intent: "trash" });
    const foundThread4 = await thread(a);
    observed.push(Boolean(foundThread4?.trashedAt));
    // All mail holds the inbox and the archive, never the trash.
    const listedThreads = await listThreads(db, userId, { folder: "archive" });
    observed.push(listedThreads.map((t) => t.id).includes(a));
    const listedThreads2 = await listThreads(db, userId, { folder: "trash" });
    observed.push(listedThreads2.map((t) => t.id).includes(a));

    expect(observed).toStrictEqual([
      // { count, folder: foundThread?.folder }
      {
        count: 2,
        folder: "archive",
      },
      // Boolean(await undoThreadAction(db, env, userId, defined(undo)))
      true,
      // { folder: foundThread2?.folder, folder2: foundThread3?.folder, }
      { folder: "inbox", folder2: "inbox" },
      // Boolean(foundThread4?.trashedAt)
      true,
      // listedThreads.map((t) => t.id).includes(a)
      false,
      // listedThreads2.map((t) => t.id).includes(a)
      true,
    ]);
  });

  it("reads and unreads in bulk and counts what each view holds", async () => {
    const a = await deliver(email, { subject: "Read A" });
    const b = await deliver(email, { subject: "Read B" });
    await applyThreadAction(db, env, userId, [a, b], { intent: "read" });
    const foundThread = await thread(a);
    expect(foundThread?.unreadCount).toBe(0);
    await applyThreadAction(db, env, userId, [a], { intent: "unread" });
    const foundThread2 = await thread(a);
    expect(foundThread2?.unreadCount).toBe(1);
    const counts = await folderCounts(db, userId);
    expect(counts.inboxUnread).toBeGreaterThan(0);
    await expect(
      markAllRead(db, userId, { folder: "inbox" })
    ).resolves.toBeGreaterThan(0);
    const { inboxUnread } = await folderCounts(db, userId);
    expect(inboxUnread).toBe(0);
  });

  it("marks spam, keeps it out of every view but its own, and deletes it for good from there", async () => {
    const a = await deliver(email, { subject: "Spam A" });
    await applyThreadAction(db, env, userId, [a], { intent: "spam" });
    const foundThread = await thread(a);
    const listedThreads = await listThreads(db, userId, { folder: "spam" });
    expect({
      folder: foundThread?.folder,
      listThreadsMap: listedThreads.map((t) => t.id).includes(a),
    }).toStrictEqual({ folder: "spam", listThreadsMap: true });
    const listedThreads2 = await listThreads(db, userId, { folder: "archive" });
    expect(listedThreads2.map((t) => t.id)).not.toContain(a);
    const { spamUnread } = await folderCounts(db, userId);
    expect(spamUnread).toBeGreaterThan(0);
    await expect(deleteThreadForever(db, env, userId, a)).resolves.toBeTruthy();
    await expect(thread(a)).resolves.toBeUndefined();
  });

  it("snoozes a thread out of the inbox until its time, and wakes it to the top", async () => {
    const observed: unknown[] = [];

    const a = await deliver(email, { subject: "Snooze A" });
    const now = new Date();
    const soon = new Date(now.getTime() + 3_600_000).toISOString();
    observed.push(
      await rejectionIncludes(
        applyThreadAction(db, env, userId, [a], {
          intent: "snooze",
          until: "yesterday",
        }),
        "Choose when"
      )
    );

    const { undo } = await applyThreadAction(db, env, userId, [a], {
      intent: "snooze",
      until: soon,
    });

    observed.push(Boolean(undo));
    const listedThreads = await listThreads(db, userId, { folder: "inbox" });
    observed.push(listedThreads.map((t) => t.id).includes(a));
    const listedThreads2 = await listThreads(db, userId, { folder: "snoozed" });
    const snoozedCounts = await folderCounts(db, userId);

    observed.push(
      {
        listThreadsMap: listedThreads2.map((t) => t.id).includes(a),
        snoozed: snoozedCounts.snoozed,
        wakeSnoozed: await wakeSnoozed(db, now, userId),
      },
      // An hour and a second later.
      await wakeSnoozed(db, new Date(now.getTime() + 3_601_000), userId)
    );
    const woken = await thread(a);
    const [firstInInbox] = await listThreads(db, userId, { folder: "inbox" });

    observed.push({
      snoozedUntil: woken?.snoozedUntil,
      folder: woken?.folder,
      id: firstInInbox?.id,
    });
    // A reply from outside while snoozed brings the thread back as well.
    await applyThreadAction(db, env, userId, [a], {
      intent: "snooze",
      until: soon,
    });

    const again = await ingestInboundEmail(
      env,
      null,
      mail({
        subject: "Re: Snooze A",
        inReplyTo: "<none>",
        references: [],
        to: [{ email, name: null }],
      }),
      email
    );

    const brought = await thread(a);

    observed.push({
      value: again.status === "stored" && again.threadId,
      snoozedUntil: brought?.snoozedUntil,
    });

    expect(observed).toStrictEqual([
      // (await rejection(applyThreadAction(db, env, userId, [a], { intent: "snooze", until: "ye...
      true,
      // Boolean(undo)
      true,
      // listedThreads.map((t) => t.id).includes(a)
      false,
      // { listThreadsMap: listedThreads2.map((t) => t.id).includes(a), snoozed: (await folderCo...
      { listThreadsMap: true, snoozed: 1, wakeSnoozed: 0 },
      // wakeSnoozed(db, new Date(now.getTime() + 3_601_000), userId)
      1,
      // { snoozedUntil: woken?.snoozedUntil, folder: woken?.folder, id: (await listThreads(db, ...
      { snoozedUntil: null, folder: "inbox", id: a },
      // { value: again.status === "stored" && again.threadId, snoozedUntil: (await thread(a))?....
      { value: a, snoozedUntil: null },
    ]);
  });

  it("mutes a thread, which skips the inbox when replies come", async () => {
    const a = await deliver(email, {
      subject: "Mute A",
      messageId: "<mute1@acme.com>",
    });

    await applyThreadAction(db, env, userId, [a], { intent: "mute" });
    await expect(thread(a)).resolves.toMatchObject({
      muted: true,
      folder: "archive",
    });

    const reply = await ingestInboundEmail(
      env,
      null,
      mail({
        subject: "Re: Mute A",
        references: ["<mute1@acme.com>"],
        to: [{ email, name: null }],
      }),
      email
    );

    expect(reply.status === "stored" && reply.threadId).toBe(a);
    const foundThread = await thread(a);
    expect(foundThread?.folder).toBe("archive");
    await applyThreadAction(db, env, userId, [a], { intent: "unmute" });
    await expect(thread(a)).resolves.toMatchObject({ muted: false });
  });

  it("labels threads, lists a label's threads, counts its unread ones and lets a label go", async () => {
    const observed: unknown[] = [];

    const finance = await createLabel(db, userId, {
      name: "Finance",
      color: "green",
    });

    await expect(
      createLabel(db, userId, { name: "finance" })
    ).rejects.toBeInstanceOf(LabelError);
    observed.push(
      await rejectionIncludes(
        createLabel(db, userId, { name: "  " }),
        "needs a name"
      )
    );
    const a = await deliver(email, { subject: "Label A" });
    const b = await deliver(email, { subject: "Label B" });

    const { undo } = await applyThreadAction(db, env, userId, [a, b], {
      intent: "label",
      labelId: finance.id,
    });

    observed.push(Boolean(undo));

    // Labelling again adds nothing and undoes nothing.
    const { undo: threadActionUndo } = await applyThreadAction(
      db,
      env,
      userId,
      [a],
      {
        intent: "label",
        labelId: finance.id,
      }
    );

    const labels = await labelsForThreads(db, userId, [a]);

    const withFinance = await listThreads(db, userId, {
      folder: "inbox",
      label: finance.id,
    });

    const financeCounts = await folderCounts(db, userId);

    const searchedFinance = await listThreads(db, userId, {
      folder: "inbox",
      q: "label:finance",
    });

    observed.push({
      undo: threadActionUndo,
      labelsForThreadsGet: labels.get(a),
      listThreadsMapSort: sorted(withFinance.map((t) => t.id)),
      labels: financeCounts.labels[finance.id],
      listThreadsMap: searchedFinance.map((t) => t.id).includes(a),
    });
    await applyThreadAction(db, env, userId, [b], {
      intent: "unlabel",
      labelId: finance.id,
    });
    const labels2 = await labelsForThreads(db, userId, [b]);
    observed.push(labels2.get(b));
    await updateLabel(db, userId, finance.id, {
      name: "Money",
      color: "amber",
    });
    await expect(listLabels(db, userId)).resolves.toContainEqual({
      id: finance.id,
      name: "Money",
      color: "amber",
    });
    observed.push(
      await rejectionIncludes(
        applyThreadAction(db, env, userId, [a], {
          intent: "label",
          labelId: "lb_nope",
        }),
        "no longer exists"
      )
    );
    await deleteLabel(db, userId, finance.id);
    const labels3 = await labelsForThreads(db, userId, [a]);
    observed.push(labels3.get(a));

    expect(observed).toStrictEqual([
      // (await rejection(createLabel(db, userId, { name: " " })))?.message.includes("needs a na...
      true,
      // Boolean(undo)
      true,
      // { undo: threadActionUndo, labelsForThreadsGet: labels.get(a), listThreadsMapSort: ( awa...
      {
        undo: null,
        labelsForThreadsGet: [finance],
        listThreadsMapSort: sorted([a, b]),
        labels: 2,
        listThreadsMap: true,
      },
      // labels2.get(b)
      undefined,
      // (await rejection(applyThreadAction(db, env, userId, [a], { intent: "label", labelId: "l...
      true,
      // labels3.get(a)
      undefined,
    ]);
  });

  it("searches with operators over all mail, and inside the trash from there", async () => {
    const observed: unknown[] = [];

    const a = await deliver(email, {
      subject: "Quarterly numbers",
      from: { email: "cfo@initech.net", name: "Pat CFO" },
      text: "The spreadsheet is attached",
      attachments: [
        {
          filename: "q.xlsx",
          mimeType: "application/octet-stream",
          content: new Uint8Array([1]),
          contentId: null,
          inline: false,
        },
      ],
    });

    await applyThreadAction(db, env, userId, [a], { intent: "archive" });

    const ids = async (q: string, folder: "inbox" | "trash" = "inbox") => {
      const listedThreads = await listThreads(db, userId, { folder, q });

      return listedThreads.map((t) => t.id);
    };

    const got18 = await ids("from:initech");
    observed.push(got18.includes(a));
    const got19 = await ids("from:Pat");
    observed.push(got19.includes(a));
    const got20 = await ids("-from:initech");
    observed.push(got20.includes(a));
    const got21 = await ids("subject:quarterly");
    observed.push(got21.includes(a));
    const got22 = await ids("subject:quarterly has:attachment is:unread");
    observed.push(got22.includes(a));
    const got23 = await ids("subject:quarterly is:read");
    observed.push(got23.includes(a));
    const got24 = await ids("spreadsheet");
    observed.push(got24.includes(a));
    const got25 = await ids("quarterly in:inbox");
    observed.push(got25.includes(a));
    const got26 = await ids("quarterly after:2000-01-01 before:2999-01-01");
    observed.push(got26.includes(a));
    const got27 = await ids("quarterly before:2000-01-01");
    observed.push(got27.includes(a));
    const got28 = await ids(`to:${email}`);
    observed.push(got28.includes(a));
    await applyThreadAction(db, env, userId, [a], { intent: "trash" });
    const got29 = await ids("quarterly");
    observed.push(got29.includes(a));
    const got30 = await ids("quarterly", "trash");
    observed.push(got30.includes(a));
    const got31 = await ids("quarterly in:anywhere");
    observed.push(
      got31.includes(a),
      await countThreads(db, userId, { folder: "trash", q: "quarterly" })
    );

    expect(observed).toStrictEqual([
      // got18.includes(a)
      true,
      // got19.includes(a)
      true,
      // got20.includes(a)
      false,
      // got21.includes(a)
      true,
      // got22.includes(a)
      true,
      // got23.includes(a)
      false,
      // got24.includes(a)
      true,
      // got25.includes(a)
      false,
      // got26.includes(a)
      true,
      // got27.includes(a)
      false,
      // got28.includes(a)
      true,
      // got29.includes(a)
      false,
      // got30.includes(a)
      true,
      // got31.includes(a)
      true,
      // countThreads(db, userId, { folder: "trash", q: "quarterly" })
      1,
    ]);
  });

  it("pages a view and counts it", async () => {
    const other = await mailbox("page", "Pager");

    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- inbound mail reaches a mailbox one message at a time, and the pages below are cut from the order it arrived in
      await deliver(other.email, { subject: `Page ${i}` });
    }

    await expect(countThreads(db, other.id, { folder: "inbox" })).resolves.toBe(
      5
    );

    const first = await listThreads(db, other.id, {
      folder: "inbox",
      limit: 2,
      offset: 0,
    });

    const second = await listThreads(db, other.id, {
      folder: "inbox",
      limit: 2,
      offset: 2,
    });

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(new Set([...first, ...second].map((t) => t.id)).size).toBe(4);
  });

  it("acts on a full page of 100 conversations, though D1 binds 100 values a query", async () => {
    const observed: unknown[] = [];

    const other = await mailbox("fullpage", "Full Page");

    const ids = await Promise.all(
      Array.from({ length: 100 }, async (_, i) => {
        const filed = await fileMessage(env, db, other, {
          policy: "history",
          mail: mail({
            messageId: `<fullpage${i}@acme.com>`,
            subject: `Bulk ${i}`,
          }),
          raw: null,
          place: () => ({ folder: "inbox" }),
        });

        return filed.threadId;
      })
    );

    const bulk = await createLabel(db, other.id, { name: "Bulk" });

    const folders = async () => {
      const results = await Promise.all(ids.map((id) => thread(id)));

      return new Set(results.map((t) => t?.folder));
    };

    for (const intent of ["read", "unread", "star"] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each intent acts on the hundred conversations as the one before left them
      const { count } = await applyThreadAction(db, env, other.id, ids, {
        intent,
      });

      expect(count).toBe(100);
    }

    const muted = await applyThreadAction(db, env, other.id, ids, {
      intent: "mute",
    });

    observed.push(await folders());
    await undoThreadAction(db, env, other.id, defined(muted.undo));
    observed.push(await folders());
    await applyThreadAction(db, env, other.id, ids, {
      intent: "label",
      labelId: bulk.id,
    });
    const labels = await labelsForThreads(db, other.id, ids);
    observed.push(labels.size);

    const unlabelled = await applyThreadAction(db, env, other.id, ids, {
      intent: "unlabel",
      labelId: bulk.id,
    });

    const labels2 = await labelsForThreads(db, other.id, ids);
    observed.push(labels2.size);
    await undoThreadAction(db, env, other.id, defined(unlabelled.undo));
    const labels3 = await labelsForThreads(db, other.id, ids);
    observed.push(labels3.size);

    const archived = await applyThreadAction(db, env, other.id, ids, {
      intent: "archive",
    });

    observed.push(await folders());
    await undoThreadAction(db, env, other.id, defined(archived.undo));
    observed.push({
      folders: await folders(),
      markAllRead: await markAllRead(db, other.id, { folder: "inbox" }),
    });

    await applyThreadAction(db, env, other.id, ids, { intent: "spam" });
    observed.push(await folders());
    await applyThreadAction(db, env, other.id, ids, { intent: "trash" });

    const { count: threadActionCount } = await applyThreadAction(
      db,
      env,
      other.id,
      ids,
      { intent: "delete" }
    );

    observed.push({
      count: threadActionCount,
      countThreads: await countThreads(db, other.id, { folder: "trash" }),
    });

    expect(observed).toStrictEqual([
      // folders()
      new Set(["archive"]),
      // folders()
      new Set(["inbox"]),
      // labels.size
      100,
      // labels2.size
      0,
      // labels3.size
      100,
      // folders()
      new Set(["archive"]),
      // { folders: await folders(), markAllRead: await markAllRead(db, other.id, { folder: "inb...
      { folders: new Set(["inbox"]), markAllRead: 100 },
      // folders()
      new Set(["spam"]),
      // { count: threadActionCount, countThreads: await countThreads(db, other.id, { folder: "t...
      { count: 100, countThreads: 0 },
    ]);
  });

  it("empties the trash and prunes what expired in it", async () => {
    const other = await mailbox("prune", "Pruner");
    const old = await deliver(other.email, { subject: "Old junk" });
    const fresh = await deliver(other.email, { subject: "Fresh junk" });
    await applyThreadAction(
      db,
      env,
      other.id,
      [old],
      { intent: "trash" },
      new Date(Date.now() - 31 * 86_400_000)
    );
    await applyThreadAction(db, env, other.id, [fresh], { intent: "trash" });
    await expect(pruneExpired(db, env, other.id)).resolves.toBe(1);
    await expect(thread(old)).resolves.toBeUndefined();
    await expect(thread(fresh)).resolves.toBeDefined();
    await expect(emptyFolder(db, env, other.id, "trash")).resolves.toBe(1);
    await expect(countThreads(db, other.id, { folder: "trash" })).resolves.toBe(
      0
    );
  });
});

describe("filters on arriving mail", () => {
  it("runs every matching rule and puts the outcome on the thread", async () => {
    const observed: unknown[] = [];

    const user = await mailbox("flo", "Flo Filter");

    const label = await createLabel(db, user.id, {
      name: "Bills",
      color: "red",
    });

    await expect(
      saveFilter(db, user.id, { conditions: {}, actions: { star: true } })
    ).rejects.toBeInstanceOf(FilterError);
    observed.push(
      await rejectionIncludes(
        saveFilter(db, user.id, { conditions: { from: "x" }, actions: {} }),
        "what the filter does"
      ),
      await rejectionIncludes(
        saveFilter(db, user.id, {
          conditions: { from: "x" },
          actions: { labelId: "lb_nope" },
        }),
        "label no longer exists"
      )
    );

    const f1 = await saveFilter(db, user.id, {
      conditions: { from: "billing@" },
      actions: { skipInbox: true, markRead: true, labelId: label.id },
    });

    const f2 = await saveFilter(db, user.id, {
      conditions: { subject: "urgent" },
      actions: { star: true },
    });

    const filters = await listFilters(db, user.id);
    observed.push(filters.map((f) => f.id));
    await moveFilter(db, user.id, f2, "up");
    const filters2 = await listFilters(db, user.id);
    observed.push(filters2.map((f) => f.id));

    const outcome = await filterOutcome(db, user.id, {
      from: { email: "billing@acme.com", name: null },
      to: [],
      cc: [],
      subject: "URGENT invoice",
      text: "",
      hasAttachment: false,
    });

    expect(outcome).toMatchObject({
      skipInbox: true,
      markRead: true,
      star: true,
      labelIds: [label.id],
      matched: 2,
    });

    const id = await deliver(user.email, {
      subject: "Urgent invoice",
      from: { email: "billing@acme.com", name: "Acme" },
    });

    const t = await thread(id);
    expect(t).toMatchObject({
      folder: "archive",
      starred: true,
      unreadCount: 0,
    });
    const labels = await labelsForThreads(db, user.id, [id]);
    observed.push(labels.get(id)?.map((l) => l.id));

    // A reply to that thread stays out of the inbox as the rule says.
    const reply = await deliver(user.email, {
      subject: "Re: Urgent invoice",
      from: { email: "billing@acme.com", name: "Acme" },
    });

    const foundThread = await thread(id);
    observed.push({ reply, folder: foundThread?.folder });

    // The label gone, the filter still runs and the mail still arrives, without it.
    await deleteLabel(db, user.id, label.id);

    const orphan = await deliver(user.email, {
      subject: "Urgent payment",
      from: { email: "billing@acme.com", name: "Acme" },
    });

    const labels2 = await labelsForThreads(db, user.id, [orphan]);
    const orphaned = await thread(orphan);

    observed.push({
      labelsForThreadsGet: labels2.get(orphan),
      starred: orphaned?.starred,
    });
    await saveFilter(db, user.id, {
      id: f1,
      conditions: { from: "spammer@" },
      actions: { spam: true },
    });

    const junk = await deliver(user.email, {
      subject: "Buy now",
      from: { email: "spammer@x.io", name: null },
    });

    await expect(thread(junk)).resolves.toMatchObject({ folder: "spam" });
    const foundThread2 = await thread(junk);
    observed.push(Boolean(foundThread2?.trashedAt));
    await deleteFilter(db, user.id, f1);
    await deleteFilter(db, user.id, f2);
    observed.push(await listFilters(db, user.id));

    expect(observed).toStrictEqual([
      // (await rejection(saveFilter(db, user.id, { conditions: { from: "x" }, actions: {} })))?...
      true,
      // (await rejection(saveFilter(db, user.id, { conditions: { from: "x" }, actions: { labelI...
      true,
      // filters.map((f) => f.id)
      [f1, f2],
      // filters2.map((f) => f.id)
      [f2, f1],
      // labels.get(id)?.map((l) => l.id)
      [label.id],
      // { reply, folder: foundThread?.folder }
      {
        reply: id,
        folder: "archive",
      },
      // { labelsForThreadsGet: labels2.get(orphan), starred: (await thread(orphan))?.starred, }
      { labelsForThreadsGet: undefined, starred: true },
      // Boolean(foundThread2?.trashedAt)
      true,
      // listFilters(db, user.id)
      [],
    ]);
  });
});

describe("the contacts", () => {
  it("remembers who the person wrote to and heard from, and suggests them", async () => {
    const user = await mailbox("cora", "Cora Contact");
    await deliver(user.email, {
      from: { email: "zed@acme.com", name: "Zed Zane" },
      cc: [{ email: "team@acme.com", name: null }],
    });
    const { env: testEnv } = recordingEmail();
    await sendMail(testEnv, db, user, {
      from: user.email,
      to: [{ email: "zed@acme.com", name: null }],
      cc: [{ email: "noreply@acme.com", name: null }],
      bcc: [],
      subject: "Hi",
      text: "Hi",
      files: [],
    });

    const zed = await db.query.contacts.findFirst({
      where: and(
        eq(contacts.userId, user.id),
        eq(contacts.email, "zed@acme.com")
      ),
    });

    expect(zed).toMatchObject({ name: "Zed Zane", timesUsed: 2 });
    const listedContacts = await searchContacts(db, user.id, "ze");
    expect(listedContacts.map((a) => a.email)).toStrictEqual(["zed@acme.com"]);
    const listedContacts2 = await searchContacts(db, user.id, "acme");
    expect(listedContacts2.map((a) => a.email)).toStrictEqual([
      "zed@acme.com",
      "team@acme.com",
    ]);
    // The owner's own addresses and the no-reply kind are never suggested.
    await touchContacts(
      db,
      user.id,
      [{ email: user.email, name: null }],
      new Set([user.email])
    );
    const listedContacts3 = await searchContacts(db, user.id, domain);
    expect(listedContacts3.map((a) => a.email)).not.toContain(user.email);
  });
});
