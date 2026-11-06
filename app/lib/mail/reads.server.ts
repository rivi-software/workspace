/**
 * Mail's two reads, for the console's loaders and the Workspace API alike: a page of a list (`listPage`) and a thread
 * opened (`openThread`), with a message's HTML part made safe the one way both show it (`messageHtml` for the API's
 * document). They sit above `mailbox.server.ts`, which queries, and `threads.server.ts`, which writes: a list wakes
 * the snoozed threads whose time came, and opening a thread reads it. The shapes they answer are in `reads.ts`.
 */
import { waitUntil } from "cloudflare:workers";

import type { Database } from "~/db";
import type { Draft, Thread, User } from "~/db/schema";

import { parseJsonAddresses } from "./addresses";
import { isFolder } from "./folders";
import type { Folder, LabelRef } from "./folders";
import { listImageSenders, loadsImages } from "./images.server";
import { listLabels } from "./labels.server";
import {
  countThreads,
  labelsForThreads,
  listThreads,
  loadMessage,
  loadThread,
  pruneExpired,
} from "./mailbox.server";
import { PAGE_SIZE_CHOICES, parsePreferences } from "./preferences";
import type {
  AttachmentView,
  DraftRow,
  ListRow,
  MailListData,
  MessageData,
  MessageView,
  SenderRuleView,
} from "./reads";
import { sanitizeHtml } from "./sanitize";
import { listScheduled } from "./schedule.server";
import { listDrafts } from "./send.server";
import { senderRuleFor } from "./spam";
import { listSenderRules, pruneSpamTokens } from "./spam.server";
import { isForwardSubject, participantLabel } from "./threading";
import { markThreadRead, wakeSnoozed } from "./threads.server";

/** What a list was asked for, as it came: a query string's values, or the console's search params. */
export interface ListAsked {
  folder?: string | null;
  /** A label's id: its threads, in place of the folder's. */
  label?: string | null;
  q?: string | null;
  page?: string | number | null;
  /** 25, 50 or 100; anything else is the person's preference. */
  pageSize?: string | number | null;
}

/** How long a list waits before it prunes the person's trash and Spam again. */
const PRUNE_EVERY_SECONDS = 6 * 3600;

/**
 * The view a list asks for: a label lists the archive (a label that is not the person's is none), a folder that
 * does not exist the inbox, and the search without the spaces around it.
 */
export const askedView = async (
  db: Database,
  userId: string,
  asked: Pick<ListAsked, "folder" | "label" | "q">
): Promise<{
  folder: Folder;
  label: LabelRef | null;
  labels: LabelRef[];
  q: string;
}> => {
  const labels = await listLabels(db, userId);

  const label = asked.label
    ? (labels.find((l) => l.id === asked.label) ?? null)
    : null;

  const requested = asked.folder ?? undefined;
  let folder: Folder = "inbox";

  if (label) {
    folder = "archive";
  } else if (isFolder(requested)) {
    folder = requested;
  }

  return { folder, label, labels, q: (asked.q ?? "").trim() };
};

const pageOf = (asked: ListAsked["page"]): number =>
  Math.max(1, Math.min(10_000, Math.floor(Number(asked) || 1)));

const pageSizeOf = (asked: ListAsked["pageSize"], preferred: number): number =>
  PAGE_SIZE_CHOICES.find((choice) => choice === Number(asked)) ?? preferred;

/**
 * The trash and Spam shed what is older than 30 days, a batch every few hours, and the spam filter the words that
 * say nothing: after the answer, so the list never waits for it.
 */
const pruneNowAndThen = async (db: Database, env: Env, userId: string) => {
  const key = `prune:${userId}`;

  if (await env.KV.get(key)) {
    return;
  }

  await env.KV.put(key, "1", { expirationTtl: PRUNE_EVERY_SECONDS });
  waitUntil(
    Promise.all([pruneExpired(db, env, userId), pruneSpamTokens(db, userId)])
  );
};

const draftRow = (d: Draft): DraftRow => ({
  id: d.id,
  to: participantLabel(parseJsonAddresses(d.toJson)),
  subject: d.subject,
  snippet: d.text.replaceAll(/\s+/gu, " ").trim().slice(0, 120),
  updatedAt: d.updatedAt,
  scheduledAt: d.scheduledAt,
  sendError: d.sendError,
});

const listRow = (t: Thread, labels: LabelRef[]): ListRow => ({
  id: t.id,
  subject: t.subject,
  snippet: t.snippet,
  people: participantLabel(parseJsonAddresses(t.participantsJson)) || "me",
  count: t.messageCount,
  unread: t.unreadCount > 0,
  starred: t.starred,
  hasAttachments: t.hasAttachments,
  lastMessageAt: t.lastMessageAt,
  folder: t.folder,
  snoozedUntil: t.snoozedUntil,
  muted: t.muted,
  sent: t.sentCount > 0,
  labels,
});

