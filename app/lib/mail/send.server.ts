import { sendMail as deliver } from "@rivi-software/workers-mail";
import type { SentMail } from "@rivi-software/workers-mail";
import { and, desc, eq, isNull } from "drizzle-orm";

import type { Database } from "~/db";
import { draftFiles, drafts, messages } from "~/db/schema";
import type { Address, DraftFile, User } from "~/db/schema";

import { newId } from "../ids";
import {
  htmlIsBlank,
  htmlToText,
  outgoingHtml,
  textToHtml,
  textToHtmlBody,
  withSignature,
  withSignatureHtml,
} from "../text";
import { formatAddress } from "./addresses";
import type { AddressList } from "./addresses";
import { fileMessage } from "./filing.server";
import { MAX_HTML, sanitizeHtml, withoutStyles } from "./sanitize";
import { base64Bytes, inlineDataImages } from "./signatures";
import type { InlineImage } from "./signatures";
import { findSignature } from "./signatures.server";
import { normalizeMessageId, replySubject } from "./threading";
import { ownAddresses } from "./threads.server";

/**
 * Email Service takes a message of up to 25 MB and SES one of 40 MB, the base64 encoding counted; a little room is
 * left for the headers and the encoding's growth, so a message SES refuses still fits the binding it falls back on.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const TOO_LARGE =
  "The attachments are too large: 20 MB is the most a message can carry.";

const TOO_LONG =
  "The message is too long to send: shorten it, or send the long part as a file.";

export interface OutgoingFile {
  filename: string;
  contentType: string;
  content: ArrayBuffer;
}

/** A message whose recipients are already addresses, as another module writes one in the owner's name. */
export interface OutgoingMail {
  /** One of the owner's addresses or aliases; the message goes out under the owner's name. */
  from: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  /** The message as plain text, when it was written as such (the HTML part is made from it). */
  text: string;
  /** The message as the rich composer wrote it; when given, the text part is made from it and `text` is unused. */
  html?: string | null;
  /** The owner's message this answers or forwards, for the thread and the threading headers. */
  inReplyToId?: string | null;
  /** One of the owner's signatures, put under the text after a "-- " line; none when null. */
  signatureId?: string | null;
  files: OutgoingFile[];
}

/** What the composer holds, as the console, the API and a scheduled message hand it over. */
export interface ComposedMail {
  /** One of the owner's addresses or aliases; the message goes out under the owner's name. */
  from: string;
  /** The recipients as typed: what is not an address is refused by name, before anything is sent. */
  to: AddressList;
  cc: AddressList;
  bcc: AddressList;
  subject: string;
  text: string;
  html?: string | null;
  inReplyToId?: string | null;
  signatureId?: string | null;
  /** The draft it was written in: its files go with it, and it is gone once the message is sent. */
  draftId?: string | null;
  /** Files sent along besides the draft's, after them. */
  files?: OutgoingFile[];
}

export class SendError extends Error {
  override name = "SendError";
}

/** The addresses a person may send from: their own and their aliases. */
export const sendableAddresses = async (
  db: Database,
  user: User
): Promise<Address[]> =>
  [...(await ownAddresses(db, user))].map((email) => ({
    email,
    name: user.name,
  }));

/**
 * What the rich composer wrote, made safe to send: the same sanitiser as for mail that arrives (no script, no form,
 * no handler, no unsafe URL), the quote never folded, and the style blocks a quoted original brought along dropped.
 */
export const sanitizeOutgoingHtml = (html: string): string =>
  withoutStyles(
    sanitizeHtml(html, {
      cidUrl: () => null,
      forward: true,
    }).html
  );

const base64 = (buf: ArrayBuffer): string => {
  let s = "";
  const bytes = new Uint8Array(buf);

  for (let i = 0; i < bytes.length; i += 0x80_00) {
    s += String.fromCodePoint(...bytes.subarray(i, i + 0x80_00));
  }

  return btoa(s);
};

/** A message's recipients, every one an address. */
interface Recipients {
  to: Address[];
  cc: Address[];
  bcc: Address[];
}

