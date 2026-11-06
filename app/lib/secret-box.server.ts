/**
 * Secrets kept at rest in D1 (a mail import's OAuth tokens), encrypted with AES-GCM under a key derived from
 * SESSION_SECRET with HKDF. A value is `v1.<iv>.<ciphertext>` in base64url; `purpose` binds it to one use, so a value
 * sealed for one thing never opens as another. Rotating SESSION_SECRET makes every sealed value unreadable: the
 * import that held it asks the person to connect again.
 */
import { base64UrlDecode, base64UrlEncode } from "./crypto";

const key = async (secret: string, purpose: string): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("rivi-workspace/secret-box"),
      info: new TextEncoder().encode(purpose),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
};

export const sealSecret = async (
  env: Env,
  purpose: string,
  plaintext: string
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(env.SESSION_SECRET, purpose),
    new TextEncoder().encode(plaintext)
  );

  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(data)}`;
};

/** What a sealed value holds, or null when it is not one, was sealed for another purpose or under another secret. */
export const openSecret = async (
  env: Env,
  purpose: string,
  sealed: string | null | undefined
): Promise<string | null> => {
  const [version, iv, data] = sealed?.split(".") ?? [];

  if (version !== "v1" || !iv || !data) {
    return null;
  }

  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(iv) },
      await key(env.SESSION_SECRET, purpose),
      base64UrlDecode(data)
    );

    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
};
