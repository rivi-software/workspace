import { asc, eq, gt, inArray, sql } from "drizzle-orm";

import type { Database } from "~/db";
import { searchEntries, searchState } from "~/db/schema";
import type { DriveNode } from "~/db/schema";
import { fileText } from "~/lib/assistant/reading.server";
import { changedFiles, existingNodes } from "~/lib/drive/drive.server";
import { formatAddress } from "~/lib/mail/addresses";
import {
  changedConversations,
  existingConversations,
  readConversation,
} from "~/lib/mail/mail.server";

import { MAX_ENTRY_CHARS, searchIndexFor } from "./index.server";
import type { SearchEntry, SearchIndex, SearchKind } from "./index.server";

/**
 * The indexer of the search by meaning, a part of the cron: each minute it reads a few conversations and
 * files and puts their text in the index (`./index.server`), with a row in `search_entries` for each.
 *
 * It finds its work by walking, never by scanning. For mail and for Drive there are two walks over the sources by
 * when they last changed (a conversation's last message, a file's last change): `fresh` moves on from the moment
 * the index began, so what arrives is found within a minute or two, and `back` moves from that moment into the
 * past and starts again from now once it has been through everything, so history is filled in and anything the
 * fresh walk missed (mail filed under an old date, an import) is found within a day. A source whose entry already
 * has its last change is passed over without a word to the model. A third walk, the sweep, goes through the
 * entries and takes out the vectors of what is gone for good.
 *
 * Nothing in Mail or Drive calls it: a broken index never holds up the mail. It reads through their interfaces
 * (`mail.server.ts`, `drive.server.ts`) and never their tables.
 */

/** How many sources each walk reads a run. The cron's D1 queries share one invocation's limit (1,000). */
export const MAIL_BATCH = 6;
export const DRIVE_BATCH = 2;
export const SWEEP_BATCH = 100;

/** Once the walk into the past has been through everything, it starts again from now after this long. */
const REWALK_MS = 24 * 60 * 60 * 1000;

/** A file's text in its entry, at most: its name comes first, so a long file still finds by what it is called. */
const MAX_FILE_TEXT = MAX_ENTRY_CHARS - 500;

type Walk = "fresh" | "back";

/** A source as a walk meets it: what it is, whose, and when it last changed. */
interface Source {
  id: string;
  userId: string;
  changedAt: string;
}

const cursorKey = (kind: SearchKind, walk: Walk) => `${kind}.${walk}`;

const readState = async (db: Database): Promise<Map<string, string>> => {
  const rows = await db.select().from(searchState);

  return new Map(rows.map((r) => [r.key, r.value]));
};

const writeState = async (db: Database, key: string, value: string) => {
  await db
    .insert(searchState)
    .values({ key, value })
    .onConflictDoUpdate({ target: searchState.key, set: { value } });
};

/** A moment a millisecond on or back, as the timestamps are written: how a walk steps past what it has read. */
const nudged = (iso: string, ms: number): string =>
  new Date(Date.parse(iso) + ms).toISOString();

/** The sources among these whose entry is missing or older than their last change. */
const unread = async (db: Database, sources: Source[]): Promise<Source[]> => {
  if (!sources.length) {
    return [];
  }

  const rows = await db
    .select({ id: searchEntries.id, sourceAt: searchEntries.sourceAt })
    .from(searchEntries)
    .where(
      inArray(
        searchEntries.id,
        sources.map((s) => s.id)
      )
    );

  const read = new Map(rows.map((r) => [r.id, r.sourceAt]));

  return sources.filter((s) => (read.get(s.id) ?? "") < s.changedAt);
};

/** A conversation as its vector holds it: its subject, who is on it, and each message's own words, the newest first. */
const conversationEntry = async (
  db: Database,
  source: Source
): Promise<SearchEntry | null> => {
  const thread = await readConversation(db, source.userId, source.id);

  if (!thread) {
    return null;
  }

  const text = [
    thread.subject,
    thread.people.map(formatAddress).join(", "),
    ...thread.messages
      .toReversed()
      .map((m) => `${formatAddress(m.from)}: ${m.text}`),
  ]
    .join("\n\n")
    .slice(0, MAX_ENTRY_CHARS);

  return { id: source.id, owner: source.userId, kind: "mail", text };
};