/** The recipients of what the composer holds; anything typed that is not an address is refused by name. */
export const checkedRecipients = (lists: {
  to: AddressList;
  cc: AddressList;
  bcc: AddressList;
}): Recipients => {
  const invalid = [
    ...lists.to.invalid,
    ...lists.cc.invalid,
    ...lists.bcc.invalid,
  ];

  if (invalid.length) {
    throw new SendError(`Check these addresses: ${invalid.join(", ")}`);
  }

  return {
    to: lists.to.addresses,
    cc: lists.cc.addresses,
    bcc: lists.bcc.addresses,
  };
};

/**
 * The checks a message passes first, and what it names: the From with the owner's name, the owner's addresses, the
 * signature and the original it answers. Send later runs these too (`checkComposed`), so a rule added here holds for
 * a scheduled message from the moment it is scheduled.
 */
const prepareMail = async (
  db: Database,
  user: User,
  mail: Omit<OutgoingMail, "subject" | "text" | "html" | "files">
) => {
  const addresses = await sendableAddresses(db, user);
  const allowed = addresses.map((a) => a.email);
  const email = mail.from.toLowerCase();
  const from = addresses.find((a) => a.email === email);

  if (!from) {
    throw new SendError(`You cannot send as ${email}.`);
  }

  if (!mail.to.length && !mail.cc.length && !mail.bcc.length) {
    throw new SendError("Add at least one recipient.");
  }

  const signature = mail.signatureId
    ? await findSignature(db, user.id, mail.signatureId)
    : null;

  if (mail.signatureId && !signature) {
    throw new SendError(
      "The signature you chose no longer exists. Choose another and send again."
    );
  }

  const original = mail.inReplyToId
    ? await db.query.messages.findFirst({
        where: and(
          eq(messages.id, mail.inReplyToId),
          eq(messages.userId, user.id)
        ),
      })
    : null;

  return { from, allowed, signature, original };
};

type Prepared = Awaited<ReturnType<typeof prepareMail>>;

/** The threading headers of a reply, and the References chain it files under. */
const threadingHeaders = (original: Prepared["original"]) => {
  const headers: Record<string, string> = {};

  const references = original
    ? [
        ...(original.referencesHeader?.split(/\s+/u).filter(Boolean) ?? []),
        original.messageId,
      ]
    : [];

  if (original) {
    headers["In-Reply-To"] = original.messageId;
    headers["References"] = references.join(" ");
  }

  return { headers, references };
};

/** The two parts of the message: the text, and the HTML the rich composer wrote or that is made from the text. */
const composeBody = (
  mail: Pick<OutgoingMail, "text" | "html">,
  signature: Prepared["signature"]
) => {
  // The sanitiser reads at most `MAX_HTML` characters, and a message sent cut off is worse than one refused.
  if (mail.html && mail.html.length > MAX_HTML) {
    throw new SendError(TOO_LONG);
  }

  if (mail.html && !htmlIsBlank(mail.html)) {
    const body = sanitizeOutgoingHtml(mail.html);
    const signed = signature ? withSignatureHtml(body, signature) : body;

    return { text: htmlToText(signed), html: outgoingHtml(signed) };
  }

  const text = signature ? withSignature(mail.text, signature.text) : mail.text;

  // An HTML signature still goes out as such under a message written as plain text.
  const html = signature?.html
    ? outgoingHtml(withSignatureHtml(textToHtmlBody(mail.text), signature))
    : textToHtml(text);

  return { text, html };
};

/** The message as it goes out: its subject, its two parts, and the images of its signature it carries inline. */
const composeMessage = (
  env: Env,
  mail: Pick<OutgoingMail, "subject" | "text" | "html">,
  { signature, original }: Prepared
) => {
  const subject =
    mail.subject.trim() ||
    (original ? replySubject(original.subject) : "(no subject)");

  const { text, html: written } = composeBody(mail, signature);

  // The signature's images travel with the message, shown in place by their Content-ID.
  const { html, images } = inlineDataImages(written, env.MAIL_DOMAIN);

  return { subject, text, html, images };
};

const fileBytes = (files: OutgoingFile[]): number =>
  files.reduce((n, f) => n + f.content.byteLength, 0);

/** What a message's files and inline images come to, refused past the most a provider takes. */
const carriedBytes = (files: number, images: InlineImage[]): number => {
  const total = files + images.reduce((n, i) => n + base64Bytes(i.base64), 0);

  if (total > MAX_ATTACHMENT_BYTES) {
    throw new SendError(TOO_LARGE);
  }

  return total;
};