/**
 * One page of a list as the person asked for it: a view or a label, a search over it, the page clamped, the page size
 * theirs unless they asked for another. Drafts and Scheduled list drafts in place of threads. The snoozed threads whose
 * moment has come by `now` return first (the cron wakes every mailbox's each minute; this makes the page exact).
 */
export const listPage = async (
  db: Database,
  env: Env,
  user: Pick<User, "id" | "preferencesJson">,
  asked: ListAsked,
  now = new Date()
): Promise<MailListData> => {
  const { folder, label, labels, q } = await askedView(db, user.id, asked);
  const page = pageOf(asked.page);

  const pageSize = pageSizeOf(
    asked.pageSize,
    parsePreferences(user.preferencesJson).pageSize
  );

  await wakeSnoozed(db, now, user.id);
  await pruneNowAndThen(db, env, user.id);

  const base = { folder, q, page, pageSize, label, labels };

  if ((folder === "drafts" || folder === "scheduled") && !label) {
    const rows =
      folder === "drafts"
        ? await listDrafts(db, user.id)
        : await listScheduled(db, user.id);

    return {
      ...base,
      total: rows.length,
      threads: [],
      drafts: rows.map(draftRow),
    };
  }

  const options = { folder, q, label: label?.id ?? null };

  const [rows, total] = await Promise.all([
    listThreads(db, user.id, {
      ...options,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    countThreads(db, user.id, options),
  ]);

  const threadLabels = await labelsForThreads(
    db,
    user.id,
    rows.map((t) => t.id)
  );

  return {
    ...base,
    total,
    drafts: [],
    threads: rows.map((t) => listRow(t, threadLabels.get(t.id) ?? [])),
  };
};

/** The signed links of a message's inline images by their Content-ID. */
const cidLinks = (files: AttachmentView[]): Map<string, string> => {
  const links = new Map<string, string>();

  for (const a of files) {
    if (a.contentId) {
      links.set(a.contentId, a.url);
    }
  }

  return links;
};

/**
 * A message's HTML part made safe to show, its inline images on their signed links; null when it has none. A forward's
 * quote is the message itself, so it never folds: Outlook's forward looks like its reply, and only the subject tells.
 */
const safeHtml = (m: MessageView) => {
  if (!m.html) {
    return null;
  }

  const links = cidLinks(m.attachments);

  return sanitizeHtml(m.html, {
    cidUrl: (cid) => links.get(cid) ?? null,
    forward: isForwardSubject(m.subject),
  });
};

/** The HTML part of one of the person's messages, made safe as the thread shows it; null without one, or not theirs. */
export const messageHtml = async (
  db: Database,
  env: Env,
  userId: string,
  messageId: string
): Promise<{ html: string; remoteImages: boolean } | null> => {
  const m = await loadMessage(db, env, userId, messageId);

  return m ? safeHtml(m) : null;
};

export interface OpenedThread {
  /** The thread as it stands after opening: read, when it was marked so. */
  thread: Thread;
  labels: LabelRef[];
  /** It had unread messages when it was opened; the messages' own `read` say which. */
  wasUnread: boolean;
  messages: MessageData[];
  /** The owner's rule for each inbound sender, by address; null for a sender with none. */
  senderRules: Record<string, SenderRuleView | null>;
}

/**
 * One of the person's threads opened: marked read (as in every mail client) unless `markRead` is false, each message's
 * HTML made safe, its images loaded at once only from a sender the owner always loads them from and never in Spam,
 * and the owner's rule for each sender. Null when the thread is not theirs.
 */
export const openThread = async (
  db: Database,
  env: Env,
  userId: string,
  threadId: string,
  { markRead = true }: { markRead?: boolean } = {}
): Promise<OpenedThread | null> => {
  const loaded = await loadThread(db, env, userId, threadId);

  if (!loaded) {
    return null;
  }

  const { thread, messages, labels } = loaded;
  const wasUnread = thread.unreadCount > 0;
  const marking = markRead && wasUnread;

  if (marking) {
    await markThreadRead(db, userId, thread.id);
  }

  const [rules, imageSenders] = await Promise.all([
    listSenderRules(db, userId),
    listImageSenders(db, userId),
  ]);

  const senderRules: Record<string, SenderRuleView | null> = {};

  for (const m of messages) {
    if (m.direction === "inbound" && !(m.from.email in senderRules)) {
      const rule = senderRuleFor(rules, m.from.email);
      senderRules[m.from.email] = rule
        ? { sender: rule.sender, verdict: rule.verdict }
        : null;
    }
  }

  return {
    thread: marking ? { ...thread, unreadCount: 0 } : thread,
    labels,
    wasUnread,
    senderRules,
    messages: messages.map((m): MessageData => {
      const safe = safeHtml(m);

      return {
        ...m,
        html: safe?.html ?? null,
        remoteImages: safe?.remoteImages ?? false,
        loadImages:
          m.direction === "inbound" &&
          loadsImages(imageSenders, m.from.email, thread.folder),
        files: m.attachments.filter((a) => !a.inline || !a.contentId),
      };
    }),
  };
};
