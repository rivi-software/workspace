import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  or,
  sql,
} from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import type { Database } from "~/db";
import {
  attachments,
  draftFiles,
  drafts,
  labels,
  messages,
  threadLabels,
  threads,
} from "~/db/schema";
import type { Address, Message, Thread } from "~/db/schema";
import { defined, unreachable } from "~/lib/guards";

import { parseJsonAddresses } from "./addresses";
import { signFileUrl } from "./files.server";
import { EXPIRY_DAYS, isLabelColor } from "./folders";
import type { Folder, LabelRef } from "./folders";
import { parsePgpStatus } from "./pgp/pgp";
import { parseQuery, queryDate, searchScope } from "./query";
import type { QueryTerm } from "./query";
import type { AttachmentView, MessageView } from "./reads";
import { parseSpamCheck } from "./spam";
import { parseJsonUnsubscribe } from "./unsubscribe";
import { COUNTED, viewCondition } from "./views";
import type { Cond } from "./views";

export type { Folder } from "./folders";

/** What a list asks for: a view, or one label's threads, with a search over it, by page. */
export interface ListOptions {
  folder: Folder;
  /** A label's id: its threads instead of the folder's. */
  label?: string | null;
  q?: string;
  /** Only the threads with one of these addresses (lower-cased) among their participants. */
  with?: string[];
  limit?: number;
  offset?: number;
}

const JUNK = ["trash", "spam"] as const;

const escapeLike = (value: string): string =>
  value.replaceAll(/[\\%_]/gu, "\\$&");

/** `column LIKE %value%`, the wildcards in the value escaped (SQLite's LIKE needs the ESCAPE clause for that). */
const contains = (column: SQLWrapper, value: string): SQL =>
  sql`${column} like ${`%${escapeLike(value)}%`} escape '\\'`;

/**
 * `column IN (ids)` with the ids bound as one JSON array: D1 binds 100 values a query, and a page of the list or an
 * action on a selection holds up to 100 threads (500 for an action, 1000 for "Mark all as read"), a message's
 * References one id per earlier message (`resolveThread`).
 */
export const inIds = (column: SQLWrapper, ids: string[]): SQL =>
  sql`${column} in (select value from json_each(${JSON.stringify(ids)}))`;

/** A condition of `views.ts` as SQL on the owner's `threads`: the server's reading of `matches`. */
export const conditionSql = (cond: Cond, userId: string): SQL => {
  switch (cond.is) {
    case "in": {
      return eq(threads.folder, cond.folder);
    }

    case "junk": {
      return inArray(threads.folder, [...JUNK]);
    }

    case "snoozed": {
      return isNotNull(threads.snoozedUntil);
    }

    case "starred": {
      return eq(threads.starred, true);
    }

    case "sent": {
      return gt(threads.sentCount, 0);
    }

    case "unread": {
      return gt(threads.unreadCount, 0);
    }

    case "labelled": {
      return sql`${threads.id} in (select thread_id from thread_labels where user_id = ${userId} and label_id = ${cond.id})`;
    }

    case "not": {
      return not(conditionSql(cond.cond, userId));
    }

    case "all": {
      return and(...cond.conds.map((c) => conditionSql(c, userId))) ?? sql`1`;
    }

    case "always": {
      return sql`1`;
    }

    case "never": {
      return sql`0`;
    }

    default: {
      throw new Error("That condition is not one a view can hold.");
    }
  }
};

/** The condition of a view (`viewCondition`): where the thread sits, or what marks it. */
const viewWhere = (
  userId: string,
  folder: Folder | "anywhere",
  label?: string | null
): SQL[] => [
  eq(threads.userId, userId),
  conditionSql(viewCondition(folder, label), userId),
];

/** What `is:` names: a state of the thread, or null for a word that is none. */
const stateWhere = (state: string): SQL | null => {
  switch (state) {
    case "unread": {
      return gt(threads.unreadCount, 0);
    }

    case "read": {
      return eq(threads.unreadCount, 0);
    }

    case "starred": {
      return eq(threads.starred, true);
    }

    case "snoozed": {
      return isNotNull(threads.snoozedUntil);
    }

    case "muted": {
      return eq(threads.muted, true);
    }

    default: {
      return null;
    }
  }
};