/**
 * The provider's words for a failed send. The failure is an `Error` (the client throws `MailError`), which may carry
 * the provider's `code`.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a catch clause holds whatever was thrown; only `code` and `message` are read
const failureWords = (error: unknown): string => {
  // SAFETY: @rivi-software/workers-mail throws Error subclasses (MailError), whose optional `code` is a string; only `code` and `message` are read.
  const e = error as Error & { code?: string | number };

  return [e.code, e.message].filter(Boolean).join(" ");
};

interface Sent {
  threadId: string;
  messageId: string;
}

/** The send itself, once `prepareMail` has passed the message. */
const sendPrepared = async (
  env: Env,
  db: Database,
  user: User,
  mail: OutgoingMail,
  prepared: Prepared
): Promise<Sent> => {
  const { from, allowed, original } = prepared;
  const { headers, references } = threadingHeaders(original);
  const { subject, text, html, images } = composeMessage(env, mail, prepared);
  const total = carriedBytes(fileBytes(mail.files), images);
  let result: SentMail;

  try {
    result = await deliver(env, {
      from,
      to: mail.to.map(formatAddress),
      cc: mail.cc.map(formatAddress),
      bcc: mail.bcc.map(formatAddress),
      subject,
      text,
      html,
      headers,
      attachments: [
        ...mail.files.map((f) => ({
          disposition: "attachment" as const,
          filename: f.filename,
          type: f.contentType,
          // Local dev cannot serialize ArrayBuffer; base64 strings work everywhere.
          content: base64(f.content),
        })),
        ...images.map((i) => ({
          disposition: "inline" as const,
          contentId: i.contentId,
          filename: i.filename,
          type: i.contentType,
          content: i.base64,
        })),
      ],
    });
  } catch (error) {
    throw new SendError(`The message was not sent: ${failureWords(error)}`);
  }

  // Filed with the Message-ID SES or Email Service gave it, so a reply threads back by In-Reply-To.
  const now = new Date().toISOString();

  const sentMessageId =
    normalizeMessageId(result.messageId) ??
    `<${newId("msg")}@${env.MAIL_DOMAIN}>`;

  const filed = await fileMessage(env, db, user, {
    policy: "sent",
    mail: {
      messageId: sentMessageId,
      inReplyTo: original?.messageId ?? null,
      references,
      from,
      to: mail.to,
      cc: mail.cc,
      bcc: mail.bcc,
      replyTo: null,
      subject,
      text,
      html,
      date: now,
      // Kept as an inbound message's files are, the inline images too, so the sent copy shows its signature.
      attachments: [
        ...mail.files.map((f) => ({
          filename: f.filename,
          mimeType: f.contentType,
          content: new Uint8Array(f.content),
          contentId: null,
          inline: false,
        })),
        ...images.map((i) => ({
          filename: i.filename,
          mimeType: i.contentType,
          content: Uint8Array.from(
            atob(i.base64),
            (c) => c.codePointAt(0) ?? 0
          ),
          contentId: i.contentId,
          inline: true,
        })),
      ],
      size: text.length + total,
      unsubscribe: null,
    },
    raw: null,
    // A conversation the owner starts shows under Sent until someone answers, as in Gmail.
    place: () => ({ folder: "archive" }),
    threadId: original?.threadId ?? null,
    own: new Set(allowed),
  });

  // A message to one of the owner's own addresses that came back before this ran is that message, now sent too
  // (`filed.status` is `duplicate`): its conversation and message either way.
  return { threadId: filed.threadId, messageId: filed.messageId };
};

/**
 * Send a message through `@rivi-software/workers-mail` (Amazon SES, or the Email Service binding until SES is set up and when it
 * refuses the message) and file it in the owner's thread. The provider's Message-ID becomes ours, so a reply threads
 * back by In-Reply-To. A failure throws a SendError with the provider's words and stores nothing: the composer keeps
 * the draft. What the composer holds goes through `sendComposed`, which ends here.
 */
export const sendMail = async (
  env: Env,
  db: Database,
  user: User,
  mail: OutgoingMail
): Promise<Sent> =>
  await sendPrepared(env, db, user, mail, await prepareMail(db, user, mail));

