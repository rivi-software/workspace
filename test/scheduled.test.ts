import { env } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { driveNodes, spamTokens, threads, users } from "~/db/schema";
import {
  createFolder,
  finishUpload,
  startUpload,
  trashNodes,
} from "~/lib/drive/drive.server";
import { ingestInboundEmail } from "~/lib/mail/ingest.server";
import { TOTAL_TOKEN } from "~/lib/mail/spam";
import { pruneSpamTokens, trainTokens } from "~/lib/mail/spam.server";
import { applyThreadAction } from "~/lib/mail/threads.server";

import { handleScheduled } from "../workers/scheduled";
import { db, defined, mail, mailbox } from "./fixtures";
import { stubEnv } from "./stub-env";

const MINUTE = 60_000;
const DAY = 86_400_000;

const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

/** Midnight, UTC, of the day `ms` falls in: the cron's first minute that day. */
const dayOf = (ms: number) => ms - (ms % DAY);

/**
 * What a mailbox's spam filter learnt from three messages: "studio" came up in two of them, "airdrop" and "promo" in
 * one each, and "wallet" in a third that was taken back (an undo), so it counts nowhere.
 */
const learnWords = async (userId: string) => {
  await trainTokens(db, userId, ["studio", "airdrop"], { spam: 1, ham: 0 });
  await trainTokens(db, userId, ["studio", "promo"], { spam: 1, ham: 0 });
  await trainTokens(db, userId, ["wallet"], { spam: 1, ham: 0 });
  await trainTokens(db, userId, ["wallet"], { spam: -1, ham: 0 });
};

/** The words a mailbox's spam filter keeps, in order. */
const wordsOf = async (userId: string) => {
  const rows = await db
    .select({ token: spamTokens.token })
    .from(spamTokens)
    .where(eq(spamTokens.userId, userId))
    .orderBy(asc(spamTokens.token));

  return rows.map((w) => w.token);
};

const getNode = async (id: string) =>
  (await db.query.driveNodes.findFirst({ where: eq(driveNodes.id, id) })) ??
  null;

const getThread = async (id: string) =>
  (await db.query.threads.findFirst({ where: eq(threads.id, id) })) ?? null;

/** Whether a node's row is still there. */
const nodeKept = async (id: string) => (await getNode(id)) !== null;

/** The folder a conversation is in, or null once it is gone for good. */
const folderOf = async (id: string) => {
  const thread = await getThread(id);

  return thread?.folder ?? null;
};

const putFile = async (
  userId: string,
  parentId: string | null,
  name: string
) => {
  const bytes = new TextEncoder().encode(name);

  const { node } = await startUpload(db, env, userId, {
    parentId,
    name,
    size: bytes.byteLength,
    multipart: false,
  });

  await env.DRIVE.put(defined(node.r2Key), bytes);

  return finishUpload(env, db, userId, node.id);
};

/** In the trash since `days` ago, as `trashNodes` would have left it then. */
const trashedSince = async (userId: string, id: string, days: number) => {
  await trashNodes(db, userId, [id]);
  await db
    .update(driveNodes)
    .set({ trashedAt: daysAgo(days).toISOString() })
    .where(eq(driveNodes.id, id));
};

const deliver = async (email: string, subject: string) => {
  const r = await ingestInboundEmail(
    env,
    null,
    mail({ to: [{ email, name: null }], subject }),
    email
  );

  if (r.status !== "stored") {
    throw new Error(`not stored: ${r.status}`);
  }

  return r.threadId;
};

/** A conversation moved to the trash or Spam `days` ago. */
const junkSince = async (
  userId: string,
  id: string,
  intent: "trash" | "spam",
  days: number
) => {
  await applyThreadAction(db, env, userId, [id], { intent }, daysAgo(days));
};

