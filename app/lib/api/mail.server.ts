/**
 * The Mail section of the Workspace API (docs/API.md): the lists, a conversation and its messages' documents, the
 * actions and their undo, the composer's start, sending, drafts, contacts and labels, over the same server modules
 * the console's mail routes and `app/lib/mail/actions.ts` call.
 */
import type { Thread } from "~/db/schema";
import { parseAddressList, parseJsonAddresses } from "~/lib/mail/addresses";
import { composeData } from "~/lib/mail/compose.server";
import { searchContacts } from "~/lib/mail/contacts.server";
import { createLabel } from "~/lib/mail/labels.server";
import { emptyFolder } from "~/lib/mail/mailbox.server";
import {
  askedView,
  listPage,
  messageHtml,
  openThread,
} from "~/lib/mail/reads.server";
import { mailDocument, mailReading } from "~/lib/mail/sanitize";
import {
  checkedRecipients,
  deleteDraft,
  saveDraft,
  sendComposed,
} from "~/lib/mail/send.server";
import type { OutgoingFile } from "~/lib/mail/send.server";
import {
  applyThreadAction,
  markAllRead,
  undoThreadAction,
} from "~/lib/mail/threads.server";
import { isThreadIntent } from "~/lib/mail/views";

import { field, fieldOrNull, idsOf, objectList, readBody } from "./body.server";
import type { JsonBody } from "./body.server";
import { ApiRequestError, json } from "./routing.server";
import type { ApiContext, ApiRoute } from "./routing.server";

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

const list = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, query } = context;

  return json(
    await listPage(db, env, user, {
      folder: query.get("folder"),
      label: query.get("label"),
      q: query.get("q"),
      page: query.get("page"),
      pageSize: query.get("pageSize"),
    })
  );
};

const thread = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, params, query } = context;

  const opened = await openThread(db, env, user.id, params.id ?? "", {
    markRead: query.get("keepUnread") !== "1",
  });

  if (!opened) {
    throw new ApiRequestError("That conversation is not yours.", 404);
  }

  return json({
    thread: threadView(opened.thread),
    labels: opened.labels,
    messages: opened.messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      from: m.from,
      to: m.to,
      cc: m.cc,
      bcc: m.bcc,
      replyTo: m.replyTo,
      subject: m.subject,
      text: m.text,
      hasHtml: m.html !== null,
      remoteImages: m.remoteImages,
      loadImages: m.loadImages,
      date: m.date,
      read: m.read,
      deliveryStatus: m.deliveryStatus,
      deliveryError: m.deliveryError,
      spam: m.spam !== null,
      attachments: m.attachments,
    })),
  });
};

/** A message's HTML part as a complete document for the app's web view, light or dark, its images held back unless asked for. */
const document = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, params, query } = context;
  const sanitized = await messageHtml(db, env, user.id, params.id ?? "");

  if (!sanitized) {
    throw new ApiRequestError("That message has no HTML part.", 404);
  }

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

  const { label, folder, q } = await askedView(db, context.user.id, {
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
