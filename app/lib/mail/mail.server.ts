/**
 * Mail's interface for the rest of the Worker: the Assistant's tools and Drive's signing. A person's conversations
 * found by a search or the people on them, one read as text (its people, each message's own words, the names of its
 * files), one of its files read from the bucket, a draft written for the person on the composer's own start, a
 * message sent in their name, and conversations organised as the list organises them (`organizeConversations`, with
 * its undo), and what the search by meaning reads and reads back. Everything takes the person and answers only from their mailbox, with the same rules as the pages;
 * nothing here signs a URL, and the links are Mail's own (`links.ts`). Callers never read Mail's tables or its bucket.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import type { Database } from "~/db";
import { attachments, messages, threads } from "~/db/schema";
import type { Address, Attachment, Thread, User } from "~/db/schema";

import { htmlToText, ownText, textToEditorHtml } from "../text";
import {
  formatAddressList,
  parseAddressList,
  parseJsonAddresses,
} from "./addresses";
import { composeData } from "./compose.server";
import type { Prefill } from "./compose.server";
import type { Folder } from "./folders";
import { listLabels } from "./labels.server";
import { draftHref, threadHref } from "./links";
import { inIds, labelsForThreads, listThreads } from "./mailbox.server";
import { saveDraft, sendMail } from "./send.server";
import type { OutgoingFile } from "./send.server";
import {
  ThreadActionError,
  applyThreadAction,
  undoThreadAction,
} from "./threads.server";

/* ---------- finding conversations ---------- */

export interface ConversationSummary {
  id: string;
  subject: string;
  /** Everyone on it but the person. */
  people: Address[];
  snippet: string;
  lastMessageAt: string;
  messageCount: number;
  unreadCount: number;
  starred: boolean;
  folder: Thread["folder"];
  link: string;
}

const summaryOf = (t: Thread): ConversationSummary => ({
  id: t.id,
  subject: t.subject,
  people: parseJsonAddresses(t.participantsJson),
  snippet: t.snippet,
  lastMessageAt: t.lastMessageAt,
  messageCount: t.messageCount,
  unreadCount: t.unreadCount,
  starred: t.starred,
  folder: t.folder,
  link: threadHref(t.id),
});

/**
 * The person's conversations in a view (`archive` is All mail: everything but spam and the trash), newest first, as
 * the list finds them: `q` in the search box's language, `with` only those with one of these addresses among their
 * people.
 */
export const findConversations = async (
  db: Database,
  userId: string,
  options: { folder: Folder; q?: string; with?: string[]; limit: number }
): Promise<ConversationSummary[]> => {
  const people = options.with
    ?.map((a) => a.trim().toLowerCase())
    .filter(Boolean);

  if (people && !people.length) {
    return [];
  }

  const rows = await listThreads(db, userId, {
    folder: options.folder,
    q: options.q,
    with: people,
    limit: options.limit,
  });

  return rows.map(summaryOf);
};

/* ---------- reading one ---------- */

const ownThread = async (
  db: Database,
  userId: string,
  threadId: string
): Promise<Thread | null> =>
  (await db.query.threads.findFirst({
    where: and(eq(threads.id, threadId), eq(threads.userId, userId)),
  })) ?? null;

/** A thread's messages, oldest first, with their files: one query each, whatever the length of the thread. */
const messagesOf = async (db: Database, threadId: string) => {
  const rows = await db.query.messages.findMany({
    where: eq(messages.threadId, threadId),
    orderBy: [asc(messages.date), asc(messages.createdAt)],
  });

  const files = new Map<string, Attachment[]>();

  if (rows.length) {
    const all = await db.query.attachments.findMany({
      where: inIds(
        attachments.messageId,
        rows.map((m) => m.id)
      ),
    });

    for (const a of all) {
      files.set(a.messageId, [...(files.get(a.messageId) ?? []), a]);
    }
  }

  return rows.map((m) => ({ ...m, files: files.get(m.id) ?? [] }));
};

/** A message's files as its page lists them: the images its HTML part shows inline (by Content-ID) aside. */
const listedFiles = (files: Attachment[]): Attachment[] =>
  files.filter((a) => !a.inline || !a.contentId);

