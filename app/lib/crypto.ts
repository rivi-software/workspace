/**
 * The byte and token primitives the Worker's own links and secrets rest on: base64url (RFC 4648 §5, no padding),
 * random tokens, SHA-256 as hex, PKCE (RFC 7636) and a comparison that does not leak where two strings differ.
 * Everything is WebCrypto, so it runs in the Worker, the tests and a Node script alike.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const base64UrlEncode = (
  input: Uint8Array | ArrayBuffer | string
): string => {
  let bytes: Uint8Array;

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the input is one of three representations by contract: text, bytes or a buffer
  if (typeof input === "string") {
    bytes = encoder.encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    bytes = new Uint8Array(input);
  }

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");
};

export const base64UrlDecode = (input: string): Uint8Array<ArrayBuffer> => {
  const padded = input.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    // atob answers one char per byte (0 to 255), so a code point is that byte; the fallback is unreachable inside the loop bounds.
    out[i] = binary.codePointAt(i) ?? 0;
  }

  return out;
};

export const base64UrlDecodeString = (input: string): string =>
  decoder.decode(base64UrlDecode(input));

/** `bytes` random bytes as base64url: a state, a nonce, a code, a link's token. */
export const randomToken = (bytes = 32): string => {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);

  return base64UrlEncode(out);
};

/** A PKCE code verifier (RFC 7636): 43 unreserved characters from 32 random bytes. */
export const generateCodeVerifier = (): string => randomToken(32);

/** The S256 challenge of a verifier: base64url(SHA-256(verifier)). */
export const codeChallenge = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier)
  );

  return base64UrlEncode(digest);
};

export const sha256Hex = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));

  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
};

/** Equality that does not leak where two strings differ. */
export const constantTimeEqual = (a: string, b: string): boolean => {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  // oxlint-disable-next-line eslint/no-bitwise -- a constant-time comparison is XOR and OR by definition: no branch may depend on where two bytes differ
  let diff = left.length ^ right.length;

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    // oxlint-disable-next-line eslint/no-bitwise -- a constant-time comparison is XOR and OR by definition: no branch may depend on where two bytes differ
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }

  return diff === 0;
};
