/**
 * What OpenPGP did to a message, as the thread shows it and the API answers it. A plain module: the message card
 * imports these, and the server writes them (`inbound.server.ts`, `outbound.server.ts`) into `messages.pgp_json`.
 */
import { isJsonObject, parseJsonObject, stringOrNull } from "~/lib/guards";

/**
 * How a signature checked out:
 * - `good`: it matches the message, made by a key that names the sender's address;
 * - `bad`: the message changed after it was signed, or the key is expired or revoked (`reason` says which);
 * - `unknown-key`: no key at hand for the sender can check it;
 * - `other-address`: it matches, but its key names other addresses than the sender's.
 */
export const SIGNATURE_STATES = [
  "good",
  "bad",
  "unknown-key",
  "other-address",
] as const;

export type SignatureState = (typeof SIGNATURE_STATES)[number];

/**
 * Where the key that checked a signature came from: a colleague's own key (`workspace`), one the owner imported, an
 * Autocrypt header of the sender's mail, or the sender's domain over WKD.
 */
export const KEY_SOURCES = [
  "workspace",
  "imported",
  "autocrypt",
  "wkd",
] as const;

export type KeySource = (typeof KEY_SOURCES)[number];

export interface PgpSignature {
  state: SignatureState;
  /** The signing key's id, 16 hex digits: all an unknown key leaves to go on. */
  keyId: string;
  /** The checking key's fingerprint, 40 hex digits; null when no key was at hand. */
  fingerprint: string | null;
  source: KeySource | null;
  /** Why a `bad` signature failed, in OpenPGP.js's words. */
  reason: string | null;
}

export interface PgpStatus {
  /** PGP/MIME (RFC 3156) or a block of armored text in the body ("inline"). */
  format: "mime" | "inline";
  /**
   * Inline only: the blocks are not the whole message. Text around them or a file beside them was neither signed nor
   * encrypted, so the signature and the encryption speak for the blocks alone.
   */
  partial: boolean;
  encrypted: boolean;
  /** Encrypted and opened with the owner's key: the text and files kept are the opened ones. */
  decrypted: boolean;
  /** Why an encrypted message stayed shut. */
  error: string | null;
  signature: PgpSignature | null;
}

const oneOf = <T extends string>(
  known: readonly T[],
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a member of stored JSON is untrusted: only a known value is kept
  value: unknown
): T | null => known.find((k) => k === value) ?? null;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a member of stored JSON is untrusted: it is read key by key
const signatureOf = (v: unknown): PgpSignature | null => {
  if (!isJsonObject(v)) {
    return null;
  }

  const state = oneOf(SIGNATURE_STATES, v.state);
  const keyId = stringOrNull(v.keyId);

  if (!state || !keyId) {
    return null;
  }

  return {
    state,
    keyId,
    fingerprint: stringOrNull(v.fingerprint),
    source: oneOf(KEY_SOURCES, v.source),
    reason: stringOrNull(v.reason),
  };
};

export const parsePgpStatus = (
  json: string | null | undefined
): PgpStatus | null => {
  if (!json) {
    return null;
  }

  const v = parseJsonObject(json);
  const format = oneOf(["mime", "inline"] as const, v.format);

  if (!format) {
    return null;
  }

  return {
    format,
    partial: v.partial === true,
    encrypted: v.encrypted === true,
    decrypted: v.decrypted === true,
    error: stringOrNull(v.error),
    signature: signatureOf(v.signature),
  };
};

/** A fingerprint as people compare them: ten groups of four. */
export const groupedFingerprint = (fingerprint: string): string => {
  const upper = fingerprint.toUpperCase();

  return Array.from({ length: Math.ceil(upper.length / 4) }, (_, i) =>
    upper.slice(i * 4, i * 4 + 4)
  ).join(" ");
};

/** A key id as OpenPGP tools print it. */
export const shortKeyId = (keyId: string): string => `0x${keyId.toUpperCase()}`;

const SOURCE_WORDS: Record<KeySource, string> = {
  workspace: "their key in this workspace",
  imported: "a key you imported",
  autocrypt: "a key from their earlier mail (Autocrypt)",
  wkd: "the key their domain publishes (WKD)",
};

/** Where a key came from, as a sentence's end: "checked with …". */
export const sourceWords = (source: KeySource | null): string =>
  source ? SOURCE_WORDS[source] : "no key";

/** A person's own key, as Settings shows it. */
export interface OwnKeyView {
  fingerprint: string;
  /** The addresses its user IDs name. */
  addresses: string[];
  createdAt: string;
  /** Armored, for download. */
  publicKey: string;
}

/** A correspondent's key, as Settings lists it. */
export interface PeerKeyView {
  address: string;
  fingerprint: string;
  source: Exclude<KeySource, "workspace">;
  preferEncrypt: boolean;
  seenAt: string;
}

/** What the composer needs to offer signing and encryption. */
export interface PgpComposeView {
  /** The owner has a key: they can sign, and encrypt. */
  hasKey: boolean;
  /** Settings → Mail → OpenPGP: sign every message unless the composer says otherwise. */
  signByDefault: boolean;
}