/** One search operator as a condition on the thread, or null for one that says nothing (`in:` sets the scope). */
const termWhere = (userId: string, t: QueryTerm): SQL | null => {
  const inMessages = (cond: SQL) =>
    sql`${threads.id} in (select thread_id from messages where user_id = ${userId} and ${cond})`;

  const needle = `%${escapeLike(t.value)}%`;
  let cond: SQL | null = null;

  switch (t.field) {
    case "text": {
      cond = defined(
        or(
          contains(threads.subject, t.value),
          contains(threads.snippet, t.value),
          contains(threads.participantsJson, t.value),
          inMessages(sql`text like ${needle} escape '\\'`)
        ),
        "the result of or"
      );
      break;
    }

    case "from": {
      cond = inMessages(
        sql`(from_email like ${needle} escape '\\' or from_name like ${needle} escape '\\')`
      );
      break;
    }

    case "to": {
      cond = inMessages(
        sql`(to_json like ${needle} escape '\\' or cc_json like ${needle} escape '\\')`
      );
      break;
    }

    case "subject": {
      cond = contains(threads.subject, t.value);
      break;
    }

    case "label": {
      cond = sql`${threads.id} in (select tl.thread_id from thread_labels tl join labels l on l.id = tl.label_id where tl.user_id = ${userId} and lower(l.name) = ${t.value.toLowerCase()})`;
      break;
    }

    case "has": {
      if (/^(?:attachment|attachments|file|files)$/iu.test(t.value)) {
        cond = eq(threads.hasAttachments, true);
      }

      break;
    }

    case "is": {
      cond = stateWhere(t.value.toLowerCase());
      break;
    }

    case "before": {
      const d = queryDate(t.value);

      if (d) {
        cond = lt(threads.lastMessageAt, d);
      }

      break;
    }

    case "after": {
      const d = queryDate(t.value);

      if (d) {
        cond = gte(threads.lastMessageAt, d);
      }

      break;
    }

    case "in": {
      // `in:` sets the scope (`searchScope`) and says nothing about the thread.
      break;
    }

    default: {
      return unreachable(t.field, "search field");
    }
  }

  if (!cond) {
    return null;
  }

  return t.negated ? not(cond) : cond;
};

/** Threads with one of the addresses among their participants, the addresses bound as one JSON array. */
const withPeople = (addresses: string[]): SQL =>
  sql`exists (select 1 from json_each(${threads.participantsJson}) where json_extract(value, '$.email') in (select value from json_each(${JSON.stringify(addresses)})))`;

/** The conditions a list, its count and "mark all as read" (`markAllRead`) share. */
export const listWhere = (userId: string, options: ListOptions) => {
  const people = options.with ? [withPeople(options.with)] : [];
  const terms = parseQuery(options.q ?? "");

  if (!terms.length) {
    return {
      where: [...viewWhere(userId, options.folder, options.label), ...people],
      searching: false,
    };
  }

  const where = viewWhere(
    userId,
    searchScope(options.folder, terms),
    options.label ?? null
  );

  for (const t of terms) {
    const cond = termWhere(userId, t);

    if (cond) {
      where.push(cond);
    }
  }

  return { where: [...where, ...people], searching: true };
};

/** The rows of a view, newest first (snoozed: soonest first), `q` read as a search (`query.ts`). */
export const listThreads = async (
  db: Database,
  userId: string,
  options: ListOptions
): Promise<Thread[]> => {
  const { where, searching } = listWhere(userId, options);
  const bySnooze = options.folder === "snoozed" && !searching && !options.label;

  return await db.query.threads.findMany({
    where: and(...where),
    orderBy: bySnooze
      ? [asc(threads.snoozedUntil), desc(threads.lastMessageAt)]
      : [desc(threads.lastMessageAt), desc(threads.id)],
    limit: options.limit ?? 100,
    offset: options.offset ?? 0,
  });
};

export const countThreads = async (
  db: Database,
  userId: string,
  options: ListOptions
): Promise<number> => {
  const { where } = listWhere(userId, options);

  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(threads)
    .where(and(...where));

  return Number(row?.n ?? 0);
};

export interface FolderCounts {
  inboxUnread: number;
  spamUnread: number;
  snoozed: number;
  drafts: number;
  scheduled: number;
  /** Unread threads per label id. */
  labels: Record<string, number>;
}

export const folderCounts = async (
  db: Database,
  userId: string
): Promise<FolderCounts> => {
  const counted = (cond: Cond) =>
    sql<number>`sum(case when ${conditionSql(cond, userId)} then 1 else 0 end)`;

  const [row] = await db
    .select({
      inboxUnread: counted(COUNTED.inboxUnread),
      spamUnread: counted(COUNTED.spamUnread),
      snoozed: counted(COUNTED.snoozed),
    })
    .from(threads)
    .where(eq(threads.userId, userId));

  const [draftRows] = await db
    .select({
      n: sql<number>`sum(case when scheduled_at is null then 1 else 0 end)`,
      scheduled: sql<number>`sum(case when scheduled_at is not null then 1 else 0 end)`,
    })
    .from(drafts)
    .where(eq(drafts.userId, userId));

  const perLabel = await db
    .select({ labelId: threadLabels.labelId, n: sql<number>`count(*)` })
    .from(threadLabels)
    .innerJoin(threads, eq(threads.id, threadLabels.threadId))
    .where(
      and(
        eq(threadLabels.userId, userId),
        conditionSql(COUNTED.labelUnread, userId)
      )
    )
    .groupBy(threadLabels.labelId);

  return {
    inboxUnread: Number(row?.inboxUnread ?? 0),
    spamUnread: Number(row?.spamUnread ?? 0),
    snoozed: Number(row?.snoozed ?? 0),
    drafts: Number(draftRows?.n ?? 0),
    scheduled: Number(draftRows?.scheduled ?? 0),
    labels: Object.fromEntries(perLabel.map((r) => [r.labelId, Number(r.n)])),
  };
};

