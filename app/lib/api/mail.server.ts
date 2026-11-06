import { waitUntil } from "cloudflare:workers";
/**
 * The Mail section of the Workspace API (docs/API.md): the lists, a conversation and its messages' documents, the
 * actions and their undo, the composer's start, sending, drafts, contacts and labels, over the same server modules
 * the console's mail routes and `app/lib/mail/actions.ts` call.
 */
import { and, eq } from "drizzle-orm";

import type { Database } from "~/db";
import { attachments, messages } from "~/db/schema";
import type { Thread } from "~/db/schema";
import { parseAddressList, parseJsonAddresses } from "~/lib/mail/addresses";
import { composeData } from "~/lib/mail/compose.server";
import { searchContacts } from "~/lib/mail/contacts.server";
import { signFileUrl } from "~/lib/mail/files.server";
import { isFolder } from "~/lib/mail/folders";
import type { Folder, LabelRef } from "~/lib/mail/folders";
import { createLabel, listLabels } from "~/lib/mail/labels.server";
import {
  countThreads,
  emptyFolder,
  labelsForThreads,
  listThreads,
  loadThread,
  pruneExpired,
} from "~/lib/mail/mailbox.server";
import type { ListOptions } from "~/lib/mail/mailbox.server";
import { parsePreferences } from "~/lib/mail/preferences";
import { mailDocument, mailReading, sanitizeHtml } from "~/lib/mail/sanitize";
import { listScheduled } from "~/lib/mail/schedule.server";
import {
  checkedRecipients,
  deleteDraft,
  listDrafts,
  saveDraft,
  sendComposed,
} from "~/lib/mail/send.server";
import type { OutgoingFile } from "~/lib/mail/send.server";
import { pruneSpamTokens } from "~/lib/mail/spam.server";
import { participantLabel } from "~/lib/mail/threading";
import {
  applyThreadAction,
  markAllRead,
  markThreadRead,
  undoThreadAction,
  wakeSnoozed,
} from "~/lib/mail/threads.server";
import { isThreadIntent } from "~/lib/mail/views";

import { field, fieldOrNull, idsOf, objectList, readBody } from "./body.server";
import type { JsonBody } from "./body.server";
import { ApiRequestError, json } from "./routing.server";
import type { ApiContext, ApiRoute } from "./routing.server";

const PAGE_SIZES = new Set([25, 50, 100]);

/** The list a request asks for: the folder or label, the search, the page. */
const listRequest = async (
  db: Database,
  context: ApiContext,
  given: { folder?: string | null; label?: string | null; q?: string | null }
) => {
  const { user } = context;
  const prefs = parsePreferences(user.preferencesJson);
  const labels = await listLabels(db, user.id);

  const label = given.label
    ? (labels.find((l) => l.id === given.label) ?? null)
    : null;

  const asked = given.folder ?? undefined;
  let folder: Folder = "inbox";

  if (label) {
    folder = "archive";
  } else if (isFolder(asked)) {
    folder = asked;
  }

  return { prefs, labels, label, folder, q: (given.q ?? "").trim() };
};

const threadRow = (t: Thread, labels: LabelRef[]) => ({
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

const threadView = (t: Thread) => ({
  id: t.id,
  subject: t.subject,
  folder: t.folder,
  starred: t.starred,
  muted: t.muted,
  snoozedUntil: t.snoozedUntil,
  messageCount: t.messageCount,
  unreadCount: t.unreadCount,
  lastMessageAt: t.lastMessageAt,
  participants: parseJsonAddresses(t.participantsJson),
});

/** The links of a message's inline images by their Content-ID. */
const cidLinks = (
  files: { contentId: string | null; url: string }[]
): Map<string, string> => {
  const links = new Map<string, string>();

  for (const a of files) {
    if (a.contentId) {
      links.set(a.contentId, a.url);
    }
  }

  return links;
};

const list = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, query } = context;

  const { prefs, labels, label, folder, q } = await listRequest(db, context, {
    folder: query.get("folder"),
    label: query.get("label"),
    q: query.get("q"),
  });

  const page = Math.max(
    1,
    Math.min(10_000, Math.floor(Number(query.get("page")) || 1))
  );

  const askedSize = Number(query.get("pageSize"));

  const pageSize = PAGE_SIZES.has(askedSize) ? askedSize : prefs.pageSize;

  // As the console's list does: snoozed conversations whose time has come return now, and the housekeeping runs a
  // few times a day after the answer.
  await wakeSnoozed(db, new Date(), user.id);
  const pruneKey = `prune:${user.id}`;

  if (!(await env.KV.get(pruneKey))) {
    await env.KV.put(pruneKey, "1", { expirationTtl: 6 * 3600 });
    waitUntil(
      Promise.all([
        pruneExpired(db, env, user.id),
        pruneSpamTokens(db, user.id),
      ])
    );
  }

  const base = { folder, q, page, pageSize, label, labels };

  if ((folder === "drafts" || folder === "scheduled") && !label) {
    const rows =
      folder === "drafts"
        ? await listDrafts(db, user.id)
        : await listScheduled(db, user.id);

    return json({
      ...base,
      total: rows.length,
      threads: [],
      drafts: rows.map((d) => ({
        id: d.id,
        to: participantLabel(parseJsonAddresses(d.toJson)),
        subject: d.subject,
        snippet: d.text.replaceAll(/\s+/gu, " ").trim().slice(0, 120),
        updatedAt: d.updatedAt,
        scheduledAt: d.scheduledAt,
        sendError: d.sendError,
      })),
    });
  }

  const options: ListOptions = { folder, q, label: label?.id ?? null };

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

  return json({
    ...base,
    total,
    drafts: [],
    threads: rows.map((t) => threadRow(t, threadLabels.get(t.id) ?? [])),
  });
};

