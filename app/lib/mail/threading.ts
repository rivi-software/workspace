/** Email threading helpers (RFC 5322 Message-ID / In-Reply-To / References) and the quoting a reply starts from. */
import type { Address } from "~/db/schema";
import { defined } from "~/lib/guards";

import { displayName, formatAddress } from "./addresses";

export const normalizeMessageId = (
  id: string | null | undefined
): string | null => {
  if (!id) {
    return null;
  }

  const t = id.trim();

  if (!t) {
    return null;
  }

  return t.startsWith("<") ? t : `<${t}>`;
};

export const splitReferences = (
  header: string | null | undefined
): string[] => {
  if (!header) {
    return [];
  }

  return header
    .split(/\s+/u)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) =>
      defined(normalizeMessageId(s), "the result of normalize message id")
    );
};

/** Strip Re:/Fwd: prefixes (and their Dutch, German, French and Scandinavian forms) for subject-based matching. */
export const normalizeSubject = (subject: string | null | undefined): string =>
  (subject ?? "")
    .replace(
      /^(?:\s*(?:re|fwd?|fw|aw|wg|tr|sv|vs|doorst)\s*(?:\[\d+\])?\s*:\s*)+/iu,
      ""
    )
    .replaceAll(/\s+/gu, " ")
    .trim()
    .toLowerCase();

export const replySubject = (subject: string): string =>
  /^\s*re\s*:/iu.test(subject) ? subject.trim() : `Re: ${subject.trim()}`;

export const forwardSubject = (subject: string): string =>
  /^\s*fwd?\s*:/iu.test(subject) ? subject.trim() : `Fwd: ${subject.trim()}`;

/** Whether a subject is a forward's: Fwd:, FW: and the Dutch, German and French forms. */
export const isForwardSubject = (subject: string): boolean =>
  /^\s*(?:fwd?|wg|tr|doorst)\s*(?:\[\d+\])?\s*:/iu.test(subject);

export const makeMessageId = (domain: string): string => {
  const rnd = crypto.randomUUID().replaceAll("-", "");

  return `<${Date.now().toString(36)}.${rnd}@${domain}>`;
};

export interface Quotable {
  date: string;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  text: string;
}

const longDate = (iso: string): string => {
  const d = new Date(iso);

  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      });
};

/** The quoted original under a reply, as Gmail writes it: an attribution line, then every line with `> ` in front. */
export const quoteForReply = (m: Quotable): string => {
  const who = m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email;
  const lines = m.text.replaceAll(/\r\n?/gu, "\n").trimEnd().split("\n");

  return `On ${longDate(m.date)}, ${who} wrote:\n${lines.map((l) => (l.startsWith(">") ? `>${l}` : `> ${l}`)).join("\n")}`;
};

/** The original under a forward: a header block with who wrote it, when and to whom, then the message itself. */
export const quoteForForward = (m: Quotable): string => {
  const head = [
    "---------- Forwarded message ---------",
    `From: ${formatAddress(m.from)}`,
    `Date: ${longDate(m.date)}`,
    `Subject: ${m.subject}`,
    `To: ${m.to.map(formatAddress).join(", ")}`,
    m.cc.length ? `Cc: ${m.cc.map(formatAddress).join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `${head}\n\n${m.text.replaceAll(/\r\n?/gu, "\n").trimEnd()}`;
};

/** Who a reply is addressed to, and who it copies. */
export interface ReplyRecipients {
  to: Address[];
  cc: Address[];
}

/**
 * Who a reply goes to. Reply: the Reply-To or sender, unless that is the owner (a reply to their own mail goes back
 * to its recipients). Reply all adds everyone else on the message, the owner's own addresses left out.
 */
export const replyRecipients = (
  m: { from: Address; replyTo: Address | null; to: Address[]; cc: Address[] },
  own: Set<string>,
  all: boolean
): ReplyRecipients => {
  const mine = (a: Address) => own.has(a.email.toLowerCase());
  const sender = m.replyTo ?? m.from;

  if (mine(m.from) && !m.replyTo) {
    return {
      to: m.to.filter((a) => !mine(a)),
      cc: all ? m.cc.filter((a) => !mine(a)) : [],
    };
  }

  if (!all) {
    return { to: [sender], cc: [] };
  }

  const seen = new Set<string>([sender.email.toLowerCase()]);

  const others = (list: Address[]) =>
    list.filter((a) => {
      const e = a.email.toLowerCase();

      if (mine(a) || seen.has(e)) {
        return false;
      }

      seen.add(e);

      return true;
    });

  return { to: [sender, ...others(m.to)], cc: others(m.cc) };
};

/** A short "Jane, Rik, Bob 3" reading of a thread's participants for the list row. */
export const participantLabel = (list: Address[], max = 3): string => {
  const names = list.map(displayName);

  if (names.length <= max) {
    return names.join(", ");
  }

  return `${names.slice(0, max - 1).join(", ")} … ${names.at(-1)}`;
};