describe("the cron's housekeeping", () => {
  it("prunes every drive and every mailbox, whether or not anyone opened Drive or Mail", async () => {
    const ana = await mailbox("cron-ana", "Ana");
    const bo = await mailbox("cron-bo", "Bo");

    // Ana's old file and Bo's old folder, with a file in it, went to the trash 31 days ago; Ana's other file today.
    const oldFile = await putFile(ana.id, null, "old.txt");
    const freshFile = await putFile(ana.id, null, "fresh.txt");
    const folder = await createFolder(db, bo.id, null, "Archive");
    const inner = await putFile(bo.id, folder.id, "inner.txt");
    await trashedSince(ana.id, oldFile.id, 31);
    await trashedSince(ana.id, freshFile.id, 0);
    await trashedSince(bo.id, folder.id, 31);

    // Bo started an upload 25 hours ago and never finished it.
    const { node: stale } = await startUpload(db, env, bo.id, {
      parentId: null,
      name: "stale.bin",
      size: 10,
      multipart: true,
    });

    await db
      .update(driveNodes)
      .set({ createdAt: new Date(Date.now() - 25 * 3_600_000).toISOString() })
      .where(eq(driveNodes.id, stale.id));

    // Ana's conversation went to the trash 31 days ago, Bo's to Spam; Ana's other one to the trash today.
    const oldTrash = await deliver(ana.email, "Old trash");
    const freshTrash = await deliver(ana.email, "Fresh trash");
    const oldSpam = await deliver(bo.email, "Old spam");
    await junkSince(ana.id, oldTrash, "trash", 31);
    await junkSince(ana.id, freshTrash, "trash", 0);
    await junkSince(bo.id, oldSpam, "spam", 31);

    await handleScheduled(env);

    expect({
      oldFile: await getNode(oldFile.id),
      oldFileObject: await env.DRIVE.head(defined(oldFile.r2Key)),
      folder: await getNode(folder.id),
      inner: await getNode(inner.id),
      innerObject: await env.DRIVE.head(defined(inner.r2Key)),
      stale: await getNode(stale.id),
      freshFile: await nodeKept(freshFile.id),
      oldTrash: await getThread(oldTrash),
      oldSpam: await getThread(oldSpam),
      freshTrash: await folderOf(freshTrash),
    }).toStrictEqual({
      oldFile: null,
      oldFileObject: null,
      folder: null,
      inner: null,
      innerObject: null,
      stale: null,
      freshFile: true,
      oldTrash: null,
      oldSpam: null,
      freshTrash: "trash",
    });
  });

  it("passes over a node that fails for the rest of the batch and Mail's prune, and tries it again the next minute", async () => {
    const cy = await mailbox("cron-cy", "Cy");
    // The stuck file went to the trash first, so the batch, in `trashed_at` order, reaches it before the other.
    const stuck = await putFile(cy.id, null, "stuck.txt");
    const other = await putFile(cy.id, null, "other.txt");
    await trashedSince(cy.id, stuck.id, 32);
    await trashedSince(cy.id, other.id, 31);
    const conversation = await deliver(cy.email, "Gone anyway");
    await junkSince(cy.id, conversation, "trash", 31);

    // The bucket refuses to delete the stuck file's object, so Drive's prune fails on that node alone.
    const stuckKey = defined(stuck.r2Key);

    const broken = stubEnv({
      ...env,
      DRIVE: {
        delete: (keys: string | string[]) =>
          [keys].flat().includes(stuckKey)
            ? Promise.reject(new Error("The bucket refuses it."))
            : env.DRIVE.delete(keys),
      },
    });

    const errors = vi.spyOn(console, "error").mockImplementation(() => {
      // The failing prune's log line, read below.
    });

    let logged = false;

    try {
      await handleScheduled(broken);
      // Read before `mockRestore`, which forgets the calls.
      logged = errors.mock.calls.some(([line]) =>
        String(line).includes('"drive.prune.error"')
      );
    } finally {
      errors.mockRestore();
    }

    expect({
      logged,
      stuck: await nodeKept(stuck.id),
      other: await nodeKept(other.id),
      conversation: await getThread(conversation),
    }).toStrictEqual({
      logged: true,
      stuck: true,
      other: false,
      conversation: null,
    });

    await handleScheduled(env);

    await expect(getNode(stuck.id)).resolves.toBeNull();
  });

  it("forgets the spam filter's idle words in every mailbox, a mailbox a minute, whether or not anyone opened Mail", async () => {
    const dee = await mailbox("cron-dee", "Dee");
    const eve = await mailbox("cron-eve", "Eve");
    await learnWords(dee.id);
    await learnWords(eve.id);

    // 121 days on, the words seen once have said nothing for longer than 120 days. The cron runs that day's first
    // minutes, one for each person, and nobody opens Mail.
    const day = dayOf(Date.now() + 121 * DAY);
    const people = await db.$count(users);

    for (let minute = 0; minute < people; minute += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the cron's runs, a minute apart, one after the other
      await handleScheduled(env, new Date(day + minute * MINUTE));
    }

    expect({
      dee: await wordsOf(dee.id),
      eve: await wordsOf(eve.id),
    }).toStrictEqual({
      dee: [TOTAL_TOKEN, "studio"],
      eve: [TOTAL_TOKEN, "studio"],
    });
  });

  it("prunes one mailbox's spam filter a minute, each on its own minute of the day, and again the next day", async () => {
    const fay = await mailbox("cron-fay", "Fay");
    await mailbox("cron-gus", "Gus");
    // Today only Fay's word that counts nowhere has said nothing long enough: the words she saw once today stay.
    await learnWords(fay.id);
    const day = dayOf(Date.now());

    const everyone = await db
      .select({ id: users.id })
      .from(users)
      .orderBy(asc(users.id));

    // Each person's minute, then two minutes that are nobody's, then the next day's first.
    const minutes = [
      ...everyone.keys(),
      everyone.length,
      everyone.length + 1,
      DAY / MINUTE,
    ];

    const turns: Awaited<ReturnType<typeof pruneSpamTokens>>[] = [];

    for (const minute of minutes) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the cron's runs, a minute apart, one after the other
      turns.push(await pruneSpamTokens(db, new Date(day + minute * MINUTE)));
    }

    const turnOf = (userId: string) => ({
      userId,
      forgotten: userId === fay.id ? 1 : 0,
    });

    expect({ turns, fay: await wordsOf(fay.id) }).toStrictEqual({
      turns: [
        ...everyone.map((u) => turnOf(u.id)),
        null,
        null,
        { userId: defined(everyone[0]).id, forgotten: 0 },
      ],
      fay: [TOTAL_TOKEN, "airdrop", "promo", "studio"],
    });
  });
});