const thread = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, params, query } = context;
  const loaded = await loadThread(db, env, user.id, params.id ?? "");

  if (!loaded) {
    throw new ApiRequestError("That conversation is not yours.", 404);
  }

  if (query.get("keepUnread") !== "1" && loaded.thread.unreadCount > 0) {
    await markThreadRead(db, user.id, loaded.thread.id);
  }

  return json({
    thread: threadView({
      ...loaded.thread,
      unreadCount:
        query.get("keepUnread") === "1" ? loaded.thread.unreadCount : 0,
    }),
    labels: loaded.labels,
    messages: loaded.messages.map((m) => {
      const links = cidLinks(m.attachments);

      const html = m.html
        ? sanitizeHtml(m.html, { cidUrl: (cid) => links.get(cid) ?? null })
        : null;

      return {
        id: m.id,
        direction: m.direction,
        from: m.from,
        to: m.to,
        cc: m.cc,
        bcc: m.bcc,
        replyTo: m.replyTo,
        subject: m.subject,
        text: m.text,
        hasHtml: html !== null,
        remoteImages: html?.remoteImages ?? false,
        date: m.date,
        read: m.read,
        deliveryStatus: m.deliveryStatus,
        deliveryError: m.deliveryError,
        spam: m.spam !== null,
        attachments: m.attachments,
      };
    }),
  });
};

/** A message's HTML part as a complete document for the app's web view, light or dark, its images held back unless asked for. */
const document = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, params, query } = context;

  const m = await db.query.messages.findFirst({
    where: and(eq(messages.id, params.id ?? ""), eq(messages.userId, user.id)),
  });

  if (!m?.html) {
    throw new ApiRequestError("That message has no HTML part.", 404);
  }

  const files = await db.query.attachments.findMany({
    where: eq(attachments.messageId, m.id),
  });

  const inline: { contentId: string | null; url: string }[] = [];

  for (const a of files) {
    if (a.contentId) {
      inline.push({
        contentId: a.contentId,
        // oxlint-disable-next-line eslint/no-await-in-loop -- one signature at a time, a handful per message
        url: await signFileUrl(env, a.id),
      });
    }
  }

  const links = cidLinks(inline);

  const sanitized = sanitizeHtml(m.html, {
    cidUrl: (cid) => links.get(cid) ?? null,
  });

  const dark = query.get("appearance") === "dark";

  const doc = mailDocument(sanitized.html, {
    // The workspace's own origin: the signed file links the document's CSP lets through.
    origin: new URL(env.APP_URL).origin,
    loadRemoteImages: query.get("images") === "1",
    reading: mailReading(sanitized.html, { dark }),
    viewport: true,
  });

  return new Response(doc, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // The document's own meta policy keeps scripts and forms out; this one stands even where a client ignores it.
      "Content-Security-Policy":
        "script-src 'none'; form-action 'none'; base-uri 'none'",
      "X-Remote-Images": sanitized.remoteImages ? "1" : "0",
    },
  });
};

const act = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, request } = context;
  const body = await readBody(request);
  const intent = field(body, "intent");

  if (!isThreadIntent(intent)) {
    throw new ApiRequestError("Unknown intent.");
  }

  const ids = idsOf(body);

  if (!ids.length) {
    throw new ApiRequestError("Name the conversations.");
  }

  const { undo, count } = await applyThreadAction(db, env, user.id, ids, {
    intent,
    until: fieldOrNull(body, "until"),
    labelId: fieldOrNull(body, "labelId"),
  });

  return json({ ok: true, intent, count, undo });
};

const undo = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, request } = context;
  const body = await readBody(request);

  if (!(await undoThreadAction(db, env, user.id, field(body, "undo")))) {
    throw new ApiRequestError("That cannot be undone any more.");
  }

  return json({ ok: true });
};

const readAll = async (context: ApiContext): Promise<Response> => {
  const { db, request } = context;
  const body = await readBody(request);

  const { label, folder, q } = await listRequest(db, context, {
    folder: fieldOrNull(body, "folder"),
    label: fieldOrNull(body, "label"),
    q: fieldOrNull(body, "q"),
  });

  const count = await markAllRead(db, context.user.id, {
    folder,
    q,
    label: label?.id ?? null,
  });

  return json({ ok: true, count });
};

const empty = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, params } = context;
  const { folder } = params;

  if (folder !== "trash" && folder !== "spam") {
    throw new ApiRequestError("Only the trash and Spam can be emptied.");
  }

  return json({ ok: true, count: await emptyFolder(db, env, user.id, folder) });
};

