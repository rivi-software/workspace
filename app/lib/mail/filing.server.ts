/**
 * Filing a message in a mailbox. Mail that arrives (`ingest.server.ts`), a mailbox's history copied in
 * (`import/import.server.ts`) and the copy of a message the owner sent (`send.server.ts`) all go through
 * `fileMessage`: once per mailbox and Message-ID, in its conversation, the raw message and the files in R2, the
 * conversation placed and labelled, counted again, and the people on it among the contacts. What decides where a
 * message goes (the filters and the spam filter for mail that arrives, the source's folders for an import) stays
 * with the caller and comes in as a `Placement`.
 */
import { and, desc, eq, gte, lte } from "drizzle-orm";

import type { Database } from "~/db";
import { attachments, messages, threads } from "~/db/schema";
import type { Address, Message, Thread, User } from "~/db/schema";

import { newId } from "../ids";
import { snippetOf } from "../text";
import { touchContacts } from "./contacts.server";
import type { ParsedAttachment, ParsedMail } from "./ingest.server";
import { inIds } from "./mailbox.server";
import type { PgpStatus } from "./pgp/pgp";
import type { SpamCheck } from "./spam";
import { normalizeSubject } from "./threading";
import {
  ownAddresses,
  recomputeThread,
  settleThread,
  startThread,
} from "./threads.server";
import type { Asked } from "./threads.server";

/**
 * How a message comes to be filed, which decides what it does to a conversation that exists:
 * - `arrival`, mail that arrives: Spam or the trash takes the conversation there; else it comes back to the inbox
 *   and out of a snooze, as in Gmail, unless it is muted or the placement says `archive`, when it only leaves the
 *   trash or Spam for the archive.
 * - `history`, a message an import copies in: the inbox takes a conversation out of the archive; nothing else moves.
 * - `sent`, the owner's copy of what they sent: the conversation stays where it is and leaves a snooze.
 * Arrival is inbound and history inbound or outbound as its placement says; a send is outbound, and outbound mail
 * is read.
 */
export type FilingPolicy = "arrival" | "history" | "sent";

/** The message as filed: what `parseRawEmail` reads from a raw message, or what a send put together. */
export type FiledMail = Pick<
  ParsedMail,
  | "messageId"
  | "inReplyTo"
  | "references"
  | "from"
  | "to"
  | "cc"
  | "replyTo"
  | "subject"
  | "text"
  | "html"
  | "date"
  | "attachments"
  | "size"
  | "unsubscribe"
> & {
  bcc?: Address[];
  /** What OpenPGP did to it: opened on arrival (`openPgpMail`), or signed and encrypted on its way out. */
  pgp?: PgpStatus | null;
};

/** Where a message puts its conversation and how it marks it and itself. */
export interface Placement {
  /** A new conversation starts here; an existing one moves as the policy says. */
  folder: "inbox" | "archive" | "spam" | "trash";
  starred?: boolean;
  labelIds?: string[];
  read?: boolean;
  /** For `history`: the owner sent it (it came from Sent Items, or from one of their addresses). */
  outbound?: boolean;
  /** For `arrival`: why the spam filter put it in Spam, and what it taught the filter. */
  spam?: { check: SpamCheck | null; learned: "spam" | "ham" | null };
}

export interface Filing {
  policy: FilingPolicy;
  mail: FiledMail;
  /** The raw message, kept in R2 as `raw/<user>/<message>.eml`; null for a send, which has none. */
  raw: ArrayBuffer | null;
  /** Where the message goes, decided once the conversation it joins is known (null: it starts one). */
  place: (thread: Thread | null) => Placement | Promise<Placement>;
  /**
   * The conversation it belongs to, when the caller knows (a send answers a message of it). Without it, mail that
   * arrives and history are threaded by their references and subject (`resolveThread`), and a send starts one.
   */
  threadId?: string | null;
  /** The owner's addresses, left out of the contacts; their mailbox and aliases when not given. */
  own?: Set<string>;
}

