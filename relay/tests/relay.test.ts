import { beforeAll, describe, expect, it } from "vitest";

import { base64Encode, base64UrlEncode } from "../src/bytes";
import { signJwt } from "../src/jwt";
import { handleRelay } from "../src/relay";
import type { RateLimiter, RelayEnv } from "../src/relay";

const RELAY = "https://push.example.org";
const NOW = Date.parse("2026-11-28T12:00:00Z");
const DEVICE = "a1".repeat(32);

const pem = (label: string, der: ArrayBuffer): string =>
  `-----BEGIN ${label}-----\n${base64Encode(new Uint8Array(der))}\n-----END ${label}-----`;

/** A workspace's VAPID key pair, as `crypto.subtle` makes one. */
const vapidKeys = async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );

  const raw = base64UrlEncode(
    await crypto.subtle.exportKey("raw", pair.publicKey)
  );

  return { privateKey: pair.privateKey, publicKey: raw };
};

type Vapid = Awaited<ReturnType<typeof vapidKeys>>;

/** One request the fakes were sent. */
interface Sent {
  url: string;
  headers: Headers;
  body: string;
}

/** Apple and Google in memory: what each was sent, and the answer the test chose. */
const gateways = (answer: () => Response = () => new Response(null)) => {
  const sent: Sent[] = [];

  const fake: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    sent.push({
      url: request.url,
      headers: request.headers,
      body: await request.text(),
    });

    if (request.url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "ya29.test", expires_in: 3600 });
    }

    return answer();
  };

  return { sent, fetch: fake };
};

const vapidHeader = async (
  vapid: Vapid,
  claims: { aud?: string; exp?: number } = {}
): Promise<string> => {
  const token = await signJwt(
    { alg: "ES256", typ: "JWT" },
    {
      aud: claims.aud ?? RELAY,
      exp: claims.exp ?? Math.floor(NOW / 1000) + 12 * 3600,
      sub: "https://workspace.example.com",
    },
    vapid.privateKey
  );

  return `vapid t=${token}, k=${vapid.publicKey}`;
};

const statusOf = async (response: Promise<Response>): Promise<number> => {
  const { status } = await response;

  return status;
};