export interface ReadMessage {
  id: string;
  direction: "inbound" | "outbound";
  from: Address;
  to: Address[];
  cc: Address[];
  date: string;
  /** Its own words: above the quoted earlier mail and the signature, from the HTML part when it has no text. */
  text: string;
  /** The names of its files. */
  files: string[];
}

export type ReadConversation = ConversationSummary & {
  labels: string[];
  messages: ReadMessage[];
};

/** One of the person's conversations, to read elsewhere: oldest message first, no markup and no file links. */
export const readConversation = async (
  db: Database,
  userId: string,
  threadId: string
): Promise<ReadConversation | null> => {
  const thread = await ownThread(db, userId, threadId);

  if (!thread) {
    return null;
  }

  const rows = await messagesOf(db, thread.id);

  const foundLabels = await labelsForThreads(db, userId, [thread.id]);
  const labels = foundLabels.get(thread.id) ?? [];

  return {
    ...summaryOf(thread),
    labels: labels.map((l) => l.name),
    messages: rows.map((m) => ({
      id: m.id,
      direction: m.direction,
      from: { email: m.fromEmail, name: m.fromName },
      to: parseJsonAddresses(m.toJson),
      cc: parseJsonAddresses(m.ccJson),
      date: m.date,
      text: ownText(m.text || (m.html ? htmlToText(m.html) : "")),
      files: listedFiles(m.files).map((a) => a.filename),
    })),
  };
};

/* ---------- one of its files ---------- */

/** A file of a conversation, to read elsewhere: what it is, and its bytes from the bucket when asked for. */
export interface ConversationFile {
  name: string;
  contentType: string;
  size: number;
  /** The conversation's page, where the person opens the file. */
  link: string;
  /** Its bytes; null when the bucket no longer has them. */
  load: () => Promise<ArrayBuffer | null>;
}

/**
 * The file called `name` in one of the person's conversations, as its page lists its files (an inline image aside):
 * the newest when several messages carry one of that name, whatever the case of its letters. Null when the
 * conversation is not the person's or has no such file.
 */
export const conversationFile = async (
  env: Env,
  db: Database,
  userId: string,
  threadId: string,
  name: string
): Promise<ConversationFile | null> => {
  const thread = await ownThread(db, userId, threadId);

  if (!thread) {
    return null;
  }

  const wanted = name.trim().toLowerCase();
  const rows = await messagesOf(db, thread.id);

  const file = rows
    .toReversed()
    .flatMap((m) => listedFiles(m.files))
    .find((a) => a.filename.toLowerCase() === wanted);

  if (!file) {
    return null;
  }

  return {
    name: file.filename,
    contentType: file.contentType,
    size: file.size,
    link: threadHref(thread.id),
    load: async () => {
      const object = await env.MAIL.get(file.r2Key);

      return object ? await object.arrayBuffer() : null;
    },
  };
};

/* ---------- sending in the person's name ---------- */

export interface PersonMail {
  to: Address[];
  cc?: Address[];
  subject: string;
  /** Plain text; the HTML part is made from it. */
  text: string;
  files?: OutgoingFile[];
}

/**
 * A message another module sends in the person's name (a request for signatures and its signed copy, #2974): from
 * their own address, filed in their Sent, so the answer comes back to them. Throws a `SendError` with the provider's
 * words when it was not sent.
 */
export const sendAsPerson = async (
  env: Env,
  db: Database,
  user: User,
  mail: PersonMail
): Promise<{ threadId: string }> => {
  const { threadId } = await sendMail(env, db, user, {
    from: user.email,
    to: mail.to,
    cc: mail.cc ?? [],
    bcc: [],
    subject: mail.subject,
    text: mail.text,
    files: mail.files ?? [],
  });

  return { threadId };
};

/* ---------- drafts ---------- */

export type DraftRequest =
  /** A reply to one of the person's conversations. */
  | { reply: string; body: string }
  /** A new message: its recipients as addresses or "Name <address>". */
  | { to: string[]; cc?: string[]; subject?: string; body: string };

export type DraftWritten =
  | { ok: true; draftId: string; to: string; subject: string; link: string }
  | { ok: false; error: string };

/** What the composer holds when the person writes `body` at the top of where it started, as its form posts it. */
const written = (prefill: Prefill, body: string) => ({
  threadId: prefill.threadId,
  inReplyToId: prefill.inReplyToId,
  mode: prefill.mode,
  from: prefill.from,
  to: parseAddressList(prefill.to),
  cc: parseAddressList(prefill.cc),
  subject: prefill.subject,
  text: `${body}${prefill.text}`,
  html: `${textToEditorHtml(body)}${prefill.html}`,
  signatureId: prefill.signatureId,
});

