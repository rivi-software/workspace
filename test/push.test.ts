// Push notifications to the workspace's apps (docs/PUSH.md): the workspace's Web Push (RFC 8291's encryption, RFC
// 8292's VAPID), the subscriptions under `/api/v1/push`, and a notice of new mail that goes through the push relay
// (relay/, its own code, mounted here) to Apple, and that only the phone's keys open.
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { pushSubscriptions } from "~/db/schema";
import type { User } from "~/db/schema";
import { revoke } from "~/lib/auth.server";
import { base64UrlDecode, base64UrlEncode } from "~/lib/crypto";
import { parseJsonObject, stringOrNull } from "~/lib/guards";
import { ingestInboundEmail } from "~/lib/mail/ingest.server";
import { applyThreadAction } from "~/lib/mail/threads.server";
import { encryptPush } from "~/lib/push/web-push.server";

import { handleRelay } from "../relay/src/relay";
import type { RelayEnv } from "../relay/src/relay";
import { createWorker } from "../workers/worker";
import { db, defined, mail, mailbox, sessionFor, tokenOf } from "./fixtures";
import type { Json } from "./fixtures";
import { stubEnv } from "./stub-env";

const RELAY = "https://push.example.org";
const api = `${env.APP_URL.replace(/\/+$/u, "")}/api/v1`;
const DEVICE = "c0ffee".repeat(11).slice(0, 64);

/** The workspace with push on, through the project's relay. */
const pushing = stubEnv({ ...env, PUSH_RELAY_URL: RELAY });

const worker = createWorker(() => new Response("no start", { status: 404 }));

