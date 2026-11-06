import { eq } from "drizzle-orm";
import PostalMime from "postal-mime";

import { createDb } from "~/db";
import type { Database } from "~/db";
import { aliases, messages, users } from "~/db/schema";
import type { Address, User } from "~/db/schema";
import { defined, errorMessage } from "~/lib/guards";

import { htmlToText } from "../text";
import { canonicalAddress, parseAddress } from "./addresses";
import { fileMessage } from "./filing.server";
import { filterOutcome } from "./filters.server";
import { mailSignals } from "./spam";
import type { SpamSignals } from "./spam";
import { judgeMail, trainTokens } from "./spam.server";
import type { Judgement } from "./spam.server";
import { normalizeMessageId, splitReferences } from "./threading";
import { ownAddresses } from "./threads.server";
import { parseListUnsubscribe } from "./unsubscribe";
import type { Unsubscribe } from "./unsubscribe";
import { headerOf, isAutomatedMail, maybeAutoReply } from "./vacation.server";

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  content: Uint8Array;
  contentId: string | null;
  inline: boolean;
}

export interface ParsedMail {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  from: Address;
  to: Address[];
  cc: Address[];
  replyTo: Address | null;
  subject: string;
  text: string;
  html: string | null;
  /** The Date header as ISO when it parses, else the moment of parsing. */
  date: string;
  attachments: ParsedAttachment[];
  size: number;
  /** The sender's ways out of the mailing (List-Unsubscribe), when it names any. */
  unsubscribe: Unsubscribe | null;
  /** Sent by a machine or a list: nothing answers it automatically. */
  automated: boolean;
  /** What the headers tell the spam filter (Cloudflare's checks among them); null for a message without them. */
  signals: SpamSignals | null;
}

/** Where mail that arrives goes: Spam when it was judged spam, else as the filters say (the trash, the archive, the inbox). */
const arrivalFolder = (
  spam: boolean,
  outcome: { trash: boolean; skipInbox: boolean }
): "spam" | "trash" | "archive" | "inbox" => {
  if (spam) {
    return "spam";
  }

  if (outcome.trash) {
    return "trash";
  }

  return outcome.skipInbox ? "archive" : "inbox";
};

const addressesOf = (
  items: { address?: string; name?: string }[] | undefined
): Address[] =>
  (items ?? [])
    .filter((a) => a.address)
    .map((a) => ({
      email: defined(a.address, "the address").toLowerCase(),
      name: a.name || null,
    }));

/**
 * Everything the client keeps of a raw message. `fallbackFrom` is the envelope sender when the headers name none.
 * An import gives a `fallback` Message-ID (a stable one, so a rerun finds the message again) and date (when the
 * source received it) for a message whose headers lack them; mail that arrives gets a random one and now.
 */
export const parseRawEmail = async (
  raw: ArrayBuffer,
  fallbackFrom: string,
  fallback: { messageId?: string; date?: string } = {}
): Promise<ParsedMail> => {
  const parsed = await new PostalMime().parse(raw);
  const html = parsed.html ?? null;
  const text = parsed.text?.trim() || (html ? htmlToText(html) : "");

  const headerDate = parsed.date ? new Date(parsed.date) : null;
  const replyTo = addressesOf(parsed.replyTo)[0] ?? null;

  const from: Address = parsed.from?.address
    ? {
        email: parsed.from.address.toLowerCase(),
        name: parsed.from.name || null,
      }
    : parseAddress(fallbackFrom);

  const headers = parsed.headers ?? [];

  return {
    messageId:
      normalizeMessageId(parsed.messageId) ??
      fallback.messageId ??
      `<${crypto.randomUUID()}@local>`,
    inReplyTo: normalizeMessageId(parsed.inReplyTo),
    references: splitReferences(parsed.references),
    from,
    to: addressesOf(parsed.to),
    cc: addressesOf(parsed.cc),
    replyTo,
    subject: parsed.subject?.trim() || "(no subject)",
    text,
    html,
    date:
      headerDate && !Number.isNaN(headerDate.getTime())
        ? headerDate.toISOString()
        : (fallback.date ?? new Date().toISOString()),
    attachments: (parsed.attachments ?? []).map((a) => ({
      filename: a.filename || "attachment",
      mimeType: a.mimeType || "application/octet-stream",
      content:
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- postal-mime hands over a string for a text attachment and an ArrayBuffer for the rest
        typeof a.content === "string"
          ? new TextEncoder().encode(a.content)
          : new Uint8Array(a.content),
      contentId: a.contentId ? a.contentId.replaceAll(/^<|>$/gu, "") : null,
      inline: a.disposition === "inline" || (!!a.contentId && !a.disposition),
    })),
    size: raw.byteLength,
    unsubscribe: parseListUnsubscribe(
      headerOf(headers, "List-Unsubscribe"),
      headerOf(headers, "List-Unsubscribe-Post")
    ),
    automated: isAutomatedMail(headers, from.email),
    signals: mailSignals(headers),
  };
};

