/**
 * Web Push as an application server sends it, in WebCrypto alone: the message encrypted for one subscription
 * (`aes128gcm`, RFC 8291 over RFC 8188), signed with the workspace's VAPID key (RFC 8292) and posted to the
 * subscription's endpoint (RFC 8030). The push service (the relay, docs/PUSH.md) sees the endpoint, the headers and
 * ciphertext; only the device that made the subscription holds the private key that opens it.
 */
import { base64UrlDecode, base64UrlEncode } from "~/lib/crypto";

const encoder = new TextEncoder();

/** What a subscription gives the sender: where to post, and the keys to encrypt for (base64url). */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** The workspace's VAPID key: the private half signs, the public half (65 raw bytes, base64url) is its `k`. */
export interface VapidKey {
  privateKey: CryptoKey;
  publicKey: string;
}

/** How one push went: delivered, the subscription gone for good (404, 410), or anything else. */
export type PushOutcome = "sent" | "gone" | "failed";

/** One record of `aes128gcm`: the whole message, which a push never exceeds. */
const RECORD_SIZE = 4096;

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
};

const hkdf = async (
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number
): Promise<Uint8Array<ArrayBuffer>> => {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);

  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    bytes * 8
  );

  return new Uint8Array(bits);
};

/** The sender's one-time ECDH key pair; a test passes RFC 8291's, so its example's bytes come out. */
export interface SenderKeys {
  privateKey: CryptoKey;
  publicKey: Uint8Array<ArrayBuffer>;
}

const newSenderKeys = async (): Promise<SenderKeys> => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );

  return {
    privateKey: pair.privateKey,
    publicKey: new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey)
    ),
  };
};

/**
 * `plaintext` encrypted for one subscription (RFC 8291 §3): a fresh ECDH key and salt each time, the content key and
 * nonce from the shared secret and the subscription's auth secret, one record ending in the delimiter `0x02`, behind
 * the `aes128gcm` header (salt, record size, the sender's public key).
 */
export const encryptPush = async (
  plaintext: Uint8Array,
  target: Pick<PushTarget, "p256dh" | "auth">,
  fixed: { salt?: Uint8Array<ArrayBuffer>; sender?: SenderKeys } = {}
): Promise<Uint8Array<ArrayBuffer>> => {
  const receiver = base64UrlDecode(target.p256dh);
  const authSecret = base64UrlDecode(target.auth);
  const sender = fixed.sender ?? (await newSenderKeys());
  const salt = fixed.salt ?? crypto.getRandomValues(new Uint8Array(16));

  const receiverKey = await crypto.subtle.importKey(
    "raw",
    receiver,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: receiverKey },
      sender.privateKey,
      256
    )
  );

  const ikm = await hkdf(
    authSecret,
    shared,
    concat(encoder.encode("WebPush: info\0"), receiver, sender.publicKey),
    32
  );

  const cek = await hkdf(
    salt,
    ikm,
    encoder.encode("Content-Encoding: aes128gcm\0"),
    16
  );

  const nonce = await hkdf(
    salt,
    ikm,
    encoder.encode("Content-Encoding: nonce\0"),
    12
  );

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      concat(plaintext, new Uint8Array([2]))
    )
  );

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = sender.publicKey.length;

  return concat(header, sender.publicKey, ciphertext);
};

/** A VAPID key pair made anew: what the workspace keeps (`vapid.server.ts`). */
export const generateVapidKey = async (): Promise<{
  privateJwk: JsonWebKey;
  publicKey: string;
}> => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );

  return {
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
    publicKey: base64UrlEncode(
      await crypto.subtle.exportKey("raw", pair.publicKey)
    ),
  };
};

export const importVapidKey = async (
  privateJwk: JsonWebKey,
  publicKey: string
): Promise<VapidKey> => ({
  privateKey: await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  ),
  publicKey,
});

/** VAPID's token lives twelve hours, inside the 24 RFC 8292 allows, whatever the clocks between say. */
const VAPID_SECONDS = 12 * 60 * 60;

/** `Authorization: vapid t=…, k=…` for a push to `endpoint` (RFC 8292 §3): its origin is the token's audience. */
export const vapidAuthorization = async (
  endpoint: string,
  key: VapidKey,
  subject: string,
  now: number
): Promise<string> => {
  const header = base64UrlEncode(JSON.stringify({ typ: "JWT", alg: "ES256" }));

  const claims = base64UrlEncode(
    JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(now / 1000) + VAPID_SECONDS,
      sub: subject,
    })
  );

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key.privateKey,
    encoder.encode(`${header}.${claims}`)
  );

  return `vapid t=${header}.${claims}.${base64UrlEncode(signature)}, k=${key.publicKey}`;
};

/** What a push says beside its message: how long it may wait, how soon it should go, and what it replaces. */
export interface PushOptions {
  key: VapidKey;
  /** Who sends, for the push service to reach: the workspace's address. */
  subject: string;
  ttl: number;
  urgency: "very-low" | "low" | "normal" | "high";
  /** A newer push of the same topic replaces one not yet shown: at most 32 base64url characters. */
  topic?: string;
  fetch: typeof fetch;
  now: number;
}

/** One message to one subscription. A push service that cannot be reached counts as a push that failed. */
export const sendPush = async (
  target: PushTarget,
  message: string,
  options: PushOptions
): Promise<PushOutcome> => {
  const body = await encryptPush(encoder.encode(message), target);

  const headers = new Headers({
    authorization: await vapidAuthorization(
      target.endpoint,
      options.key,
      options.subject,
      options.now
    ),
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(options.ttl),
    urgency: options.urgency,
  });

  if (options.topic) {
    headers.set("topic", options.topic);
  }

  let response: Response;

  try {
    response = await options.fetch(target.endpoint, {
      method: "POST",
      headers,
      body,
    });
  } catch {
    return "failed";
  }

  // The body is read so the connection is free again; its words are the push service's, not ours to keep.
  await response.body?.cancel();

  if (response.ok) {
    return "sent";
  }

  return response.status === 404 || response.status === 410 ? "gone" : "failed";
};