/** A file as its vector holds it: its name and, where it has text the assistant reads, that text. */
const fileEntry = async (env: Env, node: DriveNode): Promise<SearchEntry> => {
  const read = node.r2Key
    ? await fileText(env, node, async () => {
        const object = await env.DRIVE.get(node.r2Key ?? "");

        return object ? await object.arrayBuffer() : null;
      })
    : { error: "no file" };

  const text =
    "error" in read
      ? node.name
      : `${node.name}\n\n${read.text.slice(0, MAX_FILE_TEXT)}`;

  return { id: node.id, owner: node.userId, kind: "drive", text };
};

/** Put what was read into the index and note each as read up to its last change. */
const keep = async (
  db: Database,
  index: SearchIndex,
  read: { entry: SearchEntry; changedAt: string }[],
  now: Date
) => {
  if (!read.length) {
    return;
  }

  await index.put(read.map((r) => r.entry));
  const indexedAt = now.toISOString();

  // A handful of rows a run, each its own statement (D1 binds 100 values a query), none waiting on another.
  await Promise.all(
    read.map(({ entry, changedAt }) =>
      db
        .insert(searchEntries)
        .values({
          id: entry.id,
          kind: entry.kind,
          userId: entry.owner,
          sourceAt: changedAt,
          indexedAt,
        })
        .onConflictDoUpdate({
          target: searchEntries.id,
          set: { userId: entry.owner, sourceAt: changedAt, indexedAt },
        })
    )
  );
};

/** What one step of a walk needs: where to read the sources from, and how to make an entry of one. */
interface Walker {
  kind: SearchKind;
  batch: number;
  sources: (
    walk: { from: string; limit: number } | { until: string; limit: number }
  ) => Promise<Source[]>;
  entries: (sources: Source[]) => Promise<SearchEntry[]>;
}

/**
 * One step of a walk: the next sources from its cursor, those not read yet put in the index, and the cursor moved to
 * the last one met. A step that met a full batch of sources all read already moves a millisecond past them, or it
 * would meet the same batch for ever. A `back` walk that meets less than a batch has been through everything, and
 * rests for a day.
 */
const step = async (
  db: Database,
  index: SearchIndex,
  walker: Walker,
  walk: Walk,
  state: Map<string, string>,
  now: Date
): Promise<number> => {
  const key = cursorKey(walker.kind, walk);
  const cursor = state.get(key) ?? now.toISOString();
  const restKey = `${key}.rested`;

  if (walk === "back" && state.has(restKey)) {
    // It rests until a day has gone by, then starts again from now.
    if (now.getTime() - Date.parse(state.get(restKey) ?? "") < REWALK_MS) {
      return 0;
    }

    await db.delete(searchState).where(eq(searchState.key, restKey));
    await writeState(db, key, now.toISOString());

    return 0;
  }

  const met = await walker.sources(
    walk === "fresh"
      ? { from: cursor, limit: walker.batch }
      : { until: cursor, limit: walker.batch }
  );

  if (!met.length) {
    if (walk === "back") {
      await writeState(db, restKey, now.toISOString());
    } else if (!state.has(key)) {
      await writeState(db, key, cursor);
    }

    return 0;
  }

  const fresh = await unread(db, met);
  const entries = await walker.entries(fresh);
  const changedAt = new Map(fresh.map((s) => [s.id, s.changedAt]));

  await keep(
    db,
    index,
    entries.map((entry) => ({
      entry,
      changedAt: changedAt.get(entry.id) ?? now.toISOString(),
    })),
    now
  );

  const last = met.at(-1)?.changedAt ?? cursor;
  const full = met.length === walker.batch;

  // A full batch that ends where it began would be met again: step past it.
  const next =
    full && last === cursor ? nudged(last, walk === "fresh" ? 1 : -1) : last;

  await writeState(db, key, next);

  // Less than a batch is the end of what there is: the walk into the past has been through everything.
  if (walk === "back" && !full) {
    await writeState(db, restKey, now.toISOString());
  }

  return entries.length;
};

