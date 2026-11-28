import type { ApnsEnvironment } from "./endpoint";
import { numberOrNull, parseJsonObject, stringOrNull } from "./json";
/**
 * The two gateways the relay delivers through: Apple's (APNs, a provider token signed with the team's `.p8` key) and
 * Google's (FCM HTTP v1, an access token from a service account). Each carries the workspace's encrypted message
 * unopened (`wp`): the app opens it on the device with the keys it gave its workspace, and the relay never can.
 */
import { importPrivateKey, signJwt } from "./jwt";

/** How a gateway took a message: delivered, the device gone for good, slowed down, refused, or not reached. */
export type Outcome = "sent" | "gone" | "throttled" | "refused" | "failed";

/** One push, as the relay hands it on. */
export interface Message {
  /** The workspace's `aes128gcm` body (RFC 8291), base64url. */
  payload: string;
  /** Seconds the gateway may keep it for a device that is off (Web Push's `TTL`). */
  ttl: number;
  /** Web Push's `Urgency`: `very-low` and `low` wait for a good moment, the rest go at once. */
  urgent: boolean;
  /** Web Push's `Topic`: a newer message of the same topic replaces one not yet shown. */
  topic: string | null;
}

/** What the relay was given to reach Apple. */
export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** The `.p8` key's PEM. */
  privateKey: string;
  /** The app's bundle id. */
  topic: string;
  /** The words the notification shows until the app's extension opens the message, or when it cannot. */
  alertTitle: string;
  alertBody: string;
}

/** What the relay was given to reach Google: a service account allowed to send for the Firebase project. */
export interface FcmConfig {
  clientEmail: string;
  privateKey: string;
  projectId: string;
  tokenUri: string;
}

/** A gateway's credential, kept for the isolate's life until it nears its end. */
interface Cached {
  value: string;
  until: number;
}

const apnsTokens = new Map<string, Cached>();
const fcmTokens = new Map<string, Cached>();

/** Apple takes a provider token for an hour and refuses one renewed more often than every 20 minutes: 40 it is. */
const APNS_TOKEN_MS = 40 * 60 * 1000;

const apnsToken = async (config: ApnsConfig, now: number): Promise<string> => {
  const cacheKey = `${config.teamId}/${config.keyId}`;
  const cached = apnsTokens.get(cacheKey);

  if (cached && cached.until > now) {
    return cached.value;
  }

  const value = await signJwt(
    { alg: "ES256", kid: config.keyId },
    { iss: config.teamId, iat: Math.floor(now / 1000) },
    await importPrivateKey(config.privateKey, "ES256")
  );

  apnsTokens.set(cacheKey, { value, until: now + APNS_TOKEN_MS });

  return value;
};

const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  development: "https://api.sandbox.push.apple.com",
};

/** Apple's reasons for a device token that will never take a message again. */
const APNS_GONE = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

export const sendApns = async (
  config: ApnsConfig,
  device: { token: string; environment: ApnsEnvironment },
  message: Message,
  options: { fetch: typeof fetch; now: number }
): Promise<Outcome> => {
  const headers = new Headers({
    authorization: `bearer ${await apnsToken(config, options.now)}`,
    "apns-topic": config.topic,
    "apns-push-type": "alert",
    "apns-priority": message.urgent ? "10" : "5",
    "apns-expiration": String(
      message.ttl === 0 ? 0 : Math.floor(options.now / 1000) + message.ttl
    ),
    "content-type": "application/json",
  });

  if (message.topic) {
    headers.set("apns-collapse-id", message.topic);
  }

  const response = await options.fetch(
    `${APNS_HOSTS[device.environment]}/3/device/${device.token}`,
    {
      method: "POST",
      headers,
      // `mutable-content` wakes the app's notification service extension, which opens `wp` and shows what it says.
      body: JSON.stringify({
        aps: {
          alert: { title: config.alertTitle, body: config.alertBody },
          "mutable-content": 1,
          sound: "default",
        },
        wp: message.payload,
      }),
    }
  );

  if (response.ok) {
    return "sent";
  }

  const reason = stringOrNull(parseJsonObject(await response.text()).reason);

  if (response.status === 410 || (reason && APNS_GONE.has(reason))) {
    return "gone";
  }

  if (response.status === 429) {
    return "throttled";
  }

  // 403 is the relay's own provider token or key: Apple will refuse every message until it is fixed.
  return response.status >= 500 ? "failed" : "refused";
};

const fcmToken = async (
  config: FcmConfig,
  options: { fetch: typeof fetch; now: number }
): Promise<string> => {
  const cached = fcmTokens.get(config.clientEmail);

  if (cached && cached.until > options.now) {
    return cached.value;
  }

  const iat = Math.floor(options.now / 1000);

  const assertion = await signJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: config.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: config.tokenUri,
      iat,
      exp: iat + 3600,
    },
    await importPrivateKey(config.privateKey, "RS256")
  );

  const response = await options.fetch(config.tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const answer = parseJsonObject(await response.text());
  const value = stringOrNull(answer.access_token);

  if (!response.ok || !value) {
    throw new Error(`Google refused the service account (${response.status}).`);
  }

  const seconds = numberOrNull(answer.expires_in) ?? 3600;
  fcmTokens.set(config.clientEmail, {
    value,
    until: options.now + (seconds - 120) * 1000,
  });

  return value;
};

/** The part of an FCM message only Android reads: how soon, how long, and what it replaces. */
interface FcmAndroidConfig {
  priority: "HIGH" | "NORMAL";
  ttl: string;
  collapse_key?: string;
}

/** FCM's error code for a registration token the app no longer holds. */
const FCM_GONE = /\bUNREGISTERED\b/u;

export const sendFcm = async (
  config: FcmConfig,
  device: { token: string },
  message: Message,
  options: { fetch: typeof fetch; now: number }
): Promise<Outcome> => {
  const android: FcmAndroidConfig = {
    priority: message.urgent ? "HIGH" : "NORMAL",
    ttl: `${message.ttl}s`,
  };

  if (message.topic) {
    android.collapse_key = message.topic;
  }

  const response = await options.fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await fcmToken(config, options)}`,
        "content-type": "application/json",
      },
      // A data message alone: the app opens `wp` and shows the notification itself.
      body: JSON.stringify({
        message: {
          token: device.token,
          data: { wp: message.payload },
          android,
        },
      }),
    }
  );

  if (response.ok) {
    return "sent";
  }

  const text = await response.text();

  if (response.status === 404 || FCM_GONE.test(text)) {
    return "gone";
  }

  if (response.status === 429) {
    return "throttled";
  }

  return response.status >= 500 ? "failed" : "refused";
};