// ---------- drafts ----------

export interface DraftInput {
  id?: string | null;
  threadId?: string | null;
  inReplyToId?: string | null;
  mode: "new" | "reply" | "forward";
  from: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string;
  html?: string | null;
  signatureId?: string | null;
}

export const saveDraft = async (
  db: Database,
  userId: string,
  input: DraftInput
): Promise<string> => {
  // A signature that is not the owner's, or was deleted since the composer opened, is not kept.
  const signature = input.signatureId
    ? await findSignature(db, userId, input.signatureId)
    : undefined;

  const html = input.html && !htmlIsBlank(input.html) ? input.html : null;

  const values = {
    threadId: input.threadId ?? null,
    inReplyToId: input.inReplyToId ?? null,
    mode: input.mode,
    fromEmail: input.from,
    toJson: JSON.stringify(input.to),
    ccJson: JSON.stringify(input.cc),
    bccJson: JSON.stringify(input.bcc),
    subject: input.subject,
    text: html ? htmlToText(html) : input.text,
    html,
    signatureId: signature?.id ?? null,
    updatedAt: new Date().toISOString(),
  };

  if (input.id) {
    const existing = await db.query.drafts.findFirst({
      where: and(eq(drafts.id, input.id), eq(drafts.userId, userId)),
    });

    if (existing) {
      await db.update(drafts).set(values).where(eq(drafts.id, existing.id));

      return existing.id;
    }
  }

  const id = newId("dr");
  await db.insert(drafts).values({ id, userId, ...values });

  return id;
};

/** Delete a draft with the files it kept. */
export const deleteDraft = async (
  db: Database,
  env: Env,
  userId: string,
  id: string
) => {
  const draft = await db.query.drafts.findFirst({
    where: and(eq(drafts.id, id), eq(drafts.userId, userId)),
  });

  if (!draft) {
    return;
  }

  const files = await db.query.draftFiles.findMany({
    where: eq(draftFiles.draftId, draft.id),
  });

  for (const f of files) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- files go to and from storage one at a time, in order
    await env.MAIL.delete(f.r2Key);
  }

  await db.delete(draftFiles).where(eq(draftFiles.draftId, draft.id));
  await db.delete(drafts).where(eq(drafts.id, draft.id));
};

/** The owner's drafts, newest first; the scheduled ones are under Scheduled (`listScheduled`). */
export const listDrafts = async (db: Database, userId: string) =>
  await db.query.drafts.findMany({
    where: and(eq(drafts.userId, userId), isNull(drafts.scheduledAt)),
    orderBy: (d, { desc: d2 }) => [d2(d.updatedAt)],
    limit: 100,
  });

/**
 * The newest draft written in a thread (a reply or forward not yet sent), for the thread page's reply box. A scheduled
 * reply is not one: it waits under Scheduled.
 */
export const draftForThread = async (
  db: Database,
  userId: string,
  threadId: string
) =>
  await db.query.drafts.findFirst({
    where: and(
      eq(drafts.userId, userId),
      eq(drafts.threadId, threadId),
      isNull(drafts.scheduledAt)
    ),
    orderBy: [desc(drafts.updatedAt)],
  });

export const listDraftFiles = async (
  db: Database,
  userId: string,
  draftId: string
): Promise<DraftFile[]> =>
  await db.query.draftFiles.findMany({
    where: and(eq(draftFiles.draftId, draftId), eq(draftFiles.userId, userId)),
    orderBy: (f, { asc }) => [asc(f.createdAt)],
  });

