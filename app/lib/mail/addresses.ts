import { parseMailAddress } from "@rivi-software/workers-mail/address";

import type { Address } from "~/db/schema";

/** The longest address SMTP carries: a path of 256 octets, its angle brackets included (RFC 5321 4.5.3.1.3). */
const MAX_EMAIL_LENGTH = 254;
const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/u;

/** The length first: `EMAIL` tries every dot of a domain that fails at its end, quadratic in its length (CORE-1294). */
export const isValidEmail = (email: string): boolean => {
  const e = email.trim();

  return e.length <= MAX_EMAIL_LENGTH && EMAIL.test(e);
};

/** `"Jane Doe" <jane@acme.com>`, `Jane Doe <jane@acme.com>` or `jane@acme.com` as a name and a lower-cased address. */
export const parseAddress = (raw: string): Address => {
  const { email, name } = parseMailAddress(raw);

  return { email: email.toLowerCase(), name };
};

/** A To, Cc or Bcc field read: its addresses, and what was typed in it that is not one. */
export interface AddressList {
  addresses: Address[];
  invalid: string[];
}

/**
 * The addresses in a To, Cc or Bcc field as a person types it: separated by commas, semicolons or newlines, a
 * comma inside quotes or angle brackets left alone. Addresses that do not parse are returned under `invalid`.
 */
export const parseAddressList = (raw: string): AddressList => {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;

  for (const ch of raw) {
    if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "<" && !quoted) {
      angle = true;
    } else if (ch === ">" && !quoted) {
      angle = false;
    }

    if ((ch === "," || ch === ";" || ch === "\n") && !quoted && !angle) {
      parts.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  parts.push(current);
  const addresses: Address[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const trimmed = part.trim();

    if (!trimmed) {
      continue;
    }

    const a = parseAddress(trimmed);

    if (!isValidEmail(a.email)) {
      invalid.push(trimmed);
      continue;
    }

    if (seen.has(a.email)) {
      continue;
    }

    seen.add(a.email);
    addresses.push(a);
  }

  return { addresses, invalid };
};

/** An address for a header or a recipient field: the name quoted when it has one. */
export const formatAddress = (a: Address): string => {
  if (!a.name) {
    return a.email;
  }

  const safe = a.name.replaceAll(/["\\]/gu, "");

  return /^[\w .'-]+$/u.test(safe)
    ? `${safe} <${a.email}>`
    : `"${safe}" <${a.email}>`;
};

export const formatAddressList = (list: Address[]): string =>
  list.map(formatAddress).join(", ");

/** The name to show for an address: its display name, else the part before the @. */
export const displayName = (a: Address): string =>
  a.name?.trim() || a.email.split("@")[0];

/** `rik+news@example.com` is delivered to `rik@example.com`: the tag after a plus belongs to the owner. */
export const canonicalAddress = (email: string): string => {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");

  if (at === -1) {
    return e;
  }

  const [local] = e.slice(0, at).split("+");

  return `${local}@${e.slice(at + 1)}`;
};

export const domainOf = (email: string): string => {
  const at = email.lastIndexOf("@");

  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
};

export const parseJsonAddresses = (
  json: string | null | undefined
): Address[] => {
  if (!json) {
    return [];
  }

  try {
    const parsed = JSON.parse(json);

    // SAFETY: the column is written by `JSON.stringify` of an `Address[]`, and an array is all this checks.
    return Array.isArray(parsed) ? (parsed as Address[]) : [];
  } catch {
    return [];
  }
};