const compose = async (context: ApiContext): Promise<Response> => {
  const { db, user, query } = context;
  const mode = query.get("mode");

  const data = await composeData(db, user, {
    draft: query.get("draft") ?? undefined,
    reply: query.get("reply") ?? undefined,
    mode:
      mode === "reply" || mode === "all" || mode === "forward"
        ? mode
        : undefined,
    to: query.get("to") ?? undefined,
  });

  return json(data);
};

/** The files a send carries as base64, decoded; a problem for one that is not. */
const filesOf = (body: JsonBody): OutgoingFile[] =>
  objectList(body, "files").map((f) => {
    const filename = field(f, "filename");
    const base64 = field(f, "base64");

    if (!filename || !base64) {
      throw new ApiRequestError("A file needs a filename and its base64.");
    }

    let decoded: string;

    try {
      decoded = atob(base64);
    } catch {
      throw new ApiRequestError(`${filename} is not base64.`);
    }

    const content = new ArrayBuffer(decoded.length);
    const bytes = new Uint8Array(content);

    for (let i = 0; i < decoded.length; i += 1) {
      // `atob` answers one byte per character, so each code point is that byte.
      bytes[i] = decoded.codePointAt(i) ?? 0;
    }

    return {
      filename,
      contentType: field(f, "contentType") || "application/octet-stream",
      content,
    };
  });

/** The To, Cc and Bcc a request names, as typed: what is not an address is kept, for the send to name it. */
const addressLists = (body: JsonBody) => ({
  to: parseAddressList(field(body, "to")),
  cc: parseAddressList(field(body, "cc")),
  bcc: parseAddressList(field(body, "bcc")),
});

/** A draft's recipients, refused by name as a send refuses them when one is not an address. */
const recipients = (body: JsonBody) => checkedRecipients(addressLists(body));

/** The console's send (`sendComposed`): a SendError answers `400` with its words (`problemOf`). */
const send = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, request } = context;
  const body = await readBody(request);

  const sent = await sendComposed(env, db, user, {
    from: (field(body, "from") || user.email).toLowerCase(),
    ...addressLists(body),
    subject: field(body, "subject"),
    text: field(body, "text"),
    inReplyToId: fieldOrNull(body, "inReplyToId"),
    signatureId: fieldOrNull(body, "signatureId"),
    draftId: fieldOrNull(body, "draftId"),
    files: filesOf(body),
  });

  return json({ ok: true, threadId: sent.threadId });
};

const saveDraftRoute = async (context: ApiContext): Promise<Response> => {
  const { db, user, request } = context;
  const body = await readBody(request);
  const { to, cc, bcc } = recipients(body);
  const mode = field(body, "mode");

  const draftId = await saveDraft(db, user.id, {
    id: fieldOrNull(body, "id"),
    threadId: fieldOrNull(body, "threadId"),
    inReplyToId: fieldOrNull(body, "inReplyToId"),
    mode: mode === "reply" || mode === "forward" ? mode : "new",
    from: (field(body, "from") || user.email).toLowerCase(),
    to,
    cc,
    bcc,
    subject: field(body, "subject"),
    text: field(body, "text"),
    signatureId: fieldOrNull(body, "signatureId"),
  });

  return json({ ok: true, draftId, savedAt: new Date().toISOString() });
};

const deleteDraftRoute = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, params } = context;
  await deleteDraft(db, env, user.id, params.id ?? "");

  return json({ ok: true });
};

const contacts = async (context: ApiContext): Promise<Response> => {
  const { db, user, query } = context;

  return json({
    contacts: await searchContacts(db, user.id, query.get("q") ?? ""),
  });
};

const newLabel = async (context: ApiContext): Promise<Response> => {
  const { db, user, request } = context;
  const body = await readBody(request);

  const label = await createLabel(db, user.id, {
    name: field(body, "name"),
    color: fieldOrNull(body, "color"),
  });

  return json({ ok: true, label });
};

export const mailRoutes: ApiRoute[] = [
  { method: "GET", path: "/mail/threads", handler: list },
  { method: "GET", path: "/mail/threads/:id", handler: thread },
  { method: "GET", path: "/mail/messages/:id/document", handler: document },
  { method: "POST", path: "/mail/threads/actions", writes: true, handler: act },
  { method: "POST", path: "/mail/undo", writes: true, handler: undo },
  { method: "POST", path: "/mail/read-all", writes: true, handler: readAll },
  {
    method: "POST",
    path: "/mail/folders/:folder/empty",
    writes: true,
    handler: empty,
  },
  { method: "GET", path: "/mail/compose", handler: compose },
  { method: "POST", path: "/mail/send", writes: true, handler: send },
  {
    method: "POST",
    path: "/mail/drafts",
    writes: true,
    handler: saveDraftRoute,
  },
  {
    method: "DELETE",
    path: "/mail/drafts/:id",
    writes: true,
    handler: deleteDraftRoute,
  },
  { method: "GET", path: "/mail/contacts", handler: contacts },
  { method: "POST", path: "/mail/labels", writes: true, handler: newLabel },
];