export type Filed =
  | { status: "filed"; threadId: string; messageId: string; created: boolean }
  /**
   * The mailbox already held this Message-ID: a redelivery, history copied again, or the owner's own message,
   * which is one message in Inbox and Sent (see `sameMessage`). `messageId` is the row that holds it.
   */
  | { status: "duplicate"; threadId: string; messageId: string };

/**
 * The thread a message belongs to in one mailbox: the one holding a message its In-Reply-To or References name,
 * else, within 14 days of `at`, one with the same subject (prefixes aside) that the sender already takes part in.
 */
const resolveThread = async (
  db: Database,
  userId: string,
  p: FiledMail,
  at: number
) => {
  const ids = [p.inReplyTo, ...p.references].filter((x): x is string => !!x);

  if (ids.length) {
    const hit = await db.query.messages.findFirst({
      where: and(eq(messages.userId, userId), inIds(messages.messageId, ids)),
    });

    if (hit) {
      const t = await db.query.threads.findFirst({
        where: eq(threads.id, hit.threadId),
      });

      if (t) {
        return t;
      }
    }
  }

  const subject = normalizeSubject(p.subject);

  if (!subject) {
    return null;
  }

  const recent = await db.query.threads.findMany({
    where: and(
      eq(threads.userId, userId),
      gte(threads.lastMessageAt, new Date(at - 14 * 86_400_000).toISOString()),
      lte(threads.lastMessageAt, new Date(at + 14 * 86_400_000).toISOString())
    ),
    orderBy: [desc(threads.lastMessageAt)],
    limit: 25,
  });

  return (
    recent.find(
      (t) =>
        normalizeSubject(t.subject) === subject &&
        // SAFETY: `participantsJson` is written by `JSON.stringify` of the conversation's `Address[]`.
        (JSON.parse(t.participantsJson) as Address[]).some(
          (a) => a.email === p.from.email
        )
    ) ?? null
  );
};

/** What the message asks of the conversation it joins, by the policy (see `FilingPolicy`). */
const askedOf = (
  thread: Thread,
  policy: FilingPolicy,
  placement: Placement
): Asked => {
  const starred = !!placement.starred;

  if (policy === "history")
  // A conversation with mail in the source's inbox is in the inbox; one already in the trash or spam stays there.
  {
    return {
      folder:
        placement.folder === "inbox" && thread.folder === "archive"
          ? "inbox"
          : null,
      starred,
    };
  }

  // A reply from the owner un-snoozes the conversation: what they answered is no longer waiting.
  if (policy === "sent") {
    return { unsnooze: true, starred };
  }

  if (placement.folder === "spam" || placement.folder === "trash") {
    return { folder: placement.folder, starred };
  }

  // A muted conversation, or one a filter keeps out, takes its reply where it is; the trash lets go of it.
  if (thread.muted || placement.folder === "archive") {
    return {
      folder:
        thread.folder === "trash" || thread.folder === "spam"
          ? "archive"
          : null,
      starred,
    };
  }

  // A reply brings an archived (or trashed, or snoozed) conversation back to the inbox, as Gmail does.
  return { folder: "inbox", starred };
};

/** A stored message's files, each in R2 under `att/<user>/<id>` with its row (inline images keep their Content-ID). */
export const storeAttachments = async (
  env: Env,
  db: Database,
  userId: string,
  messageId: string,
  files: ParsedAttachment[]
): Promise<void> => {
  for (const a of files) {
    const id = newId("att");
    const key = `att/${userId}/${id}`;
    // oxlint-disable-next-line eslint/no-await-in-loop -- attachments are stored one at a time, in order
    await env.MAIL.put(key, a.content, {
      httpMetadata: { contentType: a.mimeType },
      customMetadata: { filename: a.filename },
    });
    // oxlint-disable-next-line eslint/no-await-in-loop -- attachments are stored one at a time, in order
    await db.insert(attachments).values({
      id,
      messageId,
      userId,
      filename: a.filename,
      contentType: a.mimeType,
      size: a.content.byteLength,
      r2Key: key,
      contentId: a.contentId,
      inline: a.inline,
    });
  }
};