/** The mailbox an address is delivered to: a person's own address or one of their aliases, `+tags` ignored. */
export const resolveMailbox = async (
  db: Database,
  address: string
): Promise<User | null> => {
  const canonical = canonicalAddress(address);

  const direct = await db.query.users.findFirst({
    where: eq(users.email, canonical),
  });

  if (direct) {
    return direct;
  }

  const alias = await db.query.aliases.findFirst({
    where: eq(aliases.address, canonical),
  });

  if (!alias) {
    return null;
  }

  return (
    (await db.query.users.findFirst({ where: eq(users.id, alias.userId) })) ??
    null
  );
};

export type IngestResult =
  | {
      status: "stored";
      threadId: string;
      messageId: string;
      created: boolean;
      /** What the spam filter made of it (`judgeMail`), the words left out. */
      judgement: Omit<Judgement, "tokens">;
    }
  /** The mailbox already holds this Message-ID: a redelivery, or the owner's own copy of a message they sent. */
  | { status: "duplicate"; threadId: string; messageId: string }
  | { status: "no-mailbox" };

/**
 * File a parsed message in the mailbox of `recipient` (the envelope address Email Routing delivered it to), as mail
 * that arrives (`fileMessage`). The owner's filters and the spam filter decide where the thread goes and what marks
 * it; what the spam filter learns from it is learnt once it is filed.
 */
export const ingestInboundEmail = async (
  env: Env,
  raw: ArrayBuffer | null,
  p: ParsedMail,
  recipient: string
): Promise<IngestResult> => {
  const db = createDb(env.DB);
  const user = await resolveMailbox(db, recipient);

  if (!user) {
    return { status: "no-mailbox" };
  }

  // Decided in `place`, once the conversation is known; a duplicate is never judged.
  // SAFETY: `place` assigns it inside a callback, which flow analysis does not follow: a bare `null` would narrow to `never` below.
  let judgement = null as Judgement | null;

  const filed = await fileMessage(env, db, user, {
    policy: "arrival",
    mail: p,
    raw,
    place: async (thread) => {
      const outcome = await filterOutcome(db, user.id, {
        from: p.from,
        to: p.to,
        cc: p.cc,
        subject: p.subject,
        text: p.text,
        hasAttachment: p.attachments.some((a) => !a.inline),
      });

      judgement = await judgeMail(db, user, p, {
        thread,
        filter: outcome,
        mailDomain: env.MAIL_DOMAIN,
      });

      return {
        folder: arrivalFolder(judgement.spam, outcome),
        starred: outcome.star,
        labelIds: outcome.labelIds,
        read: outcome.markRead,
        spam: { check: judgement.check, learned: judgement.learn },
      };
    },
  });

  if (filed.status === "duplicate") {
    return filed;
  }

  const { tokens, ...judged } = defined(judgement, "the judgement");

  if (judged.learn) {
    try {
      await trainTokens(db, user.id, tokens, {
        spam: judged.learn === "spam" ? 1 : 0,
        ham: judged.learn === "ham" ? 1 : 0,
      });
    } catch (error) {
      // What the filter would have learnt is lost; the message is not.
      await db
        .update(messages)
        .set({ spamLearned: null })
        .where(eq(messages.id, filed.messageId));
      console.log(
        JSON.stringify({
          event: "spam.learn_failed",
          user: user.id,
          error: errorMessage(error),
        })
      );
    }
  }

  return {
    status: "stored",
    threadId: filed.threadId,
    messageId: filed.messageId,
    created: filed.created,
    judgement: judged,
  };
};

/** Cloudflare Email Workers entrypoint: one call per envelope recipient. Mail for no mailbox is refused, so the sender learns. */
export const handleInboundEmail = async (
  message: ForwardableEmailMessage,
  env: Env
): Promise<IngestResult> => {
  const raw = await new Response(message.raw).arrayBuffer();
  const parsed = await parseRawEmail(raw, message.from);
  const result = await ingestInboundEmail(env, raw, parsed, message.to);

  if (result.status === "no-mailbox") {
    message.setReject("No such mailbox");
  }

  // Spam gets no automatic reply (its sender is often forged).
  if (result.status === "stored" && !result.judgement.spam) {
    const db = createDb(env.DB);
    const owner = await resolveMailbox(db, message.to);

    // The vacation responder, to a person, never to a machine or a list.
    if (owner && !parsed.automated) {
      await maybeAutoReply(env, owner, await ownAddresses(db, owner), {
        messageId: parsed.messageId,
        references: parsed.references,
        from: parsed.from,
        subject: parsed.subject,
      });
    }
  }

  console.log(
    JSON.stringify({
      event: "email.inbound",
      from: message.from,
      to: message.to,
      status: result.status,
      threadId: result.status === "stored" ? result.threadId : null,
      size: message.rawSize,
      // How the spam filter decided, with the points and the rules that held; never the text.
      spam:
        result.status === "stored"
          ? {
              spam: result.judgement.spam,
              verdict: result.judgement.verdict,
              score: result.judgement.score,
              rules: result.judgement.rules,
            }
          : null,
    })
  );

  return result;
};
