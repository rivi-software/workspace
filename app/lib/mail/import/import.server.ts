/**
 * Importing a person's existing mailbox (Settings → Mail → Import). Today the source is Microsoft 365 through Graph
 * (`microsoft.server.ts`). Connecting saves the source's folders and where each one's mail goes, plus the connection's
 * tokens, encrypted. The cron then works through the mailbox a batch a minute (`runImports`), oldest message first,
 * from a cursor on the received time, so a reply finds its thread. Each message is its original MIME, filed as mail
 * that arrives is: parsed, threaded, the `.eml` and the files in R2. It is placed as the source had it: Inbox in the
 * inbox, Sent Items under Sent, other folders and Outlook's categories as labels, flags as stars, read as read.
 * Deleted Items, Junk Email, Drafts and Outbox stay behind. A message the mailbox already holds (by Message-ID) is
 * not copied again, so running an import twice adds only what is new. Filters and the vacation responder never see
 * imported mail: it is history, not news.
 */
import { and, asc, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";

import type { Database } from "~/db";
import { mailImports, messages, users } from "~/db/schema";
import type { MailImport, User } from "~/db/schema";
import { defined } from "~/lib/guards";

import { newId } from "../../ids";
import { openSecret, sealSecret } from "../../secret-box.server";
import { fileMessage } from "../filing.server";
import { parseRawEmail } from "../ingest.server";
import type { ParsedMail } from "../ingest.server";
import { labelNamed } from "../labels.server";
import { normalizeMessageId } from "../threading";
import { ownAddresses } from "../threads.server";
import {
  GraphError,
  MicrosoftAuthError,
  graphMailSource,
  refreshMicrosoftTokens,
} from "./microsoft.server";
import type {
  Fetch,
  MailSource,
  MicrosoftTokens,
  SourceFolder,
  SourceMessage,
} from "./microsoft.server";

export class ImportError extends Error {
  override name = "ImportError";
}

/** The largest message an import copies, as large as Email Routing delivers. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

/** Messages listed at a time. D1 takes 100 bound values a query, and the duplicate check binds one per message. */
const PAGE = 50;

/** How long a batch holds an import: longer than a batch runs, short enough that a dead one lets go soon. */
const LEASE_MS = 3 * 60_000;

/** Batches in a row that may fail at one message before it is left out. */
const ATTEMPTS = 3;

/** How many of the messages left out an import names. */
const LEFT_OUT_KEPT = 50;
const TOKEN_PURPOSE = "mail-import-tokens";

/** Where a source folder's mail goes: the inbox, Sent, the archive, the archive with a label, or nowhere. */
export interface ImportFolder {
  path: string;
  kind: "inbox" | "sent" | "archive" | "label" | "skip";
  label: string | null;
}

/** Each source folder's place here, by the folder's id. */
export type FolderPlan = Record<string, ImportFolder>;

/** How far an import is: the received time it reached, the messages at that time it did, and how many to pass. */
export interface ImportCursor {
  after?: string | null;
  seen?: string[];
  skip?: number;
}

export interface ImportLeftOut {
  subject: string;
  date: string;
  reason: string;
}

/** What Settings shows of an import. */
export interface ImportView {
  id: string;
  account: string;
  status: MailImport["status"];
  total: number;
  imported: number;
  duplicates: number;
  leftOut: number;
  leftOutList: ImportLeftOut[];
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** The well-known folders whose mail stays behind, with every folder under them. */
const SKIPPED = new Set([
  "deleteditems",
  "junkemail",
  "drafts",
  "outbox",
  "conversationhistory",
  "syncissues",
  "conflicts",
  "localfailures",
  "serverfailures",
  "recoverableitemsdeletions",
  "scheduled",
  "searchfolders",
]);

const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  try {
    // SAFETY: the columns read here are written by this module as `JSON.stringify` of the `T` each caller names.
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
};

const planFolder = (
  f: SourceFolder,
  byId: Map<string, SourceFolder>
): ImportFolder => {
  let skip = false;
  let top = f;

  for (
    let at: SourceFolder | undefined = f;
    at;
    at = at.parentId ? byId.get(at.parentId) : undefined
  ) {
    if (at.wellKnown && SKIPPED.has(at.wellKnown)) {
      skip = true;
    }

    top = at;
  }

  if (skip) {
    return { path: f.path, kind: "skip", label: null };
  }

  if (f.wellKnown === "inbox") {
    return { path: f.path, kind: "inbox", label: null };
  }

  if (f.wellKnown === "sentitems") {
    return { path: f.path, kind: "sent", label: null };
  }

  if (f.wellKnown === "archive") {
    return { path: f.path, kind: "archive", label: null };
  }

  return {
    path: f.path,
    kind: "label",
    label:
      top !== f && top.wellKnown ? f.path.slice(top.path.length + 1) : f.path,
  };
};

/**
 * Each source folder's place here. Inbox, Sent Items and Archive keep their meaning; a folder of the person's own
 * becomes a label, named by its path below the well-known folder it sits in (Inbox/Clients/Acme: "Clients/Acme").
 */
export const planFolders = (folders: SourceFolder[]) => {
  const byId = new Map(folders.map((f) => [f.id, f]));

  return Object.fromEntries(folders.map((f) => [f.id, planFolder(f, byId)]));
};

/** Where one message goes here, as its source folder and marks say. */
export interface Placement {
  folder: "inbox" | "archive";
  sent: boolean;
  read: boolean;
  starred: boolean;
  labels: string[];
}

/** A message's place, or null for one an import leaves alone: a draft, or in a folder it leaves behind. */
export const placementFor = (
  m: SourceMessage,
  folders: Record<string, ImportFolder>
): Placement | null => {
  if (m.draft) {
    return null;
  }

  // A folder made since the import started is not in the plan: its mail goes to the archive.
  const f = folders[m.folderId];

  if (f?.kind === "skip") {
    return null;
  }

  return {
    folder: f?.kind === "inbox" ? "inbox" : "archive",
    sent: f?.kind === "sent",
    read: m.read || f?.kind === "sent",
    starred: m.flagged,
    labels: [
      ...(f?.kind === "label" && f.label ? [f.label] : []),
      ...m.categories,
    ],
  };
};

export const importView = (row: MailImport): ImportView => ({
  id: row.id,
  account: row.account,
  status: row.status,
  total: row.total,
  imported: row.imported,
  duplicates: row.duplicates,
  leftOut: row.leftOut,
  leftOutList: parseJson<ImportLeftOut[]>(row.leftOutJson, []),
  lastError: row.lastError,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  finishedAt: row.finishedAt,
});

/** The person's newest import, running or not, for Settings. */
export const latestImport = async (
  db: Database,
  userId: string
): Promise<MailImport | undefined> =>
  await db.query.mailImports.findFirst({
    where: eq(mailImports.userId, userId),
    orderBy: [desc(mailImports.createdAt)],
  });

/**
 * Start importing the mailbox a connection reaches: who it is, its folders and where each goes, how much mail they
 * hold, and the tokens, encrypted. The cron does the rest. One import runs per person at a time.
 */
export const startImport = async (
  env: Env,
  db: Database,
  user: User,
  tokens: MicrosoftTokens,
  source: MailSource = graphMailSource(() =>
    Promise.resolve(tokens.accessToken)
  )
): Promise<MailImport> => {
  const running = await db.query.mailImports.findFirst({
    where: and(
      eq(mailImports.userId, user.id),
      eq(mailImports.status, "running")
    ),
  });

  if (running) {
    throw new ImportError(
      `The import from ${running.account} is still running. Cancel it before you start another.`
    );
  }

  const account = await source.account();
  const folders = await source.folders();
  const plan = planFolders(folders);
  const id = newId("imp");

  try {
    await db.insert(mailImports).values({
      id,
      userId: user.id,
      provider: "microsoft",
      account: account.email,
      tokensSealed: await sealSecret(
        env,
        TOKEN_PURPOSE,
        JSON.stringify(tokens)
      ),
      foldersJson: JSON.stringify(plan),
      total: folders
        .filter((f) => plan[f.id]?.kind !== "skip")
        .reduce((n, f) => n + f.total, 0),
    });
  } catch {
    // The one running import per person (a unique index): another tab started one a moment ago.
    throw new ImportError("An import is running already.");
  }

  console.log(
    JSON.stringify({
      event: "mail.import.started",
      importId: id,
      userId: user.id,
    })
  );

  return defined(
    await db.query.mailImports.findFirst({
      where: eq(mailImports.id, id),
    }),
    "the result of find first"
  );
};

/** Stop a running import. What it copied stays; the connection's tokens go. */
export const cancelImport = async (
  db: Database,
  userId: string,
  id: string
): Promise<boolean> => {
  const now = new Date().toISOString();

  const updated = await db
    .update(mailImports)
    .set({
      status: "cancelled",
      tokensSealed: null,
      leaseUntil: null,
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(mailImports.id, id),
        eq(mailImports.userId, userId),
        eq(mailImports.status, "running")
      )
    )
    .returning({ id: mailImports.id });

  return updated.length > 0;
};

/** The source of a running import: Graph with its tokens, refreshed (and kept, encrypted) when they run out. */
const connectionFor = async (
  env: Env,
  db: Database,
  row: MailImport,
  fetcher: Fetch = fetch
): Promise<MailSource> => {
  const plain = await openSecret(env, TOKEN_PURPOSE, row.tokensSealed);

  if (!plain) {
    throw new MicrosoftAuthError(
      "The connection to Microsoft was lost. Connect again to go on."
    );
  }

  // SAFETY: only this module seals under `TOKEN_PURPOSE`, and it seals `JSON.stringify` of a `MicrosoftTokens`.
  let tokens = JSON.parse(plain) as MicrosoftTokens;

  return graphMailSource(async () => {
    if (tokens.expiresAt - Date.now() < 5 * 60_000) {
      tokens = await refreshMicrosoftTokens(env, tokens.refreshToken, fetcher);
      await db
        .update(mailImports)
        .set({
          tokensSealed: await sealSecret(
            env,
            TOKEN_PURPOSE,
            JSON.stringify(tokens)
          ),
        })
        .where(eq(mailImports.id, row.id));
    }

    return tokens.accessToken;
  }, fetcher);
};

export interface RunOptions {
  now?: Date;
  /** How long the batches may take together; the cron runs every minute. */
  budgetMs?: number;
  /** The most messages a batch fetches. */
  maxMessages?: number;
  /** The source of an import; Graph with the import's tokens unless a test brings its own. */
  source?: (row: MailImport) => Promise<MailSource>;
}

const counts = (state: {
  imported: number;
  duplicates: number;
  leftOut: number;
}) => ({
  imported: state.imported,
  duplicates: state.duplicates,
  leftOut: state.leftOut,
});

/** Which of the listed messages the mailbox holds already, by their Message-ID. */
const knownMessageIds = async (
  db: Database,
  userId: string,
  listed: SourceMessage[]
): Promise<Set<string>> => {
  const ids = listed.flatMap((m) => {
    const id = normalizeMessageId(m.internetMessageId);

    return id ? [id] : [];
  });

  if (!ids.length) {
    return new Set();
  }

  const rows = await db
    .select({ id: messages.messageId })
    .from(messages)
    .where(and(eq(messages.userId, userId), inArray(messages.messageId, ids)));

  return new Set(rows.map((r) => r.id));
};

/**
 * One message of the source filed here as history (`fileMessage`): threaded as it would have been on arrival (by its
 * references, else by subject near its own date), the thread placed and marked as the source had it, the raw message
 * and its files in R2, its labels on the thread, and its people among the contacts. No filter or spam check runs.
 */
export const importMessage = async (
  env: Env,
  db: Database,
  user: User,
  raw: ArrayBuffer,
  place: Placement,
  options: {
    own: Set<string>;
    labelIds: string[];
    fallbackMessageId: string;
    fallbackDate: string;
  }
): Promise<"imported" | "duplicate" | "unreadable"> => {
  let p: ParsedMail;

  try {
    p = await parseRawEmail(raw, user.email, {
      messageId: options.fallbackMessageId,
      date: options.fallbackDate,
    });
  } catch {
    return "unreadable";
  }

  const filed = await fileMessage(env, db, user, {
    policy: "history",
    mail: p,
    raw,
    own: options.own,
    place: () => ({
      folder: place.folder,
      starred: place.starred,
      labelIds: options.labelIds,
      read: place.read,
      outbound: place.sent || options.own.has(p.from.email),
    }),
  });

  return filed.status === "filed" ? "imported" : "duplicate";
};

/** What a batch of one import carries from message to message: its progress, and how that is saved to the row. */
const batchOf = (db: Database, row: MailImport) => {
  const state = {
    cursor: parseJson<ImportCursor>(row.cursorJson, {}),
    imported: row.imported,
    duplicates: row.duplicates,
    leftOut: row.leftOut,
    leftOutList: parseJson<ImportLeftOut[]>(row.leftOutJson, []),
    attempts: row.attempts,
  };

  const save = (extra: Partial<typeof mailImports.$inferInsert> = {}) =>
    db
      .update(mailImports)
      .set({
        cursorJson: JSON.stringify(state.cursor),
        imported: state.imported,
        duplicates: state.duplicates,
        leftOut: state.leftOut,
        leftOutJson: JSON.stringify(state.leftOutList),
        attempts: state.attempts,
        updatedAt: new Date().toISOString(),
        ...extra,
      })
      .where(eq(mailImports.id, row.id));

  const advance = (m: SourceMessage) => {
    const c = state.cursor;
    state.cursor =
      !c.after || m.receivedAt > c.after
        ? { after: m.receivedAt, seen: [m.id], skip: 0 }
        : { ...c, seen: [...(c.seen ?? []), m.id] };
    state.attempts = 0;
  };

  const leaveOut = (m: SourceMessage, reason: string) => {
    state.leftOut += 1;

    if (state.leftOutList.length < LEFT_OUT_KEPT) {
      state.leftOutList.push({
        subject: m.subject || "(no subject)",
        date: m.receivedAt,
        reason,
      });
    }
  };

  const finish = (status: "done" | "failed", lastError: string | null) =>
    save({
      status,
      lastError,
      tokensSealed: null,
      leaseUntil: null,
      finishedAt: new Date().toISOString(),
    });

  return { state, save, advance, leaveOut, finish };
};

type Batch = ReturnType<typeof batchOf>;

/** The labels an import's messages take, by name: each made once, then kept for the rest of the batch. */
const labelResolver = (db: Database, userId: string) => {
  const labelIds = new Map<string, string | null>();

  return async (names: string[]) => {
    const ids: string[] = [];

    for (const name of names) {
      if (!labelIds.has(name)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- an import runs in order: each page, message and batch builds on the one before (cursor, counters, progress)
        labelIds.set(name, await labelNamed(db, userId, name));
      }

      const id = labelIds.get(name);

      if (id) {
        ids.push(id);
      }
    }

    return ids;
  };
};

/** What copying a source's messages needs: where they go, whose they are, and where progress is kept. */
interface Copying {
  env: Env;
  db: Database;
  importId: string;
  user: User;
  source: MailSource;
  folders: FolderPlan;
  own: Set<string>;
  labelsFor: (names: string[]) => Promise<string[]>;
  batch: Batch;
}

/**
 * One message copied: its MIME from the source, filed as history, the cursor moved past it. A message that cannot be
 * copied is tried again next batch, and left out after a few; a connection that is gone stops the batch.
 */
const copyMessage = async (
  m: SourceMessage,
  placement: Placement,
  c: Copying
): Promise<void> => {
  const { batch } = c;

  try {
    const raw = await c.source.mime(m.id, MAX_IMPORT_BYTES);

    if (raw === "too-large") {
      batch.leaveOut(m, "larger than 25 MB");
    } else if (raw !== "gone") {
      const outcome = await importMessage(c.env, c.db, c.user, raw, placement, {
        own: c.own,
        labelIds: await c.labelsFor(placement.labels),
        fallbackMessageId: `<${m.id.replaceAll(/[^\w.-]/gu, "")}@outlook.import>`,
        fallbackDate: m.receivedAt,
      });

      if (outcome === "imported") {
        batch.state.imported += 1;
      } else if (outcome === "duplicate") {
        batch.state.duplicates += 1;
      } else {
        batch.leaveOut(m, "could not be read");
      }
    }

    batch.advance(m);
  } catch (error) {
    if (error instanceof MicrosoftAuthError || error instanceof GraphError) {
      throw error;
    }

    // This message, or the platform under it: tried again next batch, and left out after a few.
    batch.state.attempts += 1;

    if (batch.state.attempts < ATTEMPTS) {
      throw error;
    }

    console.log(
      JSON.stringify({
        event: "mail.import.left_out",
        importId: c.importId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    batch.leaveOut(m, "could not be copied");
    batch.advance(m);
  }
};

/** One listed message: passed over when it has no place here or the mailbox holds it, else copied. True when copied. */
const takeMessage = async (
  m: SourceMessage,
  known: Set<string>,
  c: Copying
): Promise<boolean> => {
  const placement = placementFor(m, c.folders);

  if (!placement) {
    c.batch.advance(m);

    return false;
  }

  const id = normalizeMessageId(m.internetMessageId);

  if (id && known.has(id)) {
    c.batch.state.duplicates += 1;
    c.batch.advance(m);

    return false;
  }

  await copyMessage(m, placement, c);

  return true;
};

/** One page of the source's messages: those past the cursor copied, until the time or `room` messages run out. Answers how many were copied. */
const copyPage = async (
  page: SourceMessage[],
  c: Copying,
  limits: { deadline: number; room: number }
): Promise<number> => {
  const { state, save } = c.batch;
  const seen = new Set(state.cursor.seen);

  const fresh = page.filter(
    (m) => !(m.receivedAt === state.cursor.after && seen.has(m.id))
  );

  if (!fresh.length) {
    // A full page at the cursor's own moment, all done already: page past them.
    state.cursor = {
      ...state.cursor,
      skip: (state.cursor.skip ?? 0) + page.length,
    };

    return 0;
  }

  const known = await knownMessageIds(c.db, c.user.id, fresh);
  let fetched = 0;

  for (const m of fresh) {
    if (Date.now() >= limits.deadline || fetched >= limits.room) {
      break;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- an import runs in order: each page, message and batch builds on the one before (cursor, counters, progress)
    if (await takeMessage(m, known, c)) {
      fetched += 1;
    }
  }

  await save();

  return fetched;
};

/** One import's batch: messages from its cursor until the time, the count or the mailbox runs out. */
const runBatch = async (
  env: Env,
  db: Database,
  row: MailImport,
  options: {
    deadline: number;
    maxMessages: number;
    source: (row: MailImport) => Promise<MailSource>;
  }
): Promise<number> => {
  const batch = batchOf(db, row);
  const { state, save, finish } = batch;
  const startedWith = row.imported;

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, row.userId),
    });

    if (!user?.active) {
      await finish("failed", "The mailbox is deactivated.");

      return 0;
    }

    const source = await options.source(row);
    const own = await ownAddresses(db, user);
    own.add(row.account.toLowerCase());

    const copying: Copying = {
      env,
      db,
      importId: row.id,
      user,
      source,
      folders: parseJson<FolderPlan>(row.foldersJson, {}),
      own,
      labelsFor: labelResolver(db, user.id),
      batch,
    };

    let fetched = 0;

    while (Date.now() < options.deadline && fetched < options.maxMessages) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- an import runs in order: each page, message and batch builds on the one before (cursor, counters, progress)
      const page = await source.messages(
        state.cursor.after ?? null,
        state.cursor.skip ?? 0,
        PAGE
      );

      if (!page.length) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- an import runs in order: each page, message and batch builds on the one before (cursor, counters, progress)
        await finish("done", null);
        console.log(
          JSON.stringify({
            event: "mail.import.done",
            importId: row.id,
            ...counts(state),
          })
        );

        return state.imported - startedWith;
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- an import runs in order: each page, message and batch builds on the one before (cursor, counters, progress)
      fetched += await copyPage(page, copying, {
        deadline: options.deadline,
        room: options.maxMessages - fetched,
      });
    }

    await save({ leaseUntil: null, lastError: null });

    return state.imported - startedWith;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      JSON.stringify({
        event: "mail.import.error",
        importId: row.id,
        error: message,
      })
    );

    if (error instanceof MicrosoftAuthError) {
      await finish("failed", message);
    } else {
      // Microsoft asked for a pause: the import waits it out; anything else is tried again next minute.
      const pause =
        error instanceof GraphError && error.retryAfter
          ? new Date(Date.now() + error.retryAfter * 1000).toISOString()
          : null;

      await save({ lastError: message, leaseUntil: pause });
    }

    return state.imported - startedWith;
  }
};