const heldMessage = (db: Database, userId: string, messageId: string) =>
  db.query.messages.findFirst({
    where: and(eq(messages.userId, userId), eq(messages.messageId, messageId)),
  });

const rawKeyOf = (userId: string, messageId: string) =>
  `raw/${userId}/${messageId}.eml`;

const putRaw = async (env: Env, key: string, raw: ArrayBuffer) => {
  await env.MAIL.put(key, raw, {
    httpMetadata: { contentType: "message/rfc822" },
  });
};

/**
 * The mailbox holds this Message-ID already. Mail that arrives again, or history copied again, is a duplicate. The
 * owner's own message is the exception: a message they sent to one of their own addresses comes back through Email
 * Routing within a second, with the Message-ID SES or Email Service gave it, often before the send has filed it.
 * Whichever of the two comes second makes them one message, outbound and read, with the raw copy, in Inbox and Sent
 * as in Gmail: the conversation comes to the inbox and out of a snooze in either order. A raw copy this filing put in
 * R2 is kept on the row when it has none, else removed.
 */
const sameMessage = async (
  env: Env,
  db: Database,
  user: User,
  held: Message,
  filing: Filing,
  uploadedRawKey: string | null
): Promise<Filed> => {
  let { rawKey } = held;

  const ownCopy =
    filing.policy === "sent" ||
    (filing.policy === "arrival" && held.direction === "outbound");

  if (ownCopy) {
    if (!rawKey && filing.raw) {
      rawKey = uploadedRawKey ?? rawKeyOf(held.userId, held.id);

      if (!uploadedRawKey) {
        await putRaw(env, rawKey, filing.raw);
      }
    }

    const ownRow: Partial<typeof messages.$inferInsert> = {
      direction: "outbound",
      read: true,
      deliveryStatus: "sent",
      deliveryError: null,
      rawKey,
    };

    if (filing.policy === "sent") {
      ownRow.bccJson = JSON.stringify(filing.mail.bcc ?? []);
    }

    await db.update(messages).set(ownRow).where(eq(messages.id, held.id));

    const thread = await db.query.threads.findFirst({
      where: eq(threads.id, held.threadId),
    });

    if (thread) {
      await settleThread(db, thread, { folder: "inbox" });
    }

    await recomputeThread(db, held.threadId);

    if (filing.policy === "sent") {
      await touchContacts(
        db,
        user.id,
        [...filing.mail.to, ...filing.mail.cc, ...(filing.mail.bcc ?? [])],
        filing.own ?? (await ownAddresses(db, user)),
        true
      );
    }
  }

  if (uploadedRawKey && rawKey !== uploadedRawKey) {
    await env.MAIL.delete(uploadedRawKey);
  }

  return { status: "duplicate", threadId: held.threadId, messageId: held.id };
};

/** The conversation a filing joins: the one it names, else by its policy (a send starts its own). */
const joinedThread = async (
  db: Database,
  userId: string,
  filing: Filing
): Promise<Thread | null> => {
  const { mail, policy } = filing;

  if (filing.threadId) {
    const named = await db.query.threads.findFirst({
      where: and(eq(threads.id, filing.threadId), eq(threads.userId, userId)),
    });

    return named ?? null;
  }

  if (policy === "sent") {
    return null;
  }

  // Mail that arrives is threaded around now; history around its own date.
  return resolveThread(
    db,
    userId,
    mail,
    policy === "history" ? Date.parse(mail.date) || Date.now() : Date.now()
  );
};