/** Keep files on a draft, in R2, so they survive a reload and go out with the message. */
export const addDraftFiles = async (
  db: Database,
  env: Env,
  userId: string,
  draftId: string,
  files: OutgoingFile[]
): Promise<DraftFile[]> => {
  const draft = await db.query.drafts.findFirst({
    where: and(eq(drafts.id, draftId), eq(drafts.userId, userId)),
  });

  if (!draft) {
    throw new SendError("That draft no longer exists.");
  }

  const kept = await listDraftFiles(db, userId, draftId);
  const have = kept.reduce((n, f) => n + f.size, 0);
  const adding = files.reduce((n, f) => n + f.content.byteLength, 0);

  if (have + adding > MAX_ATTACHMENT_BYTES) {
    throw new SendError(TOO_LARGE);
  }

  const added: DraftFile[] = [];

  for (const f of files) {
    const id = newId("df");
    const r2Key = `draft/${userId}/${id}`;
    // oxlint-disable-next-line eslint/no-await-in-loop -- files go to and from storage one at a time, in order
    await env.MAIL.put(r2Key, f.content, {
      httpMetadata: { contentType: f.contentType },
      customMetadata: { filename: f.filename },
    });

    const row = {
      id,
      draftId,
      userId,
      filename: f.filename,
      contentType: f.contentType,
      size: f.content.byteLength,
      r2Key,
      createdAt: new Date().toISOString(),
    };

    // oxlint-disable-next-line eslint/no-await-in-loop -- files go to and from storage one at a time, in order
    await db.insert(draftFiles).values(row);
    added.push(row);
  }

  return added;
};

export const removeDraftFile = async (
  db: Database,
  env: Env,
  userId: string,
  fileId: string
) => {
  const file = await db.query.draftFiles.findFirst({
    where: and(eq(draftFiles.id, fileId), eq(draftFiles.userId, userId)),
  });

  if (!file) {
    return;
  }

  await env.MAIL.delete(file.r2Key);
  await db.delete(draftFiles).where(eq(draftFiles.id, file.id));
};

/** The files kept on a draft, read back for sending. A file gone from R2 is left out. */
export const draftFilesForSending = async (
  db: Database,
  env: Env,
  userId: string,
  draftId: string
): Promise<OutgoingFile[]> => {
  const out: OutgoingFile[] = [];

  for (const f of await listDraftFiles(db, userId, draftId)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- files go to and from storage one at a time, in order
    const object = await env.MAIL.get(f.r2Key);

    if (!object) {
      continue;
    }

    out.push({
      filename: f.filename,
      contentType: f.contentType,
      // oxlint-disable-next-line eslint/no-await-in-loop -- files go to and from storage one at a time, in order
      content: await object.arrayBuffer(),
    });
  }

  return out;
};

// ---------- what the composer holds ----------

/** What the composer holds as the message `prepareMail` checks, every recipient an address. */
const outgoing = (composed: ComposedMail): Omit<OutgoingMail, "files"> => ({
  from: composed.from,
  ...checkedRecipients(composed),
  subject: composed.subject,
  text: composed.text,
  html: composed.html,
  inReplyToId: composed.inReplyToId,
  signatureId: composed.signatureId,
});

/**
 * Send what the composer holds, from the console, the API or the cron alike: checked first (every address, the From,
 * a recipient, the signature), then sent with the draft's files and the extra ones after them, filed under Sent, and
 * the draft deleted. A refusal or a failure throws a SendError and leaves the draft as it was.
 */
export const sendComposed = async (
  env: Env,
  db: Database,
  user: User,
  composed: ComposedMail
): Promise<Sent> => {
  const { draftId } = composed;
  const mail = outgoing(composed);
  const prepared = await prepareMail(db, user, mail);

  // Read only once the message passed, so a refused send costs no reads from R2.
  const files = [
    ...(draftId ? await draftFilesForSending(db, env, user.id, draftId) : []),
    ...(composed.files ?? []),
  ];

  const sent = await sendPrepared(env, db, user, { ...mail, files }, prepared);

  if (draftId) {
    await deleteDraft(db, env, user.id, draftId);
  }

  return sent;
};

/**
 * What `sendComposed` would refuse before it reaches the provider, refused now: Send later runs it as it schedules a
 * message, so a From, an address, a signature or files a send would refuse never wait for the cron to fail. The
 * draft's files count by the size they were kept at.
 */
export const checkComposed = async (
  env: Env,
  db: Database,
  user: User,
  composed: ComposedMail
): Promise<void> => {
  const mail = outgoing(composed);
  const prepared = await prepareMail(db, user, mail);

  const kept = composed.draftId
    ? await listDraftFiles(db, user.id, composed.draftId)
    : [];

  const { images } = composeMessage(env, mail, prepared);
  carriedBytes(
    kept.reduce((n, f) => n + f.size, 0) + fileBytes(composed.files ?? []),
    images
  );
};