/**
 * One batch of every running import nobody holds, the one least recently worked on first, within the budget.
 * Each import is held (`lease_until`) while its batch runs, so two cron runs never work on one at once.
 */
export const runImports = async (
  env: Env,
  db: Database,
  options: RunOptions = {}
): Promise<{ batches: number; imported: number }> => {
  const now = options.now ?? new Date();
  const deadline = Date.now() + (options.budgetMs ?? 40_000);

  const source =
    options.source ?? ((row: MailImport) => connectionFor(env, db, row));

  const rows = await db.query.mailImports.findMany({
    where: and(
      eq(mailImports.status, "running"),
      or(
        isNull(mailImports.leaseUntil),
        lt(mailImports.leaseUntil, now.toISOString())
      )
    ),
    orderBy: [asc(mailImports.updatedAt)],
    limit: 5,
  });

  let batches = 0;
  let imported = 0;

  for (const row of rows) {
    if (Date.now() >= deadline) {
      break;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- an import runs in order: each page, message and batch builds on the one before (cursor, counters, progress)
    const claimed = await db
      .update(mailImports)
      .set({ leaseUntil: new Date(Date.now() + LEASE_MS).toISOString() })
      .where(
        and(
          eq(mailImports.id, row.id),
          eq(mailImports.status, "running"),
          or(
            isNull(mailImports.leaseUntil),
            lt(mailImports.leaseUntil, now.toISOString())
          )
        )
      )
      .returning({ id: mailImports.id });

    if (!claimed.length) {
      continue;
    }

    batches += 1;
    // oxlint-disable-next-line eslint/no-await-in-loop -- an import runs in order: each page, message and batch builds on the one before (cursor, counters, progress)
    imported += await runBatch(env, db, row, {
      deadline,
      maxMessages: options.maxMessages ?? 100,
      source,
    });
  }

  return { batches, imported };
};