/**
 * A draft in the person's Drafts, nothing sent: a reply starts where the composer's reply starts (the last message
 * from someone else answered, or the last one when there is none; its people, the quote, the reply signature), a new
 * message on the default signature, and `body` goes above the quote in the composer's own markup. The person reviews
 * and sends it from the composer (`link`).
 */
export const writeDraft = async (
  db: Database,
  user: User,
  request: DraftRequest
): Promise<DraftWritten> => {
  let draft: ReturnType<typeof written>;

  if ("reply" in request) {
    const thread = await ownThread(db, user.id, request.reply);

    if (!thread) {
      return { ok: false, error: "No such conversation in this mailbox." };
    }

    const rows = await db.query.messages.findMany({
      where: eq(messages.threadId, thread.id),
      orderBy: [asc(messages.date), asc(messages.createdAt)],
      columns: { id: true, direction: true },
    });

    const target =
      rows.toReversed().find((m) => m.direction === "inbound") ?? rows.at(-1);

    if (!target) {
      return { ok: false, error: "The conversation has no message to answer." };
    }

    const { prefill } = await composeData(db, user, {
      reply: target.id,
      mode: "reply",
    });

    draft = written(prefill, request.body);
  } else {
    const to = parseAddressList(request.to.join(", "));
    const cc = parseAddressList((request.cc ?? []).join(", "));
    const invalid = [...to.invalid, ...cc.invalid];

    if (invalid.length) {
      return { ok: false, error: `Not an address: ${invalid.join(", ")}.` };
    }

    if (!to.addresses.length) {
      return { ok: false, error: "A new message needs a recipient." };
    }

    const { prefill } = await composeData(db, user, {});
    draft = {
      ...written(prefill, request.body),
      to,
      cc,
      subject: request.subject ?? "",
    };
  }

  const draftId = await saveDraft(db, user.id, {
    ...draft,
    to: draft.to.addresses,
    cc: draft.cc.addresses,
    bcc: [],
  });

  return {
    ok: true,
    draftId,
    to: formatAddressList(draft.to.addresses),
    subject: draft.subject,
    link: draftHref(draftId),
  };
};

/* ---------- organising conversations ---------- */

/**
 * What a caller outside Mail may do to a person's conversations: the list's own actions that leave everything in
 * the mailbox and can be undone. Not among them, on purpose: deleting for good, muting, and a move into Spam or out
 * of it, from which the spam filter learns what the person themselves thinks of a sender.
 */
export const ORGANIZE_ACTIONS = [
  "archive",
  "inbox",
  "trash",
  "star",
  "unstar",
  "read",
  "unread",
  "snooze",
  "unsnooze",
  "label",
  "unlabel",
] as const;

export type OrganizeAction = (typeof ORGANIZE_ACTIONS)[number];

/** At most this many conversations one call organises: a page of the list. */
export const MAX_ORGANIZED = 100;

export interface OrganizeRequest {
  action: OrganizeAction;
  /** For `snooze`: when the conversations come back. */
  until?: Date;
  /** For `label` and `unlabel`: the label's name, as the person knows it. */
  label?: string;
}

export type Organized =
  | {
      ok: true;
      /** How many conversations it acted on. */
      count: number;
      /** How many of those named sit in Spam, which is left alone. */
      inSpam: number;
      /** How many of those named are not in this mailbox. */
      missing: number;
      /** The label's name as it is written, for `label` and `unlabel`. */
      label?: string;
      /** What `undoOrganized` takes to put everything back; null when nothing changed. */
      undo: string | null;
    }
  | { ok: false; error: string };

/**
 * One action on the person's conversations among `ids`, done as the list does it (`applyThreadAction`), so a snooze
 * leaves the inbox and a move ends a snooze. Conversations in Spam are left where they are and counted.
 */
