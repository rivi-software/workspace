/**
 * Values a cookie or an address can carry that nobody else can make or change: `base64url(json).hmac`, the MAC
 * under `SESSION_SECRET` covering a `purpose` (`sign-in-transaction`, `mail-undo`, `drive-link-pass`, …), so a
 * value sealed for one thing never opens as another under the same secret, whatever fields the two share. The
 * OAuth transaction the Microsoft 365 import keeps between sending the browser away and its return is one.
 */
import {
  base64UrlDecodeString,
  base64UrlEncode,
  codeChallenge,
  constantTimeEqual,
  generateCodeVerifier,
  randomToken,
} from "./crypto";
import { isJsonObject, numberOr, stringOrNull } from "./guards";

/**
 * What a client must remember between sending the browser to an authorization server and its return: the `state`
 * it expects back, the `nonce` an ID token must carry, the PKCE verifier, and where to go afterwards.
 */
export interface SignInTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  next: string;
  issuedAt: number;
}

export const TRANSACTION_MAX_AGE_SECONDS = 10 * 60;
const TRANSACTION_PURPOSE = "sign-in-transaction";

export const createSignInTransaction = async (
  next: string,
  now = Date.now()
): Promise<SignInTransaction & { codeChallenge: string }> => {
  const codeVerifier = generateCodeVerifier();

  return {
    state: randomToken(24),
    nonce: randomToken(24),
    codeVerifier,
    codeChallenge: await codeChallenge(codeVerifier),
    next,
    issuedAt: now,
  };
};

/** The MAC covers the purpose before the payload; the payload is base64url, so the two never run together. */
const mac = async (
  secret: string,
  purpose: string,
  payload: string
): Promise<string> => {
  if (!purpose) {
    throw new Error("A sealed value names its purpose.");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const data = new TextEncoder().encode(`${purpose}.${payload}`);

  return base64UrlEncode(await crypto.subtle.sign("HMAC", key, data));
};

export const seal = async (
  secret: string,
  purpose: string,
  value: { issuedAt: number }
): Promise<string> => {
  const payload = base64UrlEncode(JSON.stringify(value));

  return `${payload}.${await mac(secret, purpose, payload)}`;
};

/**
 * What a sealed value holds, or `null` when it is missing, tampered with, sealed for another purpose or older than
 * `maxAgeSeconds`.
 */
export const openSealed = async <T extends { issuedAt: number }>(
  secret: string,
  purpose: string,
  sealed: string | null | undefined,
  options: { now?: number; maxAgeSeconds?: number } = {}
): Promise<T | null> => {
  if (!sealed) {
    return null;
  }

  const dot = sealed.lastIndexOf(".");

  if (dot <= 0) {
    return null;
  }

  const payload = sealed.slice(0, dot);
  const signature = sealed.slice(dot + 1);

  if (!constantTimeEqual(signature, await mac(secret, purpose, payload))) {
    return null;
  }

  let value: unknown;

  try {
    value = JSON.parse(base64UrlDecodeString(payload));
  } catch {
    return null;
  }

  if (!isJsonObject(value)) {
    return null;
  }

  const issuedAt = numberOr(value.issuedAt, Number.NaN);
  const now = options.now ?? Date.now();
  const maxAge = (options.maxAgeSeconds ?? TRANSACTION_MAX_AGE_SECONDS) * 1000;

  if (
    !Number.isFinite(issuedAt) ||
    issuedAt > now + 60_000 ||
    issuedAt + maxAge < now
  ) {
    return null;
  }

  // SAFETY: the MAC above proves the payload is one `seal` wrote, with this secret and purpose, from a T.
  return value as T;
};

/** The sign-in transaction as a cookie value. */
export const sealTransaction = (
  secret: string,
  tx: SignInTransaction
): Promise<string> => seal(secret, TRANSACTION_PURPOSE, tx);

/** The transaction a sealed value holds, or `null` when it is missing, tampered with or older than `maxAgeSeconds`. */
export const openTransaction = async (
  secret: string,
  sealed: string | null | undefined,
  options: { now?: number; maxAgeSeconds?: number } = {}
): Promise<SignInTransaction | null> => {
  const tx = await openSealed<SignInTransaction>(
    secret,
    TRANSACTION_PURPOSE,
    sealed,
    options
  );

  if (
    !tx ||
    stringOrNull(tx.state) === null ||
    stringOrNull(tx.nonce) === null ||
    stringOrNull(tx.codeVerifier) === null ||
    stringOrNull(tx.next) === null
  ) {
    return null;
  }

  return tx;
};