/** The newest unread conversation in the inbox, for the tab's notification of new mail. */
export const newestUnread = async (db: Database, userId: string) => {
  const t = await db.query.threads.findFirst({
    where: and(
      eq(threads.userId, userId),
      conditionSql(COUNTED.inboxUnread, userId)
    ),
    orderBy: [desc(threads.lastMessageAt)],
  });

  if (!t) {
    return null;
  }

  return {
    id: t.id,
    subject: t.subject,
    participants: parseJsonAddresses(t.participantsJson),
    lastMessageAt: t.lastMessageAt,
  };
};

/** The labels on each of the given threads, for the list rows and the thread header. */
export const labelsForThreads = async (
  db: Database,
  userId: string,
  ids: string[]
): Promise<Map<string, LabelRef[]>> => {
  const map = new Map<string, LabelRef[]>();

  if (!ids.length) {
    return map;
  }

  const rows = await db
    .select({
      threadId: threadLabels.threadId,
      id: labels.id,
      name: labels.name,
      color: labels.color,
    })
    .from(threadLabels)
    .innerJoin(labels, eq(labels.id, threadLabels.labelId))
    .where(
      and(eq(threadLabels.userId, userId), inIds(threadLabels.threadId, ids))
    )
    .orderBy(asc(labels.name));

  for (const r of rows) {
    const list = map.get(r.threadId) ?? [];
    list.push({
      id: r.id,
      name: r.name,
      color: isLabelColor(r.color) ? r.color : "gray",
    });
    map.set(r.threadId, list);
  }

  return map;
};

/** A stored message as the reads show it: its addresses parsed, its files with signed links. */
const messageView = async (
  db: Database,
  env: Env,
  m: Message
): Promise<MessageView> => {
  const files = await db.query.attachments.findMany({
    where: eq(attachments.messageId, m.id),
  });

  const atts: AttachmentView[] = [];

  for (const a of files) {
    atts.push({
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      contentId: a.contentId,
      inline: a.inline,
      // oxlint-disable-next-line eslint/no-await-in-loop -- one message, file or thread at a time: the stored objects go before their rows, so a failure leaves rows that still point at what remains
      url: await signFileUrl(env, a.id),
    });
  }

  return {
    id: m.id,
    direction: m.direction,
    messageId: m.messageId,
    from: { email: m.fromEmail, name: m.fromName },
    to: parseJsonAddresses(m.toJson),
    cc: parseJsonAddresses(m.ccJson),
    bcc: parseJsonAddresses(m.bccJson),
    // SAFETY: `replyTo` is written by `JSON.stringify` of one `Address`.
    replyTo: m.replyTo ? (JSON.parse(m.replyTo) as Address) : null,
    subject: m.subject,
    text: m.text,
    html: m.html,
    date: m.date,
    read: m.read,
    hasRaw: !!m.rawKey,
    deliveryStatus: m.deliveryStatus,
    deliveryError: m.deliveryError,
    unsubscribe: parseJsonUnsubscribe(m.listUnsubscribe),
    spam: parseSpamCheck(m.spamJson),
    pgp: parsePgpStatus(m.pgpJson),
    attachments: atts,
  };
};

/** A thread with its messages oldest first and signed links to their files; null when it is not the owner's. */
export const loadThread = async (
  db: Database,
  env: Env,
  userId: string,
  threadId: string
) => {
  const thread = await db.query.threads.findFirst({
    where: and(eq(threads.id, threadId), eq(threads.userId, userId)),
  });

  if (!thread) {
    return null;
  }

  const rows = await db.query.messages.findMany({
    where: eq(messages.threadId, thread.id),
    orderBy: [asc(messages.date), asc(messages.createdAt)],
  });

  const views: MessageView[] = [];

  for (const m of rows) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one message, file or thread at a time: the stored objects go before their rows, so a failure leaves rows that still point at what remains
    views.push(await messageView(db, env, m));
  }

  const foundLabels = await labelsForThreads(db, userId, [thread.id]);
  const threadLabelList = foundLabels.get(thread.id) ?? [];

  return { thread, messages: views, labels: threadLabelList };
};

