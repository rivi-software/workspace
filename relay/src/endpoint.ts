/**
 * A push endpoint is its device, sealed: the platform, the device token, Apple's environment and the workspace's VAPID
 * key, encrypted with AES-GCM under a key from `RELAY_SECRET`. The relay keeps no table, a workspace never learns the
 * device token, and an endpoint pushes only for the workspace whose key it names. Rotating `RELAY_SECRET` makes every
 * endpoint unknown (404), which a workspace reads as a subscription gone; the apps register again on their next start.
 */
import { base64Decode, base64UrlEncode, concat, utf8 } from "./bytes";
import { parseJsonObject, stringOrNull } from "./json";

export type Platform = "apns" | "fcm";

/** Apple's two gateways: a development build's device token is the sandbox's. */
export type ApnsEnvironment = "production" | "development";

export interface Device {
  platform: Platform;
  token: string;
  environment: ApnsEnvironment;
  /** The workspace's VAPID public key, base64url of its 65 raw bytes: only its signature pushes. */
  applicationServerKey: string;
}

/** What an endpoint's last path segment starts with, so a later format can be told apart. */
const VERSION = "v1.";

const sealingKey = async (secret: string): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    "HKDF",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: utf8("rivi-push-relay"),
      info: utf8("endpoint"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
};

export const sealDevice = async (
  secret: string,
  device: Device
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const plain = utf8(
    JSON.stringify({
      p: device.platform,
      t: device.token,
      e: device.environment,
      k: device.applicationServerKey,
    })
  );

  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await sealingKey(secret),
    plain
  );

  return `${VERSION}${base64UrlEncode(concat(iv, new Uint8Array(sealed)))}`;
};

/** The device a sealed segment names, or null when it is not one this relay sealed under its secret. */
export const openDevice = async (
  secret: string,
  segment: string
): Promise<Device | null> => {
  if (!segment.startsWith(VERSION)) {
    return null;
  }

  const bytes = base64Decode(segment.slice(VERSION.length));

  if (!bytes || bytes.length < 13) {
    return null;
  }

  let plain: ArrayBuffer;

  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) },
      await sealingKey(secret),
      bytes.slice(12)
    );
  } catch {
    return null;
  }

  const value = parseJsonObject(new TextDecoder().decode(plain));
  const platform = stringOrNull(value.p);
  const token = stringOrNull(value.t);
  const environment = stringOrNull(value.e);
  const key = stringOrNull(value.k);

  if (
    (platform !== "apns" && platform !== "fcm") ||
    !token ||
    (environment !== "production" && environment !== "development") ||
    !key
  ) {
    return null;
  }

  return { platform, token, environment, applicationServerKey: key };
};