/** The entries whose source is gone for good, among the next slice of them: their vectors and their rows go. */
const sweep = async (
  db: Database,
  index: SearchIndex,
  state: Map<string, string>
): Promise<number> => {
  const rows = await db
    .select({ id: searchEntries.id, kind: searchEntries.kind })
    .from(searchEntries)
    .where(gt(searchEntries.id, state.get("sweep") ?? ""))
    .orderBy(asc(searchEntries.id))
    .limit(SWEEP_BATCH);

  // At the end of the entries the sweep starts over.
  await writeState(
    db,
    "sweep",
    rows.length === SWEEP_BATCH ? (rows.at(-1)?.id ?? "") : ""
  );

  if (!rows.length) {
    return 0;
  }

  const ofKind = (kind: SearchKind) =>
    rows.filter((r) => r.kind === kind).map((r) => r.id);

  const [conversations, nodes] = await Promise.all([
    existingConversations(db, ofKind("mail")),
    existingNodes(db, ofKind("drive")),
  ]);

  const gone = rows
    .filter((r) => !(r.kind === "mail" ? conversations : nodes).has(r.id))
    .map((r) => r.id);

  if (gone.length) {
    await index.remove(gone);

    await db
      .delete(searchEntries)
      .where(
        sql`${searchEntries.id} in (select value from json_each(${JSON.stringify(gone)}))`
      );
  }

  return gone.length;
};

/**
 * One run of the indexer: a step of each walk and a slice of the sweep. Answers what it did, and nothing where
 * this Worker has no index (local dev, a Worker without the bindings).
 */
export const indexForSearch = async (
  env: Env,
  db: Database,
  now = new Date()
): Promise<{ indexed: number; removed: number } | null> => {
  const index = searchIndexFor(env);

  if (!index) {
    return null;
  }

  const state = await readState(db);

  const mail: Walker = {
    kind: "mail",
    batch: MAIL_BATCH,
    sources: async (walk) => {
      const rows = await changedConversations(db, walk);

      return rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        changedAt: r.lastMessageAt,
      }));
    },
    entries: async (sources) => {
      const entries: SearchEntry[] = [];

      for (const source of sources) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of conversations a run, read one after the other
        const entry = await conversationEntry(db, source);

        if (entry) {
          entries.push(entry);
        }
      }

      return entries;
    },
  };

  // The walk hands the nodes it met to `entries`, which reads their bytes: both see the same rows.
  const nodes = new Map<string, DriveNode>();

  const drive: Walker = {
    kind: "drive",
    batch: DRIVE_BATCH,
    sources: async (walk) => {
      const rows = await changedFiles(db, walk);

      for (const node of rows) {
        nodes.set(node.id, node);
      }

      return rows.map((n) => ({
        id: n.id,
        userId: n.userId,
        changedAt: n.updatedAt,
      }));
    },
    entries: async (sources) => {
      const entries: SearchEntry[] = [];

      for (const source of sources) {
        const node = nodes.get(source.id);

        if (node) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- two files a run, converted one after the other
          entries.push(await fileEntry(env, node));
        }
      }

      return entries;
    },
  };

  // Four steps a run, in turn: the two walks of a kind can meet the same source, and one must have noted it before
  // the other asks whether it was read.
  const freshMail = await step(db, index, mail, "fresh", state, now);
  const oldMail = await step(db, index, mail, "back", state, now);
  const freshFiles = await step(db, index, drive, "fresh", state, now);
  const oldFiles = await step(db, index, drive, "back", state, now);
  const indexed = freshMail + oldMail + freshFiles + oldFiles;

  return { indexed, removed: await sweep(db, index, state) };
};