/** The row a filed message takes in `messages`. */
const messageRowOf = (
  id: string,
  user: User,
  threadId: string,
  filing: Filing,
  placement: Placement,
  rawKey: string | null
): typeof messages.$inferInsert => {
  const { mail, policy } = filing;

  const outbound =
    policy === "sent" || (policy === "history" && !!placement.outbound);

  return {
    id,
    threadId,
    userId: user.id,
    direction: outbound ? "outbound" : "inbound",
    messageId: mail.messageId,
    inReplyTo: mail.inReplyTo,
    referencesHeader: mail.references.join(" ") || null,
    fromEmail: mail.from.email,
    fromName: mail.from.name,
    toJson: JSON.stringify(mail.to),
    ccJson: JSON.stringify(mail.cc),
    bccJson: JSON.stringify(mail.bcc ?? []),
    replyTo: mail.replyTo ? JSON.stringify(mail.replyTo) : null,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    snippet: snippetOf(mail.text),
    date: mail.date,
    read: outbound || !!placement.read,
    rawKey,
    size: mail.size,
    deliveryStatus: outbound ? "sent" : "received",
    listUnsubscribe: mail.unsubscribe ? JSON.stringify(mail.unsubscribe) : null,
    spamJson: placement.spam?.check
      ? JSON.stringify(placement.spam.check)
      : null,
    spamLearned: placement.spam?.learned ?? null,
    pgpJson: mail.pgp ? JSON.stringify(mail.pgp) : null,
  };
};

/** File a message in `user`'s mailbox. Throws when the insert fails, after taking back what it wrote for it. */
export const fileMessage = async (
  env: Env,
  db: Database,
  user: User,
  filing: Filing
): Promise<Filed> => {
  const { mail, policy } = filing;
  const held = await heldMessage(db, user.id, mail.messageId);

  if (held) {
    return sameMessage(env, db, user, held, filing, null);
  }

  let thread = await joinedThread(db, user.id, filing);
  const placement = await filing.place(thread);
  const created = !thread;
  thread ??= await startThread(db, user.id, mail.subject, {
    folder: placement.folder,
    starred: !!placement.starred,
  });

  const outbound =
    policy === "sent" || (policy === "history" && !!placement.outbound);

  const id = newId("msg");
  const rawKey = filing.raw ? rawKeyOf(user.id, id) : null;

  if (filing.raw && rawKey) {
    await putRaw(env, rawKey, filing.raw);
  }

  let inserted: { id: string }[];

  try {
    inserted = await db
      .insert(messages)
      .values(messageRowOf(id, user, thread.id, filing, placement, rawKey))
      // Filed by another call since the check above: a redelivery, or the owner's copy racing their send.
      .onConflictDoNothing()
      .returning({ id: messages.id });
  } catch (error) {
    if (rawKey) {
      await env.MAIL.delete(rawKey);
    }

    // A conversation made for this message and left empty is removed by the recount.
    if (created) {
      await recomputeThread(db, thread.id);
    }

    throw error;
  }

  if (!inserted.length) {
    if (created) {
      await recomputeThread(db, thread.id);
    }

    const same = await heldMessage(db, user.id, mail.messageId);

    if (!same) {
      if (rawKey) {
        await env.MAIL.delete(rawKey);
      }

      throw new Error(
        `${mail.messageId} was filed and removed again while this one was filed.`
      );
    }

    return sameMessage(env, db, user, same, filing, rawKey);
  }

  await storeAttachments(env, db, user.id, id, mail.attachments);
  const asked: Asked = created ? {} : askedOf(thread, policy, placement);

  await settleThread(db, thread, { ...asked, labelIds: placement.labelIds });
  await recomputeThread(db, thread.id);

  // Spam keeps out of the contacts; the people the owner sent to are people they wrote to.
  if (placement.folder !== "spam") {
    await touchContacts(
      db,
      user.id,
      outbound
        ? [...mail.to, ...mail.cc, ...(mail.bcc ?? [])]
        : [mail.from, ...mail.to, ...mail.cc],
      filing.own ?? (await ownAddresses(db, user)),
      outbound
    );
  }

  return { status: "filed", threadId: thread.id, messageId: id, created };
};