/** A call of the API on `laid`, with the session's token, JSON in when there is a body. */
const call = (
  laid: Env,
  token: string,
  method: string,
  path: string,
  body?: Json
): Promise<Response> => {
  const headers = new Headers({ authorization: `Bearer ${token}` });

  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }

  return worker.fetch(
    // SAFETY: nothing in the Worker reads `request.cf`; a plain Request stands in for Workers' own.
    new Request(`${api}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as Request<unknown, IncomingRequestCfProperties>,
    laid
  );
};

const jsonOf = async (response: Response) =>
  parseJsonObject(await response.text());

/** A PEM of a key WebCrypto made, as Apple hands out a `.p8`. */
const pem = (der: ArrayBuffer): string =>
  `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCodePoint(...new Uint8Array(der)))}\n-----END PRIVATE KEY-----`;

const relayEnv = async (): Promise<RelayEnv> => {
  const apple = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"]
  );

  return {
    RELAY_SECRET: "the-relay-secret-of-at-least-32-characters",
    RELAY_URL: RELAY,
    APNS_KEY_ID: "KEY123",
    APNS_TEAM_ID: "TEAM123",
    APNS_PRIVATE_KEY: pem(
      await crypto.subtle.exportKey("pkcs8", apple.privateKey)
    ),
    APNS_TOPIC: "software.rivi.workspace",
  };
};

/** Apple in memory: every push it was handed, and the answer the test chose. */
const fakeApple = (status = 200) => {
  const pushes: { headers: Headers; body: string }[] = [];

  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    pushes.push({ headers: request.headers, body: await request.text() });

    return Response.json(status === 200 ? {} : { reason: "Unregistered" }, {
      status,
    });
  };

  return { pushes, fetch: fetchFn };
};

/** What the workspace reaches the relay through: the relay's own code, Apple behind it. */
const relayFetch =
  (relay: RelayEnv, apple: typeof fetch): typeof fetch =>
  (input, init) => {
    const request = new Request(input, init);

    return request.url.startsWith(`${RELAY}/`)
      ? handleRelay(request, relay, { fetch: apple })
      : Promise.reject(new Error(`No network in the tests: ${request.url}`));
  };

/** An app's Web Push keys, as a browser makes a subscription's (RFC 8291 §2). */
const phoneKeys = async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );

  return {
    privateKey: pair.privateKey,
    p256dh: base64UrlEncode(
      await crypto.subtle.exportKey("raw", pair.publicKey)
    ),
    auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
  };
};

type Phone = Awaited<ReturnType<typeof phoneKeys>>;

const encoded = (text: string) => new TextEncoder().encode(text);

const hkdf = async (
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number
) =>
  new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info,
      },
      await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
      bytes * 8
    )
  );

/** What the app's notification extension does with `wp`: open the `aes128gcm` body with its keys (RFC 8291 §3). */
const openPush = async (phone: Phone, body: Uint8Array<ArrayBuffer>) => {
  const salt = body.slice(0, 16);
  const idLength = defined(body[20]);
  const senderPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const receiverPublic = base64UrlDecode(phone.p256dh);

  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "ECDH",
        public: await crypto.subtle.importKey(
          "raw",
          senderPublic,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          []
        ),
      },
      phone.privateKey,
      256
    )
  );

  const info = new Uint8Array([
    ...new TextEncoder().encode("WebPush: info\0"),
    ...receiverPublic,
    ...senderPublic,
  ]);

  const ikm = await hkdf(base64UrlDecode(phone.auth), shared, info, 32);

  const cek = await hkdf(
    salt,
    ikm,
    encoded("Content-Encoding: aes128gcm\0"),
    16
  );

  const nonce = await hkdf(salt, ikm, encoded("Content-Encoding: nonce\0"), 12);

  const record = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]),
      ciphertext
    )
  );

  // The last record ends in 0x02 after its padding of zeros.
  return new TextDecoder().decode(record.slice(0, record.lastIndexOf(2)));
};

/** An app on a phone, signed in as `user`: its session, its keys, and its subscription through the relay. */
const subscribedPhone = async (user: User, relay: RelayEnv) => {
  const token = tokenOf(await sessionFor(user));
  const settings = await jsonOf(await call(pushing, token, "GET", "/push"));
  const phone = await phoneKeys();

  const registered = await handleRelay(
    new Request(`${RELAY}/v1/register`, {
      method: "POST",
      body: JSON.stringify({
        platform: "apns",
        token: DEVICE,
        applicationServerKey: stringOrNull(settings.applicationServerKey),
      }),
    }),
    relay
  );

  const answer = await jsonOf(registered);

  const endpoint = defined(
    stringOrNull(answer.endpoint),
    "the relay's endpoint"
  );

  const subscribed = await call(pushing, token, "POST", "/push/subscriptions", {
    endpoint,
    keys: { p256dh: phone.p256dh, auth: phone.auth },
  });

  expect(subscribed.status).toBe(201);

  const made = await jsonOf(subscribed);
  const id = defined(stringOrNull(made.id), "its id");

  return { token, phone, endpoint, id };
};

const subscriptionsOf = (userId: string) =>
  db.query.pushSubscriptions.findMany({
    where: eq(pushSubscriptions.userId, userId),
  });

describe("Web Push encryption", () => {
  it("writes RFC 8291's example to the byte", async () => {
    // RFC 8291, Appendix A.
    const senderPublic = base64UrlDecode(
      "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
    );

    const privateKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
        x: base64UrlEncode(senderPublic.slice(1, 33)),
        y: base64UrlEncode(senderPublic.slice(33)),
      },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"]
    );

    const salt = base64UrlDecode("DGv6ra1nlYgDCS1FRnbzlw");

    const body = await encryptPush(
      new TextEncoder().encode("When I grow up, I want to be a watermelon"),
      {
        p256dh:
          "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      },
      { salt, sender: { privateKey, publicKey: senderPublic } }
    );

    const header = new Uint8Array([...salt, 0, 0, 16, 0, 65, ...senderPublic]);

    const ciphertext = base64UrlDecode(
      "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ"
    );

    expect(base64UrlEncode(body)).toBe(
      base64UrlEncode(new Uint8Array([...header, ...ciphertext]))
    );
  });
});

describe("the push settings", () => {
  it("say push is off without a relay, and refuse a subscription", async () => {
    const user = await mailbox("push-off");
    const token = tokenOf(await sessionFor(user));

    const settings = await exports.default.fetch(`${api}/push`, {
      headers: { authorization: `Bearer ${token}` },
    });

    const subscribed = await call(env, token, "POST", "/push/subscriptions", {
      endpoint: `${RELAY}/v1/push/v1.abc`,
      keys: { p256dh: "x", auth: "y" },
    });

    await expect(jsonOf(settings)).resolves.toStrictEqual({
      enabled: false,
      relay: null,
      applicationServerKey: null,
    });
    expect(subscribed.status).toBe(400);
  });

  it("name the relay and the workspace's VAPID key, the same on every call", async () => {
    const user = await mailbox("push-settings");
    const token = tokenOf(await sessionFor(user));

    const first = await jsonOf(await call(pushing, token, "GET", "/push"));
    const again = await jsonOf(await call(pushing, token, "GET", "/push"));
    const key = base64UrlDecode(stringOrNull(first.applicationServerKey) ?? "");

    expect(first).toMatchObject({ enabled: true, relay: RELAY });
    expect([key.length, key[0]]).toStrictEqual([65, 4]);
    expect(again.applicationServerKey).toBe(first.applicationServerKey);
  });
});

describe("a subscription", () => {
  it.each([
    ["an endpoint on another host", "https://evil.example/v1/push/v1.x"],
    ["an endpoint outside the relay's pushes", `${RELAY}/health`],
    ["plain HTTP", "http://push.example.org/v1/push/v1.x"],
  ])("refuses %s", async (_, endpoint) => {
    const user = await mailbox("push-refused");
    const token = tokenOf(await sessionFor(user));
    const phone = await phoneKeys();

    const response = await call(pushing, token, "POST", "/push/subscriptions", {
      endpoint,
      keys: { p256dh: phone.p256dh, auth: phone.auth },
    });

    expect(response.status).toBe(400);
  });

  it("refuses keys that are not a P-256 key and a 16-byte secret", async () => {
    const user = await mailbox("push-keys");
    const token = tokenOf(await sessionFor(user));
    const phone = await phoneKeys();
    const endpoint = `${RELAY}/v1/push/v1.anything`;

    const badKey = await call(pushing, token, "POST", "/push/subscriptions", {
      endpoint,
      keys: { p256dh: phone.auth, auth: phone.auth },
    });

    const badAuth = await call(pushing, token, "POST", "/push/subscriptions", {
      endpoint,
      keys: { p256dh: phone.p256dh, auth: phone.p256dh },
    });

    expect([badKey.status, badAuth.status]).toStrictEqual([400, 400]);
  });

  it("is one a session: subscribing again replaces it", async () => {
    const user = await mailbox("push-again");
    const relay = await relayEnv();
    const { token, endpoint } = await subscribedPhone(user, relay);
    const phone = await phoneKeys();

    await call(pushing, token, "POST", "/push/subscriptions", {
      endpoint,
      keys: { p256dh: phone.p256dh, auth: phone.auth },
    });

    const rows = await subscriptionsOf(user.id);

    expect(rows.map((r) => r.p256dh)).toStrictEqual([phone.p256dh]);
  });

  it("ends with its session", async () => {
    const user = await mailbox("push-signed-out");
    await subscribedPhone(user, await relayEnv());

    await revoke(db, user.id, "sign-out-everywhere");

    await expect(subscriptionsOf(user.id)).resolves.toHaveLength(0);
  });

  it("is deleted by its own person alone", async () => {
    const owner = await mailbox("push-owner");
    const other = await mailbox("push-other");
    const { token, id } = await subscribedPhone(owner, await relayEnv());
    const otherToken = tokenOf(await sessionFor(other));

    const theirs = await call(
      pushing,
      otherToken,
      "DELETE",
      `/push/subscriptions/${id}`
    );

    const own = await call(
      pushing,
      token,
      "DELETE",
      `/push/subscriptions/${id}`
    );

    expect([theirs.status, own.status]).toStrictEqual([404, 200]);
    await expect(subscriptionsOf(owner.id)).resolves.toHaveLength(0);
  });
});

describe("a notice of new mail", () => {
  it("reaches Apple through the relay, and only the phone opens it", async () => {
    const user = await mailbox("push-mail");
    const relay = await relayEnv();
    const { phone } = await subscribedPhone(user, relay);
    const apple = fakeApple();

    const result = await ingestInboundEmail(
      pushing,
      null,
      mail({ subject: "Lunch on Friday?" }),
      user.email,
      { fetch: relayFetch(relay, apple.fetch) }
    );

    const threadId = result.status === "stored" ? result.threadId : "";

    expect(apple.pushes).toHaveLength(1);

    const [sent] = apple.pushes;
    const wp = defined(stringOrNull(parseJsonObject(sent?.body).wp), "wp");

    expect(sent?.body).not.toContain("Lunch");
    expect(sent?.headers.get("apns-collapse-id")).toBe(threadId);
    expect(
      parseJsonObject(await openPush(phone, base64UrlDecode(wp)))
    ).toStrictEqual({
      type: "mail",
      title: "Jane Doe",
      body: "Lunch on Friday?",
      threadId,
      url: `${new URL(env.APP_URL).origin}/mail/t/${threadId}`,
    });
  });

  it("says nothing of a conversation the person muted", async () => {
    const user = await mailbox("push-muted");
    const relay = await relayEnv();
    await subscribedPhone(user, relay);
    const apple = fakeApple();
    const options = { fetch: relayFetch(relay, apple.fetch) };

    const first = mail({ subject: "A busy thread" });

    const result = await ingestInboundEmail(
      pushing,
      null,
      first,
      user.email,
      options
    );

    const threadId = result.status === "stored" ? result.threadId : "";
    await applyThreadAction(db, pushing, user.id, [threadId], {
      intent: "mute",
    });

    await ingestInboundEmail(
      pushing,
      null,
      mail({
        subject: "Re: A busy thread",
        inReplyTo: first.messageId,
        references: [first.messageId],
      }),
      user.email,
      options
    );

    expect(apple.pushes).toHaveLength(1);
  });

  it("forgets a subscription the relay calls gone, and files the mail all the same", async () => {
    const user = await mailbox("push-gone");
    const relay = await relayEnv();
    await subscribedPhone(user, relay);

    const result = await ingestInboundEmail(pushing, null, mail(), user.email, {
      fetch: relayFetch(relay, fakeApple(410).fetch),
    });

    expect(result.status).toBe("stored");
    await expect(subscriptionsOf(user.id)).resolves.toHaveLength(0);
  });

  it("never fails a delivery when the relay cannot be reached", async () => {
    const user = await mailbox("push-down");
    await subscribedPhone(user, await relayEnv());

    const result = await ingestInboundEmail(pushing, null, mail(), user.email, {
      fetch: () => Promise.reject(new Error("the relay is down")),
    });

    expect(result.status).toBe("stored");
    await expect(subscriptionsOf(user.id)).resolves.toHaveLength(1);
  });
});
