import { and, eq } from "drizzle-orm";

import type { Database } from "~/db";
import { drafts, messages, threads } from "~/db/schema";
import type { Address, Message, User } from "~/db/schema";

import { quoteHtmlForForward, quoteHtmlForReply } from "../text";
import { formatAddressList, parseJsonAddresses } from "./addresses";
import { listImageSenders, loadsImages } from "./images.server";
import { parsePreferences } from "./preferences";
import { sanitizeHtml } from "./sanitize";
import { listDraftFiles, sendableAddresses } from "./send.server";
import { listSignatures } from "./signatures.server";
import {
  forwardSubject,
  quoteForForward,
  quoteForReply,
  replyRecipients,
  replySubject,
} from "./threading";

export interface DraftFileView {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

/** What the composer starts from: a blank message, a draft, or a reply or forward of one of the owner's messages. */
export interface Prefill {
  draftId: string | null;
  threadId: string | null;
  inReplyToId: string | null;
  mode: "new" | "reply" | "forward";
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  /** The plain-text start (the quoted original with `> `), for a client without the rich editor. */
  text: string;
  /** The rich composer's start: empty, the draft's markup, or the quoted original in a blockquote. */
  html: string;
  signatureId: string | null;
  files: DraftFileView[];
}

export interface ComposeData {
  froms: Address[];
  signatures: { id: string; name: string; text: string; html: string | null }[];
  prefill: Prefill;
  undoSendSeconds: number;
}

export interface ComposeParams {
  draft?: string;
  reply?: string;
  mode?: "reply" | "all" | "forward";
  to?: string;
}

export class ComposeNotFoundError extends Error {
  override name = "ComposeNotFoundError";
}

export { ComposeNotFoundError as ComposeNotFound };

/**
 * The original's markup for a quote: sanitised, never folded, its style blocks dropped. The composer shows it in the
 * console's own document, where no CSP holds an image back, so its images from the web wait in `data-held-`
 * attributes unless opening the original loads them (`loadsImages`): a tracking pixel would otherwise tell the sender
 * it was answered, and from where. Sending puts them back (`sanitizeOutgoingHtml`).
 */
const quotableHtml = async (
  db: Database,
  user: User,
  m: Pick<Message, "html" | "direction" | "fromEmail" | "threadId">
): Promise<string | null> => {
  if (!m.html) {
    return null;
  }

  const [senders, thread] = await Promise.all([
    listImageSenders(db, user.id),
    db.query.threads.findFirst({
      where: and(eq(threads.id, m.threadId), eq(threads.userId, user.id)),
      columns: { folder: true },
    }),
  ]);

  const loads =
    !!thread &&
    loadsImages(
      senders,
      { direction: m.direction, from: m.fromEmail },
      thread.folder
    );

  return sanitizeHtml(m.html, {
    cidUrl: () => null,
    forward: true,
    images: loads ? "keep" : "hold",
  }).html;
};

export const composeData = async (
  db: Database,
  user: User,
  params: ComposeParams
): Promise<ComposeData> => {
  const froms = await sendableAddresses(db, user);
  const own = new Set(froms.map((a) => a.email));
  const mine = await listSignatures(db, user.id);

  const signatures = mine.map(({ id, name, text, html }) => ({
    id,
    name,
    text,
    html,
  }));

  const { undoSendSeconds } = parsePreferences(user.preferencesJson);

  const blank: Prefill = {
    draftId: null,
    threadId: null,
    inReplyToId: null,
    mode: "new",
    from: user.email,
    to: params.to ?? "",
    cc: "",
    bcc: "",
    subject: "",
    text: "",
    html: "",
    // A new message starts on the default signature, a reply or forward on the reply default; a draft keeps its own.
    signatureId: mine.find((s) => s.isDefault)?.id ?? null,
    files: [],
  };

  if (params.draft) {
    const d = await db.query.drafts.findFirst({
      where: and(eq(drafts.id, params.draft), eq(drafts.userId, user.id)),
    });

    if (!d) {
      throw new ComposeNotFoundError();
    }

    const draftFiles = await listDraftFiles(db, user.id, d.id);

    const files = draftFiles.map((f) => ({
      id: f.id,
      filename: f.filename,
      contentType: f.contentType,
      size: f.size,
    }));

    return {
      froms,
      signatures,
      undoSendSeconds,
      prefill: {
        draftId: d.id,
        threadId: d.threadId,
        inReplyToId: d.inReplyToId,
        mode: d.mode,
        from: d.fromEmail,
        to: formatAddressList(parseJsonAddresses(d.toJson)),
        cc: formatAddressList(parseJsonAddresses(d.ccJson)),
        bcc: formatAddressList(parseJsonAddresses(d.bccJson)),
        subject: d.subject,
        text: d.text,
        html: d.html ?? "",
        signatureId: d.signatureId,
        files,
      },
    };
  }

  if (params.reply) {
    const m = await db.query.messages.findFirst({
      where: and(eq(messages.id, params.reply), eq(messages.userId, user.id)),
    });

    if (!m) {
      throw new ComposeNotFoundError();
    }

    const original = {
      date: m.date,
      from: { email: m.fromEmail, name: m.fromName },
      // SAFETY: `replyTo` is written by `JSON.stringify` of one `Address`.
      replyTo: m.replyTo ? (JSON.parse(m.replyTo) as Address) : null,
      to: parseJsonAddresses(m.toJson),
      cc: parseJsonAddresses(m.ccJson),
      subject: m.subject,
      text: m.text,
      html: await quotableHtml(db, user, m),
    };

    // Answer from the address the message came to, when it is one of the owner's.
    const cameTo = [...original.to, ...original.cc].find((a) =>
      own.has(a.email)
    )?.email;

    const replySignatureId = mine.find((s) => s.isReplyDefault)?.id ?? null;

    if (params.mode === "forward") {
      return {
        froms,
        signatures,
        undoSendSeconds,
        prefill: {
          ...blank,
          signatureId: replySignatureId,
          threadId: m.threadId,
          inReplyToId: m.id,
          mode: "forward",
          from: cameTo ?? user.email,
          subject: forwardSubject(m.subject),
          text: `\n\n${quoteForForward(original)}`,
          // The rule takes Drizzle's `db.query` for a request's: the quote escapes the headers and
          // carries the sanitised body (`quotableHtml`), and the editor passes it through DOMPurify.
          // nosemgrep: raw-html-format
          html: `<div><br></div><div><br></div>${quoteHtmlForForward(original)}`,
        },
      };
    }

    const { to, cc } = replyRecipients(original, own, params.mode === "all");

    return {
      froms,
      signatures,
      undoSendSeconds,
      prefill: {
        ...blank,
        signatureId: replySignatureId,
        threadId: m.threadId,
        inReplyToId: m.id,
        mode: "reply",
        from: cameTo ?? user.email,
        to: formatAddressList(to),
        cc: formatAddressList(cc),
        subject: replySubject(m.subject),
        text: `\n\n${quoteForReply(original)}`,
        // As the forward's above: escaped headers, the sanitised body, DOMPurify in the editor.
        // nosemgrep: raw-html-format
        html: `<div><br></div><div><br></div>${quoteHtmlForReply(original)}`,
      },
    };
  }

  return { froms, signatures, undoSendSeconds, prefill: blank };
};