/** One message with signed links to its files, as `loadThread` reads it; null when it is not the owner's. */
export const loadMessage = async (
  db: Database,
  env: Env,
  userId: string,
  messageId: string
): Promise<MessageView | null> => {
  const m = await db.query.messages.findFirst({
    where: and(eq(messages.id, messageId), eq(messages.userId, userId)),
  });

  return m ? await messageView(db, env, m) : null;
};

/** Delete a trashed or spam thread with its messages, files and raw copies. Only from there: the UI asks first. */
export const deleteThreadForever = async (
  db: Database,
  env: Env,
  userId: string,
  threadId: string
): Promise<boolean> => {
  const thread = await db.query.threads.findFirst({
    where: and(
      eq(threads.id, threadId),
      eq(threads.userId, userId),
      inArray(threads.folder, [...JUNK])
    ),
  });

  if (!thread) {
    return false;
  }

  const rows = await db.query.messages.findMany({
    where: eq(messages.threadId, thread.id),
  });

  for (const m of rows) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one message, file or thread at a time: the stored objects go before their rows, so a failure leaves rows that still point at what remains
    const files = await db.query.attachments.findMany({
      where: eq(attachments.messageId, m.id),
    });

    for (const a of files) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one message, file or thread at a time: the stored objects go before their rows, so a failure leaves rows that still point at what remains
      await env.MAIL.delete(a.r2Key);
    }

    if (m.rawKey) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one message, file or thread at a time: the stored objects go before their rows, so a failure leaves rows that still point at what remains
      await env.MAIL.delete(m.rawKey);
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- one message, file or thread at a time: the stored objects go before their rows, so a failure leaves rows that still point at what remains
    await db.delete(attachments).where(eq(attachments.messageId, m.id));
  }

  const draftRows = await db.query.drafts.findMany({
    where: eq(drafts.threadId, thread.id),
  });

  for (const d of draftRows) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one message, file or thread at a time: the stored objects go before their rows, so a failure leaves rows that still point at what remains
    const files = await db.query.draftFiles.findMany({
      where: eq(draftFiles.draftId, d.id),
    });

    for (const f of files) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one message, file or thread at a time: the stored objects go before their rows, so a failure leaves rows that still point at what remains
      await env.MAIL.delete(f.r2Key);
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- one message, file or thread at a time: the stored objects go before their rows, so a failure leaves rows that still point at what remains
    await db.delete(draftFiles).where(eq(draftFiles.draftId, d.id));
  }

  await db.delete(drafts).where(eq(drafts.threadId, thread.id));
  await db.delete(threadLabels).where(eq(threadLabels.threadId, thread.id));
  await db.delete(messages).where(eq(messages.threadId, thread.id));
  await db.delete(threads).where(eq(threads.id, thread.id));

  return true;
};

/** Delete for good what has been in the trash or the spam folder for `EXPIRY_DAYS`; a batch at a time. */
export const pruneExpired = async (
  db: Database,
  env: Env,
  userId: string,
  batch = 50
): Promise<number> => {
  const cutoff = new Date(Date.now() - EXPIRY_DAYS * 86_400_000).toISOString();

  const rows = await db.query.threads.findMany({
    where: and(
      eq(threads.userId, userId),
      inArray(threads.folder, [...JUNK]),
      or(
        lt(threads.trashedAt, cutoff),
        and(isNull(threads.trashedAt), lt(threads.lastMessageAt, cutoff))
      )
    ),
    limit: batch,
  });

  let n = 0;

  for (const t of rows) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one message, file or thread at a time: the stored objects go before their rows, so a failure leaves rows that still point at what remains
    if (await deleteThreadForever(db, env, userId, t.id)) {
      n += 1;
    }
  }

  return n;
};

/** Empty the trash or the spam folder: everything in it deleted for good. */
export const emptyFolder = async (
  db: Database,
  env: Env,
  userId: string,
  folder: "trash" | "spam"
): Promise<number> => {
  let n = 0;

  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one message, file or thread at a time: the stored objects go before their rows, so a failure leaves rows that still point at what remains
    const rows = await db.query.threads.findMany({
      where: and(eq(threads.userId, userId), eq(threads.folder, folder)),
      limit: 100,
    });

    if (!rows.length) {
      return n;
    }

    for (const t of rows) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one message, file or thread at a time: the stored objects go before their rows, so a failure leaves rows that still point at what remains
      if (await deleteThreadForever(db, env, userId, t.id)) {
        n += 1;
      }
    }
  }
};
