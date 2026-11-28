/**
 * The push relay: a Web Push service (RFC 8030) in front of APNs and FCM, for the workspace's own apps. An app gives
 * it its device token and its workspace's VAPID key (`POST /v1/register`) and gets an endpoint back; the app hands
 * that endpoint, with keys of its own, to its workspace as any browser hands a push subscription. The workspace then
 * pushes to the endpoint as Web Push says: the message encrypted for the app (RFC 8291), signed with its VAPID key
 * (RFC 8292). The relay checks the signature, hands the ciphertext on to Apple or Google unopened, and answers what
 * Web Push answers: 201 sent, 404 or 410 a subscription to forget, 429 slow down.
 *
 * Nothing is stored: the endpoint is the device, sealed (`endpoint.ts`). A self-hosted workspace that wants no relay
 * leaves `PUSH_RELAY_URL` empty, and one that wants its own runs this Worker with its own Apple and Google keys.
 */
import { base64Decode, base64UrlEncode } from "./bytes";
import { openDevice, sealDevice } from "./endpoint";
import type { Device, Platform } from "./endpoint";
import { parseJsonObject, stringOrNull } from "./json";
import { importRawPublicKey, verifyEs256 } from "./jwt";
import { sendApns, sendFcm } from "./providers";
import type { ApnsConfig, FcmConfig, Message, Outcome } from "./providers";

/** A Workers rate limiting binding, of which the relay reads the one call. */
export interface RateLimiter {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
}

/** The relay's configuration: its vars, its secrets and its bindings (README). */
export interface RelayEnv {
  /** Required. Seals every endpoint; rotating it forgets every device. */
  RELAY_SECRET: string;
  /** The relay's own origin, the `aud` a VAPID token must name; else the request's. */
  RELAY_URL?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_TOPIC?: string;
  /** The JSON key of a Google service account allowed to send through FCM. */
  FCM_SERVICE_ACCOUNT?: string;
  ALERT_TITLE?: string;
  ALERT_BODY?: string;
  /** Pushes per endpoint. */
  PUSH_LIMIT?: RateLimiter;
  /** Registrations per client address. */
  REGISTER_LIMIT?: RateLimiter;
}

export interface RelayOptions {
  /** How the relay reaches Apple and Google; a test passes its own. */
  fetch?: typeof fetch;
  now?: number;
}

/** The largest encrypted message the relay takes: its base64 has to fit APNs' 4 KB beside the alert. */
export const MAX_PAYLOAD_BYTES = 2800;

/** Web Push's `TTL` is capped at four weeks, Apple's and Google's longest. */
const MAX_TTL_SECONDS = 28 * 24 * 60 * 60;

/** A VAPID token is good for 24 hours at most (RFC 8292 §2). */
const MAX_VAPID_SECONDS = 24 * 60 * 60;

const PUSH_PATH = "/v1/push/";

/** What the relay answers in JSON: an endpoint, its health, or a problem's words. */
type Answer =
  | { endpoint: string }
  | { ok: true; platforms: Platform[] }
  | { error: string };