export const organizeConversations = async (
  db: Database,
  env: Env,
  userId: string,
  ids: string[],
  request: OrganizeRequest,
  now = new Date()
): Promise<Organized> => {
  const wanted = [...new Set(ids)].filter(Boolean);

  if (wanted.length > MAX_ORGANIZED) {
    return {
      ok: false,
      error: `At most ${MAX_ORGANIZED} conversations at a time.`,
    };
  }

  const rows = await db
    .select({ id: threads.id, folder: threads.folder })
    .from(threads)
    .where(and(eq(threads.userId, userId), inIds(threads.id, wanted)));

  const reachable = rows.filter((t) => t.folder !== "spam").map((t) => t.id);
  const inSpam = rows.length - reachable.length;
  const missing = wanted.length - rows.length;
  let labelId: string | undefined;
  let labelName: string | undefined;

  if (request.action === "label" || request.action === "unlabel") {
    const known = await listLabels(db, userId);
    const name = (request.label ?? "").trim().toLowerCase();
    const label = known.find((l) => l.name.toLowerCase() === name);

    if (!label) {
      return {
        ok: false,
        error: known.length
          ? `No label is called “${request.label ?? ""}”. The labels are: ${known.map((l) => l.name).join(", ")}.`
          : "The mailbox has no labels yet; the person makes one in Mail.",
      };
    }

    labelId = label.id;
    labelName = label.name;
  }

  try {
    const { undo, count } = await applyThreadAction(
      db,
      env,
      userId,
      reachable,
      {
        intent: request.action,
        until: request.until?.toISOString(),
        labelId,
      },
      now
    );

    return { ok: true, count, inSpam, missing, label: labelName, undo };
  } catch (error) {
    if (error instanceof ThreadActionError) {
      return { ok: false, error: error.message };
    }

    throw error;
  }
};

/** Put back what `organizeConversations` changed, from its `undo`; false for an undo that is not the person's. */
export const undoOrganized = async (
  db: Database,
  env: Env,
  userId: string,
  undo: string
): Promise<boolean> => await undoThreadAction(db, env, userId, undo);

/* ---------- for the search by meaning ---------- */

/** A conversation the search index reads: whose it is, and when it last changed. */
export interface ChangedConversation {
  id: string;
  userId: string;
  lastMessageAt: string;
}

/**
 * The conversations outside Spam and the trash whose last message is at or after `from` (soonest first), or at or
 * before `until` (latest first): the two walks of the search index (`app/lib/search/indexer.server.ts`).
 * Every mailbox is named, so the search runs on `threads_user_folder_idx` and never scans the table.
 */
export const changedConversations = async (
  db: Database,
  walk: { from: string; limit: number } | { until: string; limit: number }
): Promise<ChangedConversation[]> => {
  const forward = "from" in walk;

  return await db
    .select({
      id: threads.id,
      userId: threads.userId,
      lastMessageAt: threads.lastMessageAt,
    })
    .from(threads)
    .where(
      and(
        sql`${threads.userId} in (select id from users)`,
        inArray(threads.folder, ["inbox", "archive"]),
        forward
          ? gte(threads.lastMessageAt, walk.from)
          : lte(threads.lastMessageAt, walk.until)
      )
    )
    .orderBy(
      forward ? asc(threads.lastMessageAt) : desc(threads.lastMessageAt),
      asc(threads.id)
    )
    .limit(walk.limit);
};

/** Which of these conversations still exist, in any folder: the rest are gone for good. */
export const existingConversations = async (
  db: Database,
  ids: string[]
): Promise<Set<string>> => {
  if (!ids.length) {
    return new Set();
  }

  const rows = await db
    .select({ id: threads.id })
    .from(threads)
    .where(inIds(threads.id, ids));

  return new Set(rows.map((r) => r.id));
};

/**
 * The person's conversations among `ids` that sit outside Spam and the trash, in the order given: what a search by
 * meaning found, read back from the mailbox, which is what decides that the person may see them.
 */
export const conversationsByIds = async (
  db: Database,
  userId: string,
  ids: string[]
): Promise<ConversationSummary[]> => {
  if (!ids.length) {
    return [];
  }

  const rows = await db.query.threads.findMany({
    where: and(
      eq(threads.userId, userId),
      inIds(threads.id, ids),
      inArray(threads.folder, ["inbox", "archive"])
    ),
  });

  const byId = new Map(rows.map((t) => [t.id, t]));

  return ids.flatMap((id) => {
    const thread = byId.get(id);

    return thread ? [summaryOf(thread)] : [];
  });
};
