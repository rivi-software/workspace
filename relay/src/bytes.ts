/** base64url without padding (RFC 4648 §5), standard base64 and PEM: the encodings Web Push, JWTs and the keys use. */

const encoder = new TextEncoder();

export const utf8 = (text: string): Uint8Array<ArrayBuffer> =>
  encoder.encode(text);

export const base64Encode = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }

  return btoa(binary);
};

export const base64UrlEncode = (input: Uint8Array | ArrayBuffer): string =>
  base64Encode(input instanceof Uint8Array ? input : new Uint8Array(input))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");

/** The bytes of a base64 or base64url string, or null when it is neither. */
export const base64Decode = (input: string): Uint8Array<ArrayBuffer> | null => {
  const standard = input.replaceAll("-", "+").replaceAll("_", "/");

  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(standard)) {
    return null;
  }

  const bare = standard.replace(/[=]+$/u, "");

  try {
    const binary = atob(bare + "=".repeat((4 - (bare.length % 4)) % 4));
    const out = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.codePointAt(i) ?? 0;
    }

    return out;
  } catch {
    return null;
  }
};

/** The DER bytes of a PEM block (a `.p8` key from Apple, a service account's `private_key`). */
export const pemBody = (pem: string): Uint8Array<ArrayBuffer> | null =>
  base64Decode(
    pem
      .replaceAll(String.raw`\n`, "\n")
      .replaceAll(/-----(?:BEGIN|END)[^-]*-----/gu, "")
      .replaceAll(/\s+/gu, "")
  );

export const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
};