const json = (body: Answer, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const problem = (error: string, status: number): Response =>
  json({ error }, status);

const apnsConfig = (env: RelayEnv): ApnsConfig | null =>
  env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY && env.APNS_TOPIC
    ? {
        keyId: env.APNS_KEY_ID,
        teamId: env.APNS_TEAM_ID,
        privateKey: env.APNS_PRIVATE_KEY,
        topic: env.APNS_TOPIC,
        alertTitle: env.ALERT_TITLE || "Workspace",
        alertBody: env.ALERT_BODY || "You have a new notification.",
      }
    : null;

const fcmConfig = (env: RelayEnv): FcmConfig | null => {
  if (!env.FCM_SERVICE_ACCOUNT) {
    return null;
  }

  const account = parseJsonObject(env.FCM_SERVICE_ACCOUNT);
  const clientEmail = stringOrNull(account.client_email);
  const privateKey = stringOrNull(account.private_key);
  const projectId = stringOrNull(account.project_id);

  return clientEmail && privateKey && projectId
    ? {
        clientEmail,
        privateKey,
        projectId,
        tokenUri:
          stringOrNull(account.token_uri) ??
          "https://oauth2.googleapis.com/token",
      }
    : null;
};

/** The platforms this relay has the keys to deliver to. */
export const platformsOf = (env: RelayEnv): Platform[] => {
  const out: Platform[] = [];

  if (apnsConfig(env)) {
    out.push("apns");
  }

  if (fcmConfig(env)) {
    out.push("fcm");
  }

  return out;
};

/** An APNs device token is hex; an FCM registration token is base64url with colons. Both are bounded. */
const DEVICE_TOKEN: Record<Platform, RegExp> = {
  apns: /^[0-9a-f]{64,200}$/iu,
  fcm: /^[\w:-]{20,4096}$/u,
};

const origin = (env: RelayEnv, url: URL): string =>
  env.RELAY_URL ? new URL(env.RELAY_URL).origin : url.origin;

const allowed = async (
  limiter: RateLimiter | undefined,
  key: string
): Promise<boolean> => {
  if (!limiter) {
    return true;
  }

  const { success } = await limiter.limit({ key });

  return success;
};

const register = async (
  request: Request,
  env: RelayEnv,
  url: URL
): Promise<Response> => {
  if (
    !(await allowed(
      env.REGISTER_LIMIT,
      request.headers.get("cf-connecting-ip") ?? "unknown"
    ))
  ) {
    return problem("Too many registrations. Try again in a minute.", 429);
  }

  const body = parseJsonObject(await request.text());
  const platform = stringOrNull(body.platform);
  const token = stringOrNull(body.token)?.trim() ?? "";
  const environment = stringOrNull(body.environment) ?? "production";
  const key = stringOrNull(body.applicationServerKey) ?? "";

  if (platform !== "apns" && platform !== "fcm") {
    return problem("`platform` is `apns` or `fcm`.", 400);
  }

  if (!platformsOf(env).includes(platform)) {
    return problem(`This relay does not deliver to ${platform}.`, 400);
  }

  if (!DEVICE_TOKEN[platform].test(token)) {
    return problem("`token` is not a device token.", 400);
  }

  if (environment !== "production" && environment !== "development") {
    return problem("`environment` is `production` or `development`.", 400);
  }

  const raw = base64Decode(key);

  if (!raw || !(await importRawPublicKey(raw))) {
    return problem(
      "`applicationServerKey` is the workspace's VAPID public key: 65 bytes of P-256, base64url.",
      400
    );
  }

  const device: Device = {
    platform,
    token: platform === "apns" ? token.toLowerCase() : token,
    environment,
    applicationServerKey: key.replace(/[=]+$/u, ""),
  };

  return json(
    {
      endpoint: `${origin(env, url)}${PUSH_PATH}${await sealDevice(env.RELAY_SECRET, device)}`,
    },
    201
  );
};

/** `Authorization: vapid t=<token>, k=<key>` (RFC 8292 §3), its two parameters by name. */
const vapidOf = (header: string | null): { t: string; k: string } | null => {
  const match = /^vapid\s+(?<params>.+)$/iu.exec(header ?? "");
  const list = match?.groups?.params;

  if (!list) {
    return null;
  }

  const params = new Map(
    list.split(",").map((part) => {
      const [name = "", ...value] = part.trim().split("=");

      return [name.toLowerCase(), value.join("=")] as const;
    })
  );

  const t = params.get("t");
  const k = params.get("k");

  return t && k ? { t, k } : null;
};

/** Whether the push carries the workspace's VAPID token, signed by the key the endpoint names, for this relay. */
const signedFor = async (
  request: Request,
  device: Device,
  audience: string,
  now: number
): Promise<"ok" | "unsigned" | "wrong-key"> => {
  const vapid = vapidOf(request.headers.get("authorization"));

  if (!vapid) {
    return "unsigned";
  }

  if (vapid.k.replace(/[=]+$/u, "") !== device.applicationServerKey) {
    return "wrong-key";
  }

  const raw = base64Decode(vapid.k);
  const key = raw ? await importRawPublicKey(raw) : null;
  const claims = key ? await verifyEs256(vapid.t, key) : null;
  const seconds = now / 1000;

  return claims?.aud === audience &&
    claims.exp !== null &&
    claims.exp > seconds &&
    claims.exp <= seconds + MAX_VAPID_SECONDS + 60
    ? "ok"
    : "unsigned";
};

/** Web Push's answer to how a gateway took the message. */
const ANSWERS: Record<Outcome, () => Response> = {
  sent: () => new Response(null, { status: 201 }),
  gone: () => problem("The device no longer takes notifications.", 410),
  throttled: () => problem("The gateway is slowing this device down.", 429),
  refused: () => problem("The gateway refused the message.", 502),
  failed: () => problem("The gateway could not be reached.", 503),
};

/** The message a push carries, as Web Push's headers describe it; the problem to answer when they are wrong. */
const messageOf = async (request: Request): Promise<Message | Response> => {
  if (request.headers.get("content-encoding")?.toLowerCase() !== "aes128gcm") {
    return problem("Encrypt the message as `aes128gcm` (RFC 8291).", 415);
  }

  const ttl = request.headers.get("ttl");

  if (ttl === null || !/^\d+$/u.test(ttl)) {
    return problem("Name the message's `TTL`.", 400);
  }

  const topic = request.headers.get("topic");

  if (topic !== null && !/^[\w-]{1,32}$/u.test(topic)) {
    return problem("A `Topic` is at most 32 base64url characters.", 400);
  }

  const urgency = request.headers.get("urgency")?.toLowerCase() ?? "normal";

  if (!["very-low", "low", "normal", "high"].includes(urgency)) {
    return problem("`Urgency` is very-low, low, normal or high.", 400);
  }

  const body = new Uint8Array(await request.arrayBuffer());

  if (body.length === 0) {
    return problem("A push without a message has nothing to show.", 400);
  }

  if (body.length > MAX_PAYLOAD_BYTES) {
    return problem(
      `The message is over ${MAX_PAYLOAD_BYTES} bytes, which the gateways cannot carry.`,
      413
    );
  }

  return {
    payload: base64UrlEncode(body),
    ttl: Math.min(Number(ttl), MAX_TTL_SECONDS),
    urgent: urgency === "normal" || urgency === "high",
    topic,
  };
};

const push = async (
  request: Request,
  env: RelayEnv,
  url: URL,
  options: Required<RelayOptions>
): Promise<Response> => {
  const segment = url.pathname.slice(PUSH_PATH.length);
  const device = await openDevice(env.RELAY_SECRET, segment);

  if (!device) {
    return problem("No such subscription.", 404);
  }

  const signed = await signedFor(
    request,
    device,
    origin(env, url),
    options.now
  );

  if (signed !== "ok") {
    return problem(
      signed === "wrong-key"
        ? "This subscription is another application server's."
        : "Sign the push with the application server's VAPID key.",
      signed === "wrong-key" ? 403 : 401
    );
  }

  const message = await messageOf(request);

  if (message instanceof Response) {
    return message;
  }

  if (!(await allowed(env.PUSH_LIMIT, segment.slice(-64)))) {
    return problem("Too many messages for this device. Slow down.", 429);
  }

  const deliver = { fetch: options.fetch, now: options.now };
  let outcome: Outcome;

  try {
    if (device.platform === "apns") {
      const config = apnsConfig(env);
      outcome = config
        ? await sendApns(config, device, message, deliver)
        : "refused";
    } else {
      const config = fcmConfig(env);
      outcome = config
        ? await sendFcm(config, device, message, deliver)
        : "refused";
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "relay.push_failed",
        platform: device.platform,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    outcome = "failed";
  }

  // The outcome alone: never the token, the workspace or the message.
  console.log(
    JSON.stringify({
      event: "relay.push",
      platform: device.platform,
      outcome,
    })
  );

  return ANSWERS[outcome]();
};

/** The relay's routes: `GET /health`, `POST /v1/register` and `POST /v1/push/<endpoint>`. */
export const handleRelay = async (
  request: Request,
  env: RelayEnv,
  options: RelayOptions = {}
): Promise<Response> => {
  const url = new URL(request.url);

  const resolved = {
    fetch: options.fetch ?? fetch,
    now: options.now ?? Date.now(),
  };

  if (!env.RELAY_SECRET || env.RELAY_SECRET.length < 32) {
    return problem("The relay has no RELAY_SECRET of 32 characters.", 500);
  }

  if (url.pathname === "/health" && request.method === "GET") {
    return json({ ok: true, platforms: platformsOf(env) });
  }

  if (url.pathname === "/v1/register") {
    return request.method === "POST"
      ? await register(request, env, url)
      : problem("POST a device.", 405);
  }

  if (url.pathname.startsWith(PUSH_PATH)) {
    return request.method === "POST"
      ? await push(request, env, url, resolved)
      : problem("POST a message.", 405);
  }

  return problem("No such endpoint.", 404);
};
