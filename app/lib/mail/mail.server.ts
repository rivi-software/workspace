/**
 * Mail's interface for the rest of the Worker: the Assistant's tools and Drive's signing. A person's conversations
 * found by a search or the people on them, one read as text (its people, each message's own words, the names of its
 * files), a draft written for the person on the composer's own start, and a message sent in their name. Everything
 * takes the person and answers only from their mailbox, with the same rules as the pages; nothing here signs a URL,
 * and the links are Mail's own (`links.ts`). Callers never read Mail's tables or its bucket.
 */
import { and, asc, eq } from "drizzle-orm";

import type { Database } from "~/db";
import { attachments, messages, threads } from "~/db/schema";
import type { Address, Attachment, Thread, User } from "~/db/schema";

import { htmlToText, linkify, ownText } from "../text";
import {
  formatAddressList,
  parseAddressList,
  parseJsonAddresses,
} from "./addresses";
import { composeData } from "./compose.server";
import type { Prefill } from "./compose.server";
import type { Folder } from "./folders";
import { draftHref, threadHref } from "./links";
import { inIds, labelsForThreads, listThreads } from "./mailbox.server";
import { saveDraft, sendMail } from "./send.server";
import type { OutgoingFile } from "./send.server";

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
    from: { email: user.email, name: user.name },
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

/** Plain text as the markup the rich composer writes: a blank line starts a block, a newline breaks the line. */
const editorHtml = (text: string): string =>
  text
    .replaceAll(/\r\n?/gu, "\n")
    .split(/\n[ \t]*\n/u)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) => `<div>${linkify(p).replaceAll("\n", "<br>")}</div><div><br></div>`
    )
    .join("");

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
  html: `${editorHtml(body)}${prefill.html}`,
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