describe("the relay", () => {
  let env: RelayEnv;

  beforeAll(async () => {
    const apple = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"]
    );

    const google = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign"]
    );

    env = {
      RELAY_SECRET: "relay-secret-of-at-least-thirty-two-characters",
      RELAY_URL: RELAY,
      APNS_KEY_ID: "KEY123",
      APNS_TEAM_ID: "TEAM123",
      APNS_PRIVATE_KEY: pem(
        "PRIVATE KEY",
        await crypto.subtle.exportKey("pkcs8", apple.privateKey)
      ),
      APNS_TOPIC: "software.rivi.workspace",
      FCM_SERVICE_ACCOUNT: JSON.stringify({
        client_email: "relay@project.iam.gserviceaccount.com",
        private_key: pem(
          "PRIVATE KEY",
          await crypto.subtle.exportKey("pkcs8", google.privateKey)
        ),
        project_id: "workspace-app",
        token_uri: "https://oauth2.googleapis.com/token",
      }),
    };
  });

  const register = (
    vapid: Vapid,
    device: Record<string, string> = {},
    relayEnv: RelayEnv = env
  ): Promise<Response> =>
    handleRelay(
      new Request(`${RELAY}/v1/register`, {
        method: "POST",
        body: JSON.stringify({
          platform: "apns",
          token: DEVICE,
          applicationServerKey: vapid.publicKey,
          ...device,
        }),
      }),
      relayEnv
    );

  const endpointFor = async (
    vapid: Vapid,
    device: Record<string, string> = {}
  ): Promise<string> => {
    const response = await register(vapid, device);
    expect(response.status).toBe(201);
    // SAFETY: a registration the relay took (201, above) answers its endpoint.
    const { endpoint } = (await response.json()) as { endpoint: string };

    return endpoint;
  };

  const push = (
    endpoint: string,
    init: {
      authorization?: string | null;
      headers?: Record<string, string>;
      body?: Uint8Array<ArrayBuffer>;
      fetch?: typeof fetch;
      env?: RelayEnv;
    }
  ): Promise<Response> => {
    const headers = new Headers({
      "content-encoding": "aes128gcm",
      ttl: "3600",
      ...init.headers,
    });

    if (init.authorization) {
      headers.set("authorization", init.authorization);
    }

    return handleRelay(
      new Request(endpoint, {
        method: "POST",
        headers,
        body: init.body ?? new Uint8Array([1, 2, 3, 4]),
      }),
      init.env ?? env,
      { fetch: init.fetch ?? gateways().fetch, now: NOW }
    );
  };

  describe("health", () => {
    it("names the platforms the relay has keys for", async () => {
      const response = await handleRelay(new Request(`${RELAY}/health`), env);

      await expect(response.json()).resolves.toStrictEqual({
        ok: true,
        platforms: ["apns", "fcm"],
      });

      const bare = await handleRelay(new Request(`${RELAY}/health`), {
        RELAY_SECRET: env.RELAY_SECRET,
      });

      await expect(bare.json()).resolves.toStrictEqual({
        ok: true,
        platforms: [],
      });
    });

    it("refuses to run without a long secret", async () => {
      const response = await handleRelay(new Request(`${RELAY}/health`), {
        RELAY_SECRET: "short",
      });

      expect(response.status).toBe(500);
    });
  });

  describe("register", () => {
    it("answers an endpoint under the relay's address that holds no device token", async () => {
      const endpoint = await endpointFor(await vapidKeys());

      expect(endpoint.startsWith(`${RELAY}/v1/push/v1.`)).toBeTruthy();
      expect(endpoint).not.toContain(DEVICE);
    });

    it.each([
      ["a platform it does not know", { platform: "web" }],
      ["a token that is no APNs token", { token: "not-hex" }],
      ["an environment Apple does not have", { environment: "staging" }],
      ["a key that is no P-256 key", { applicationServerKey: "AAAA" }],
    ])("refuses %s", async (_, device) => {
      await expect(statusOf(register(await vapidKeys(), device))).resolves.toBe(
        400
      );
    });

    it("refuses a platform the relay has no keys for", async () => {
      const status = await statusOf(
        register(await vapidKeys(), {}, { RELAY_SECRET: env.RELAY_SECRET })
      );

      expect(status).toBe(400);
    });

    it("is throttled per client", async () => {
      const limiter: RateLimiter = {
        limit: () => Promise.resolve({ success: false }),
      };

      const status = await statusOf(
        register(await vapidKeys(), {}, { ...env, REGISTER_LIMIT: limiter })
      );

      expect(status).toBe(429);
    });
  });

  describe("push", () => {
    it("hands the ciphertext to APNs unopened, for the app's extension to open", async () => {
      const vapid = await vapidKeys();
      const endpoint = await endpointFor(vapid);
      const apple = gateways();
      const body = new Uint8Array([9, 8, 7, 6, 5]);

      const response = await push(endpoint, {
        authorization: await vapidHeader(vapid),
        headers: { topic: "th_123", urgency: "high" },
        body,
        fetch: apple.fetch,
      });

      expect(response.status).toBe(201);
      expect(apple.sent).toHaveLength(1);

      const [sent] = apple.sent;

      expect(sent?.url).toBe(`https://api.push.apple.com/3/device/${DEVICE}`);
      expect(JSON.parse(sent?.body ?? "")).toStrictEqual({
        aps: {
          alert: { title: "Workspace", body: "You have a new notification." },
          "mutable-content": 1,
          sound: "default",
        },
        wp: base64UrlEncode(body),
      });
    });

    it("names the app, the priority, the collapse and the expiry to Apple, on a provider token", async () => {
      const vapid = await vapidKeys();
      const endpoint = await endpointFor(vapid);
      const apple = gateways();

      await push(endpoint, {
        authorization: await vapidHeader(vapid),
        headers: { topic: "th_123", urgency: "low" },
        fetch: apple.fetch,
      });

      const headers = apple.sent[0]?.headers;

      expect({
        topic: headers?.get("apns-topic"),
        priority: headers?.get("apns-priority"),
        collapse: headers?.get("apns-collapse-id"),
        expiration: headers?.get("apns-expiration"),
      }).toStrictEqual({
        topic: "software.rivi.workspace",
        priority: "5",
        collapse: "th_123",
        expiration: String(Math.floor(NOW / 1000) + 3600),
      });
      expect(headers?.get("authorization")).toMatch(/^bearer ey/u);
    });

    it("sends a development build's token to Apple's sandbox", async () => {
      const vapid = await vapidKeys();
      const endpoint = await endpointFor(vapid, { environment: "development" });
      const apple = gateways();

      await push(endpoint, {
        authorization: await vapidHeader(vapid),
        fetch: apple.fetch,
      });

      expect(apple.sent[0]?.url).toBe(
        `https://api.sandbox.push.apple.com/3/device/${DEVICE}`
      );
    });

    it("sends an Android token through FCM as a data message, on a service account's token", async () => {
      const vapid = await vapidKeys();
      const token = `fcm-token:${"x".repeat(60)}`;
      const endpoint = await endpointFor(vapid, { platform: "fcm", token });
      const google = gateways();

      const response = await push(endpoint, {
        authorization: await vapidHeader(vapid),
        headers: { urgency: "low" },
        fetch: google.fetch,
      });

      expect(response.status).toBe(201);

      const send = google.sent.find((s) => s.url.includes("messages:send"));

      expect(send?.url).toBe(
        "https://fcm.googleapis.com/v1/projects/workspace-app/messages:send"
      );
      expect(send?.headers.get("authorization")).toBe("Bearer ya29.test");
      expect(JSON.parse(send?.body ?? "")).toStrictEqual({
        message: {
          token,
          data: { wp: base64UrlEncode(new Uint8Array([1, 2, 3, 4])) },
          android: { priority: "NORMAL", ttl: "3600s" },
        },
      });
    });

    const seconds = Math.floor(NOW / 1000);

    it.each([
      ["no signature", () => Promise.resolve(null), 401],
      ["another server's key", async () => vapidHeader(await vapidKeys()), 403],
      [
        "the workspace's key with another key's signature",
        async (vapid: Vapid) => {
          const stranger = await vapidKeys();
          const header = await vapidHeader(stranger);

          return header.replace(stranger.publicKey, vapid.publicKey);
        },
        401,
      ],
      [
        "a token for another audience",
        (vapid: Vapid) => vapidHeader(vapid, { aud: "https://other.example" }),
        401,
      ],
      [
        "an expired token",
        (vapid: Vapid) => vapidHeader(vapid, { exp: seconds - 1 }),
        401,
      ],
      [
        "a token good for more than a day",
        (vapid: Vapid) => vapidHeader(vapid, { exp: seconds + 3 * 24 * 3600 }),
        401,
      ],
    ] as const)(
      "refuses %s, and sends nothing",
      async (_, authorize, expected) => {
        const vapid = await vapidKeys();
        const endpoint = await endpointFor(vapid);
        const apple = gateways();

        const status = await statusOf(
          push(endpoint, {
            authorization: await authorize(vapid),
            fetch: apple.fetch,
          })
        );

        expect(status).toBe(expected);
        expect(apple.sent).toHaveLength(0);
      }
    );

    it("knows no endpoint another secret sealed, or one tampered with", async () => {
      const vapid = await vapidKeys();
      const endpoint = await endpointFor(vapid);
      const authorization = await vapidHeader(vapid);

      const otherSecret = await statusOf(
        push(endpoint, {
          authorization,
          env: {
            ...env,
            RELAY_SECRET: "another-secret-of-at-least-thirty-two-chars",
          },
        })
      );

      const tampered = await statusOf(
        push(`${endpoint.slice(0, -2)}AA`, { authorization })
      );

      expect([otherSecret, tampered]).toStrictEqual([404, 404]);
    });

    it.each([
      ["another encoding", { headers: { "content-encoding": "aesgcm" } }, 415],
      ["no TTL as a number", { headers: { ttl: "soon" } }, 400],
      ["a topic Web Push does not allow", { headers: { topic: "a b" } }, 400],
      [
        "an urgency Web Push does not name",
        { headers: { urgency: "now" } },
        400,
      ],
      ["no message", { body: new Uint8Array(0) }, 400],
      ["a message too large to carry", { body: new Uint8Array(2801) }, 413],
    ] as const)("refuses %s", async (_, request, expected) => {
      const vapid = await vapidKeys();
      const endpoint = await endpointFor(vapid);

      const status = await statusOf(
        push(endpoint, {
          authorization: await vapidHeader(vapid),
          ...request,
        })
      );

      expect(status).toBe(expected);
    });

    it.each([
      ["APNs", "Unregistered", 410, 410],
      ["APNs", "BadDeviceToken", 400, 410],
      ["APNs", "TooManyRequests", 429, 429],
      ["APNs", "InternalServerError", 503, 503],
      ["APNs", "InvalidProviderToken", 403, 502],
      ["FCM", "UNREGISTERED", 404, 410],
    ] as const)(
      "answers %s's %s as Web Push's %i",
      async (gateway, reason, answered, expected) => {
        const vapid = await vapidKeys();

        const endpoint = await endpointFor(
          vapid,
          gateway === "FCM"
            ? { platform: "fcm", token: `fcm-token:${"y".repeat(60)}` }
            : {}
        );

        const body =
          gateway === "FCM"
            ? { error: { details: [{ errorCode: reason }] } }
            : { reason };

        const status = await statusOf(
          push(endpoint, {
            authorization: await vapidHeader(vapid),
            fetch: gateways(() => Response.json(body, { status: answered }))
              .fetch,
          })
        );

        expect(status).toBe(expected);
      }
    );

    it("is throttled per endpoint", async () => {
      const vapid = await vapidKeys();
      const endpoint = await endpointFor(vapid);

      const limiter: RateLimiter = {
        limit: () => Promise.resolve({ success: false }),
      };

      const status = await statusOf(
        push(endpoint, {
          authorization: await vapidHeader(vapid),
          env: { ...env, PUSH_LIMIT: limiter },
        })
      );

      expect(status).toBe(429);
    });
  });
});
