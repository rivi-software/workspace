/**
 * Filters (Settings → Mail): what a rule looks for in a message that arrives, and what it does with the thread.
 * The matching is here, in a plain module, so the settings page can describe a rule and the tests can run one
 * without a mailbox; `filters.server.ts` stores the rules and applies them on ingest.
 */
import type { Address } from "~/db/schema";
import { parseJsonObject } from "~/lib/guards";

export interface FilterConditions {
  /** Any of these (comma-separated) in the sender's address or name. */
  from?: string;
  /** Any of these in a To or Cc address or name. */
  to?: string;
  /** Any of these in the subject. */
  subject?: string;
  /** Every one of these words in the subject or the text. */
  words?: string;
  hasAttachment?: boolean;
}

export interface FilterActions {
  /** The thread goes to All mail, not the inbox (archive). */
  skipInbox?: boolean;
  markRead?: boolean;
  star?: boolean;
  /** One of the owner's labels. */
  labelId?: string | null;
  trash?: boolean;
  spam?: boolean;
  /** The spam filter never sends it to Spam ("Never send it to Spam"); a blocked sender's mail still goes. */
  neverSpam?: boolean;
}

export interface FilterInput {
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  text: string;
  hasAttachment: boolean;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- a key of stored JSON is untrusted: only a string is read, anything else is empty
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export const parseFilterConditions = (
  json: string | null | undefined
): FilterConditions => {
  const raw = parseJsonObject(json);
  const out: FilterConditions = {};

  if (str(raw.from)) {
    out.from = str(raw.from);
  }

  if (str(raw.to)) {
    out.to = str(raw.to);
  }

  if (str(raw.subject)) {
    out.subject = str(raw.subject);
  }

  if (str(raw.words)) {
    out.words = str(raw.words);
  }

  if (raw.hasAttachment === true) {
    out.hasAttachment = true;
  }

  return out;
};

export const parseFilterActions = (
  json: string | null | undefined
): FilterActions => {
  const raw = parseJsonObject(json);
  const out: FilterActions = {};

  if (raw.skipInbox === true) {
    out.skipInbox = true;
  }

  if (raw.markRead === true) {
    out.markRead = true;
  }

  if (raw.star === true) {
    out.star = true;
  }

  if (str(raw.labelId)) {
    out.labelId = str(raw.labelId);
  }

  if (raw.trash === true) {
    out.trash = true;
  }

  if (raw.spam === true) {
    out.spam = true;
  }

  if (raw.neverSpam === true) {
    out.neverSpam = true;
  }

  return out;
};

export const hasConditions = (c: FilterConditions): boolean =>
  !!(c.from || c.to || c.subject || c.words || c.hasAttachment);

export const hasActions = (a: FilterActions): boolean =>
  !!(
    a.skipInbox ||
    a.markRead ||
    a.star ||
    a.labelId ||
    a.trash ||
    a.spam ||
    a.neverSpam
  );

/** `a, b` as the alternatives a field lists; each is matched as a case-insensitive substring. */
const alternatives = (value: string): string[] =>
  value
    .split(/[,;]/u)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const anyIn = (value: string, haystacks: string[]): boolean => {
  const needles = alternatives(value);

  if (!needles.length) {
    return true;
  }

  const lower = haystacks.map((h) => h.toLowerCase());

  return needles.some((n) => lower.some((h) => h.includes(n)));
};

const addressText = (a: Address): string[] => [a.email, a.name ?? ""];

/** Whether a message meets every condition of a rule; a rule without conditions meets nothing. */
export const filterMatches = (c: FilterConditions, m: FilterInput): boolean => {
  if (!hasConditions(c)) {
    return false;
  }

  if (c.from && !anyIn(c.from, addressText(m.from))) {
    return false;
  }

  if (c.to && !anyIn(c.to, [...m.to, ...m.cc].flatMap(addressText))) {
    return false;
  }

  if (c.subject && !anyIn(c.subject, [m.subject])) {
    return false;
  }

  if (c.words) {
    const body = `${m.subject}\n${m.text}`.toLowerCase();
    const words = c.words.toLowerCase().split(/\s+/u).filter(Boolean);

    if (!words.every((w) => body.includes(w))) {
      return false;
    }
  }

  if (c.hasAttachment && !m.hasAttachment) {
    return false;
  }

  return true;
};

/** "From acme.com · subject invoice → skip the inbox, label Finance", for the settings list. */
export const describeFilter = (
  c: FilterConditions,
  a: FilterActions,
  labelName: (id: string) => string | null
) => {
  const when = [
    c.from && `from ${c.from}`,
    c.to && `to ${c.to}`,
    c.subject && `subject has ${c.subject}`,
    c.words && `has the words ${c.words}`,
    c.hasAttachment && "has an attachment",
  ]
    .filter(Boolean)
    .join(" · ");

  const label = a.labelId ? labelName(a.labelId) : null;

  const does = [
    a.spam && "mark as spam",
    a.neverSpam && !a.spam && "never send to spam",
    a.trash && "move to the trash",
    a.skipInbox && !a.trash && !a.spam && "skip the inbox",
    a.markRead && "mark as read",
    a.star && "star",
    a.labelId && `label ${label ?? "(deleted label)"}`,
  ]
    .filter(Boolean)
    .join(", ");

  return { when, does };
};
