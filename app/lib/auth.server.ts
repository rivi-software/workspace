/**
 * Who is signed in, on Better Auth: the instance over this Worker's D1 database (`createAuth`), the session a
 * request carries (`getSessionUser`, `requireUser`), passwords (PBKDF2 through WebCrypto, which Better Auth hashes
 * and checks with as well), a person's sessions and what a change of their credentials ends (`revoke`), and the
 * sign-in throttle of the password form.
 *
 * Better Auth serves `/api/auth/*` from the Worker (`workers/worker.ts`): the password sign-in the form posts
 * (`sign-in.server.ts`), passkeys (`@better-auth/passkey`), the authenticator-app second factor (`twoFactor`) and
 * the bearer tokens of the API (`bearer`). Its tables are the Drizzle schema's (`users`, `sessions`, `accounts`,
 * `verifications`, `passkeys`, `two_factors`), so a migration is generated as for any other table. Sign-up, email
 * verification and Better Auth's own password reset are off: admins make the mailboxes (`users.server.ts`), and a
 * forgotten password goes through the recovery addresses (`recovery.server.ts`).
 */
import { APIError } from "@better-auth/core/error";
import { redirect } from "@tanstack/react-router";
import type { BetterAuthOptions } from "better-auth";
import { and, eq } from "drizzle-orm";

import { createDb } from "~/db";
import type { Database } from "~/db";
import {
  accounts,
  passkeys,
  recoveryTokens,
  sessions,
  twoFactors,
  users,
  verifications,
} from "~/db/schema";
import type { User } from "~/db/schema";

import { base64UrlDecode } from "./crypto";
import { duoEnabled } from "./duo/enabled";
import { isJsonObject, stringOrNull } from "./guards";
import type { parseJsonObject } from "./guards";
import { newId, nowIso } from "./ids";

/** Where Better Auth answers, before TanStack Start (`workers/worker.ts`). */
export const AUTH_PATH = "/api/auth";

/** The cookies' prefix: `workspace.session_token` carries the session. */
export const COOKIE_PREFIX = "workspace";

/**
 * The session cookie's name: Better Auth puts `__Secure-` before it where the workspace runs on https (production,
 * the tests), and leaves it bare on http (local development).
 */
export const sessionCookieName = (env: Pick<Env, "APP_URL">): string =>
  `${env.APP_URL.startsWith("https://") ? "__Secure-" : ""}${COOKIE_PREFIX}.session_token`;

/** How long a session lasts, and how old one may be before a passkey can be added or a password changed. */
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

/** The one account a person signs in with: their password, as Better Auth keeps it. */
const PASSWORD_PROVIDER = "credential";

// ---------- password hashing (PBKDF2-SHA256 via WebCrypto, no native deps) ----------

const ITERATIONS = 100_000;

const toHex = (buf: ArrayBuffer | Uint8Array): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join(
    ""
  );

const fromHex = (hex: string): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(hex.length / 2);

  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return out;
};

const derive = async (
  password: string,
  salt: Uint8Array<ArrayBuffer>
): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: ITERATIONS,
    },
    key,
    256
  );

  return new Uint8Array(bits);
};

/** `pbkdf2$<iterations>$<salt>$<hash>`: a person's password (the `credential` account) and a Drive link's. */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt);

  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
};

export const verifyPassword = async (
  password: string,
  stored: string
): Promise<boolean> => {
  const [scheme, , saltHex, hashHex] = stored.split("$");

  if (scheme !== "pbkdf2" || !saltHex || !hashHex) {
    return false;
  }

  const actual = await derive(password, fromHex(saltHex));
  const expected = fromHex(hashHex);

  if (actual.length !== expected.length) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < actual.length; i += 1) {
    // oxlint-disable-next-line eslint/no-bitwise -- constant-time comparison of the derived hash: every byte is XORed in and ORed together, with no early exit
    diff |= actual[i] ^ expected[i];
  }

  return diff === 0;
};

/** A password a person can type once from a printout and then change. */
export const generatePassword = (): string => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));

  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
};

// ---------- how a session was signed in (RFC 8176 `amr`) ----------

/**
 * How a session was signed in, as RFC 8176 names the methods: what an application that signs in through the
 * workspace reads from the ID token's `amr` (docs/SSO.md). `pwd` a password, `otp` a one-time code (the
 * authenticator app, or Duo's), `pop` proof of a key the person holds (a passkey), `mfa` two factors.
 */
export type Amr = readonly string[];

/** The authenticator data's flags byte follows the 32-byte RP ID hash; bit 2 is User Verified (WebAuthn §6.1). */
const UV_FLAG = 0x04;

/**
 * The `authenticatorData` of the passkey assertion a sign-in posted to the passkey plugin (`response.response`, as
 * `@simplewebauthn/browser` sends it), or null when the body carries none.
 */
const assertionAuthenticatorData = (
  body: ReturnType<typeof parseJsonObject> | null
): string | null => {
  const credential = isJsonObject(body?.response) ? body.response : null;

  const response = isJsonObject(credential?.response)
    ? credential.response
    : null;

  return stringOrNull(response?.authenticatorData);
};

/**
 * Whether the passkey that signed in also verified the person (a fingerprint, a face, the device's PIN): then it is two
 * factors in one, something held and something known or been. Read after the plugin verified the assertion, since a
 * session is only made for one that checked out.
 */
export const passkeyVerifiedUser = (
  authenticatorData: string | null
): boolean => {
  if (!authenticatorData) {
    return false;
  }

  try {
    const flags = base64UrlDecode(authenticatorData)[32] ?? 0;

    // oxlint-disable-next-line eslint/no-bitwise -- a flag of the authenticator data is one bit of its flags byte
    return (flags & UV_FLAG) !== 0;
  } catch {
    return false;
  }
};

/**
 * What a session Better Auth makes says about the sign-in, by the endpoint that made it. The password alone is
 * `pwd`; for a person with an authenticator app it is `pwd mfa`, since Better Auth keeps that session only on a device
 * the code trusted within 30 days (otherwise it is deleted at once for the code's step). The code itself, or a backup
 * code, is `pwd otp mfa`. A passkey is `pop`, and `pop mfa` when it verified the person. A session made anew for a
 * signed-in person (a new password, the authenticator app turned on) keeps what the one before it said, and one made
 * by an endpoint not listed here says nothing.
 */
export const amrForSignIn = (input: {
  path: string;
  authenticatorData: string | null;
  twoFactorEnabled: boolean;
  current: string | null;
}): string | null => {
  switch (input.path) {
    case "/sign-in/email": {
      return input.twoFactorEnabled ? "pwd mfa" : "pwd";
    }

    case "/two-factor/verify-totp":
    case "/two-factor/verify-backup-code": {
      return "pwd otp mfa";
    }

    case "/passkey/verify-authentication": {
      return passkeyVerifiedUser(input.authenticatorData) ? "pop mfa" : "pop";
    }

    default: {
      return input.current;
    }
  }
};

/** A session's `amr` column as the list an ID token carries: empty for a session that recorded nothing. */
export const amrList = (amr: string | null | undefined): string[] =>
  (amr ?? "").split(" ").filter(Boolean);

/** The session row's `amr` before the hook: what its maker asked for (`startSession`), or nothing. */
const amrAsked = (session: ReturnType<typeof parseJsonObject>): string | null =>
  stringOrNull(session.amr) || null;

// ---------- the Better Auth instance ----------

type RateLimitStorage = NonNullable<
  NonNullable<BetterAuthOptions["rateLimit"]>["customStorage"]
>;

/** What a rate-limit key holds in KV: how many requests since the window began. */
interface Bucket {
  count: number;
  start: number;
}

/**
 * Better Auth's rate limits on KV, per client and path (`/api/auth/sign-in/email`, a passkey's verification, a
 * two-factor code): a fixed window read and written back, which two requests in the same instant can both pass.
 * A brake, not a lock, as the password form's own throttle below is; KV keeps a key for a minute at least.
 */
const kvRateLimit = (kv: KVNamespace): RateLimitStorage => ({
  consume: async (key, rule) => {
    const now = Date.now();
    const kvKey = `ratelimit:${key}`;
    const raw = await kv.get(kvKey);
    let bucket: Bucket = { count: 0, start: now };

    if (raw) {
      // SAFETY: `ratelimit:<key>` is written only below, as the JSON of a Bucket.
      const kept = JSON.parse(raw) as Bucket;

      if (now - kept.start < rule.window * 1000) {
        bucket = kept;
      }
    }

    bucket.count += 1;
    await kv.put(kvKey, JSON.stringify(bucket), {
      expirationTtl: Math.max(60, rule.window),
    });

    if (bucket.count > rule.max) {
      return {
        allowed: false,
        retryAfter: Math.max(
          1,
          Math.ceil((bucket.start + rule.window * 1000 - now) / 1000)
        ),
      };
    }

    return { allowed: true, retryAfter: null };
  },
});

/** The prefix of the ids Better Auth makes, per model, in the style of the app's own (`usr_`, `th_`, `dn_`). */
const ID_PREFIXES: ReadonlyMap<string, string> = new Map([
  ["user", "usr"],
  ["session", "ses"],
  ["account", "acc"],
  ["verification", "ver"],
  ["passkey", "pk"],
  ["twoFactor", "tfa"],
]);

/**
 * Better Auth and its plugins, loaded on first use rather than with the Worker: the module graph is large, and the
 * test pool, which evaluates the whole Worker for every test file, lost a runner now and then while loading it at
 * start; a Worker that serves mail alone never needs it.
 */
const loadBetterAuth = () =>
  Promise.all([
    import("better-auth"),
    import("better-auth/adapters/drizzle"),
    import("better-auth/plugins"),
    import("@better-auth/passkey"),
  ]);

/** The Better Auth instance for this Worker's bindings: its database, secret, address and plugins. */
export const createAuth = async (env: Env, db: Database = createDb(env.DB)) => {
  const { origin, hostname } = new URL(env.APP_URL);

  const [
    { betterAuth },
    { drizzleAdapter },
    { bearer, twoFactor },
    { passkey },
  ] = await loadBetterAuth();

  return betterAuth({
    appName: env.APP_NAME,
    baseURL: env.APP_URL,
    basePath: AUTH_PATH,
    secret: env.SESSION_SECRET,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        passkey: passkeys,
        twoFactor: twoFactors,
      },
    }),
    trustedOrigins: [origin],
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      // Admins make the mailboxes (Settings → People); nobody signs up.
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 200,
      // The app's own PBKDF2, so a hash the admin script or the seed wrote signs in too.
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) => verifyPassword(password, hash),
      },
    },
    session: {
      // How the person signed in (`amrForSignIn`), written by the hook below and never by a client.
      additionalFields: {
        amr: { type: "string", required: false, input: false },
      },
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: 60 * 60 * 24,
      // Every request reads the session row: "Sign out everywhere" and a new password end a session at once, not
      // when a cached cookie runs out.
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": { window: 15 * 60, max: 20 },
        "/two-factor/verify-totp": { window: 15 * 60, max: 10 },
        "/two-factor/verify-backup-code": { window: 15 * 60, max: 10 },
        "/passkey/verify-authentication": { window: 15 * 60, max: 20 },
      },
      customStorage: kvRateLimit(env.KV),
    },
    // Sign-up, Better Auth's own password reset and email verification are off: admins make the mailboxes, and a
    // forgotten password goes through the recovery addresses (`recovery.server.ts`). Its change-password endpoint is
    // off too: the person's own change goes through `changeOwnPassword`, which calls `auth.api.changePassword` on the
    // server (these paths close only the HTTP routes) and then ends the reset links mailed before (`revoke`).
    disabledPaths: [
      "/change-password",
      "/sign-up/email",
      "/request-password-reset",
      "/reset-password",
      "/reset-password/:token",
      "/forget-password",
      "/forget-password/callback",
      "/send-verification-email",
      "/verify-email",
      "/change-email",
      "/delete-user",
      "/delete-user/callback",
      // With Duo on, a password sign-in goes through `passwordSignIn` and Duo's prompt alone: Better Auth's own
      // HTTP route would hand out a session on the password, without Duo. The server still calls `signInEmail`
      // when Duo cannot take sign-ins and the person's authenticator app stands in for it.
      ...(duoEnabled(env) ? ["/sign-in/email"] : []),
    ],
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      database: {
        generateId: ({ model }) => newId(ID_PREFIXES.get(model) ?? "ba"),
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Deactivated people keep their mail but cannot sign in, by any way in.
          // Each session also records how the person signed in (`amrForSignIn`), unless its maker named it
          // (`startSession`, after Duo).
          before: async (session, context) => {
            const row = await db.query.users.findFirst({
              columns: { active: true, twoFactorEnabled: true, kind: true },
              where: eq(users.id, session.userId),
            });

            // A group inbox has no password or passkey, but nobody is ever signed in as one, whatever goes wrong.
            if (row?.kind === "group") {
              throw new APIError("FORBIDDEN", {
                message: "A group inbox cannot sign in.",
                code: "GROUP_SIGN_IN",
              });
            }

            if (!row?.active) {
              throw new APIError("FORBIDDEN", {
                message:
                  "This account has been deactivated. Ask an admin to reactivate it.",
                code: "ACCOUNT_DEACTIVATED",
              });
            }

            const amr =
              amrAsked(session) ??
              (context
                ? amrForSignIn({
                    path: context.path ?? "",
                    authenticatorData: assertionAuthenticatorData(
                      isJsonObject(context.body) ? context.body : null
                    ),
                    twoFactorEnabled: row.twoFactorEnabled,
                    // A session made anew for a signed-in person keeps what the one before it said.
                    current: stringOrNull(context.context.session?.session.amr),
                  })
                : null);

            return { data: { ...session, amr } };
          },
          // When the person last signed in, for the People page.
          after: async (session) => {
            await db
              .update(users)
              .set({ lastSignInAt: nowIso() })
              .where(eq(users.id, session.userId));
          },
        },
      },
    },
    plugins: [
      twoFactor({ issuer: env.APP_NAME }),
      passkey({ rpID: hostname, rpName: env.APP_NAME, origin }),
      // The API for other clients (`app/lib/api/api.server.ts`): `Authorization: Bearer <session token>`.
      bearer(),
    ],
  });
};

export type WorkspaceAuth = Awaited<ReturnType<typeof createAuth>>;

const instances = new WeakMap<Env, Promise<WorkspaceAuth>>();

/** The instance for these bindings, made once per isolate: the tests' stand-in envs each get their own. */
export const authFor = (env: Env): Promise<WorkspaceAuth> => {
  let auth = instances.get(env);

  if (!auth) {
    auth = createAuth(env);
    instances.set(env, auth);
  }

  return auth;
};

/** Whether a request is for Better Auth: `/api/auth/*`. */
export const isAuthPath = (pathname: string): boolean =>
  pathname === AUTH_PATH || pathname.startsWith(`${AUTH_PATH}/`);

// ---------- the session a request carries ----------

/** Not `request.server.ts`'s: that module pulls in TanStack Start, which the tests cannot load. */
export const isSecure = (request: Request): boolean =>
  new URL(request.url).protocol === "https:";

/**
 * Whether a form post comes from a page on this origin, or from no browser at all. A browser names where a post
 * comes from in `Sec-Fetch-Site` (or only `Origin`, before it sent that), and a script such as the smoke test sends
 * neither. Only `same-origin` passes: another site on the same registrable domain is `same-site` and has no business
 * signing anyone in here either. The password form (`passwordSignIn`) and the two-factor page ask it first: Start's
 * CSRF middleware checks server functions only, not a route's own handlers.
 */
export const sameOriginPost = (request: Request) => {
  const site = request.headers.get("sec-fetch-site");

  if (site !== null) {
    return site === "same-origin";
  }

  const origin = request.headers.get("origin");

  return origin === null || origin === new URL(request.url).origin;
};

export const readCookie = (request: Request, name: string): string | null => {
  const header = request.headers.get("cookie") ?? "";

  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");

    if (k === name) {
      return decodeURIComponent(v.join("="));
    }
  }

  return null;
};

/** The person behind the request's session cookie (or bearer token), while they are active; else null. */
export const getSessionUser = async (
  request: Request,
  env: Env,
  db: Database
): Promise<User | null> => {
  const auth = await authFor(env);
  const session = await auth.api.getSession({ headers: request.headers });

  if (!session) {
    return null;
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
  });

  return user?.active ? user : null;
};

/** Who is signed in on a request, and how: what the identity provider puts in an ID token (`sid`, `auth_time`, `amr`). */
export interface SessionIdentity {
  user: User;
  /** The session's id: the ID token's `sid`. */
  sid: string;
  /** When the person signed in, in seconds since the epoch: the ID token's `auth_time`. */
  authTime: number;
  amr: string[];
}

/** The person behind the request's session, with the session's own facts; null without an active person. */
export const getSessionIdentity = async (
  request: Request,
  env: Env,
  db: Database
): Promise<SessionIdentity | null> => {
  const auth = await authFor(env);
  const found = await auth.api.getSession({ headers: request.headers });

  if (!found) {
    return null;
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, found.user.id),
  });

  if (!user?.active) {
    return null;
  }

  return {
    user,
    sid: found.session.id,
    authTime: Math.floor(new Date(found.session.createdAt).getTime() / 1000),
    amr: amrList(found.session.amr),
  };
};

/** The HMAC better-call signs a cookie's value with, as Better Auth reads its session cookie back. */
const signCookieValue = async (value: string, secret: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))
  );

  return encodeURIComponent(
    `${value}.${btoa(String.fromCodePoint(...signature))}`
  );
};

/**
 * A session for a sign-in the workspace confirmed itself rather than through Better Auth (the password, then Duo:
 * `duo.server.ts`), saying how (`amr`), and the `Set-Cookie` that carries it, as Better Auth would have written it.
 * The session hook still refuses a deactivated person.
 */
export const startSession = async (
  request: Request,
  env: Env,
  userId: string,
  amr: Amr
): Promise<string> => {
  const auth = await authFor(env);
  const context = await auth.$context;

  const session = await context.internalAdapter.createSession(userId, false, {
    amr: amr.join(" "),
    ipAddress: request.headers.get("cf-connecting-ip"),
    userAgent: request.headers.get("user-agent"),
  });

  const cookie = context.authCookies.sessionToken;
  const { attributes } = cookie;

  return [
    `${cookie.name}=${await signCookieValue(session.token, context.secret)}`,
    `Max-Age=${context.sessionConfig.expiresIn}`,
    `Path=${attributes.path ?? "/"}`,
    attributes.httpOnly === false ? null : "HttpOnly",
    `SameSite=${attributes.sameSite ?? "Lax"}`,
    attributes.secure ? "Secure" : null,
  ]
    .filter(Boolean)
    .join("; ");
};

/**
 * Signs the browser out of the session the request carries, through Better Auth: the row goes, and the answer's
 * `Set-Cookie` headers clear the cookie. Nothing to end answers no headers.
 */
export const endCurrentSession = async (
  request: Request,
  env: Env
): Promise<string[]> => {
  const auth = await authFor(env);

  if (!(await auth.api.getSession({ headers: request.headers }))) {
    return [];
  }

  const res = await auth.api.signOut({
    headers: request.headers,
    asResponse: true,
  });

  return res.headers.getSetCookie();
};

export const requireUser = async (
  request: Request,
  env: Env,
  db: Database
): Promise<User> => {
  const user = await getSessionUser(request, env, db);

  if (!user) {
    const url = new URL(request.url);
    throw redirect({
      to: "/login",
      search: { next: url.pathname + url.search },
    });
  }

  return user;
};

// ---------- passwords and sessions of a person ----------

/** Whether `password` is the person's: their `credential` account's hash. */
export const checkPassword = async (
  db: Database,
  userId: string,
  password: string
): Promise<boolean> => {
  const account = await db.query.accounts.findFirst({
    columns: { password: true },
    where: and(
      eq(accounts.userId, userId),
      eq(accounts.providerId, PASSWORD_PROVIDER)
    ),
  });

  return account?.password ? verifyPassword(password, account.password) : false;
};

/** The person's `credential` account made, or its hash replaced. */
const writePasswordHash = async (
  db: Database,
  userId: string,
  hash: string
): Promise<void> => {
  const existing = await db.query.accounts.findFirst({
    columns: { id: true },
    where: and(
      eq(accounts.userId, userId),
      eq(accounts.providerId, PASSWORD_PROVIDER)
    ),
  });

  await (existing
    ? db
        .update(accounts)
        .set({ password: hash, updatedAt: new Date() })
        .where(eq(accounts.id, existing.id))
    : db.insert(accounts).values({
        id: newId("acc"),
        accountId: userId,
        providerId: PASSWORD_PROVIDER,
        userId,
        password: hash,
      }));
};

/** The first password of a new person: their `credential` account, with no session to end. */
export const createPasswordAccount = async (
  db: Database,
  userId: string,
  password: string
): Promise<void> => {
  await writePasswordHash(db, userId, await hashPassword(password));
};

/**
 * What a revocation ends, per reason. What the old credentials allowed is of two kinds: a session, a browser that
 * signed in with them, and a reset link, a way to a new password mailed while they held (30 minutes, to every
 * confirmed recovery address). A reset link names the person and not the address it went to, so whatever voids one
 * voids them all.
 */
const REVOCATIONS = {
  // Nothing about the password changed, so the links to reset it stay; every browser signs in again.
  "sign-out-everywhere": { sessions: true, resetLinks: false },
  // An admin's one-time password or a recovery reset: whoever knew the old password may hold a session, and a link
  // mailed before would set yet another password over the new one.
  "new-password": { sessions: true, resetLinks: true },
  // The person's own change in Settings: Better Auth's `changePassword` has already ended the other sessions and
  // keeps this browser signed in, but knows nothing of the reset links.
  "own-password-change": { sessions: false, resetLinks: true },
  // No way in while deactivated, and none from before once reactivated.
  deactivation: { sessions: true, resetLinks: true },
  // A confirmed address taken off the list: someone removes one when that inbox is no longer theirs.
  "recovery-address-removed": { sessions: false, resetLinks: true },
} as const satisfies Record<string, { sessions: boolean; resetLinks: boolean }>;

/** Why a person's credentials changed, which decides what a revocation ends. */
export type RevocationReason = keyof typeof REVOCATIONS;

/**
 * A revocation: what the person's old credentials allowed ends, as far as the reason reaches. A session is read on
 * every request and a reset link when it is spent, so both stop working at once.
 */
export const revoke = async (
  db: Database,
  userId: string,
  reason: RevocationReason
): Promise<void> => {
  const ends = REVOCATIONS[reason];

  if (ends.sessions) {
    await db.delete(sessions).where(eq(sessions.userId, userId));
  }

  if (ends.resetLinks) {
    await db
      .delete(recoveryTokens)
      .where(
        and(
          eq(recoveryTokens.userId, userId),
          eq(recoveryTokens.purpose, "reset-password")
        )
      );
  }
};

/** One browser signed out from Settings → Account. Only a session of the person's own ends, whatever id is posted. */
export const endSession = async (
  db: Database,
  userId: string,
  sessionId: string
): Promise<void> => {
  await db
    .delete(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
};

/**
 * Every browser the person is signed in on, newest first, with the one this request came on marked, for Settings
 * → Account. The tokens themselves never leave the server.
 */
export const listSessions = async (
  request: Request,
  env: Env,
  db: Database,
  userId: string
) => {
  const rows = await db.query.sessions.findMany({
    where: eq(sessions.userId, userId),
    orderBy: (s, { desc }) => [desc(s.createdAt)],
  });

  const auth = await authFor(env);
  const current = await auth.api.getSession({ headers: request.headers });

  return rows.map((s) => ({
    id: s.id,
    userAgent: s.userAgent,
    ipAddress: s.ipAddress,
    createdAt: s.createdAt.toISOString(),
    current: s.token === current?.session.token,
  }));
};

/**
 * A new password for the person: an admin's one-time password or a recovery reset. The old one may be known to
 * someone else, so the sessions and reset links it allowed end. The person's own change in Settings goes through
 * Better Auth (`changeOwnPassword`) instead, which keeps the browser it was changed in signed in.
 */
export const setPassword = async (
  db: Database,
  userId: string,
  password: string
): Promise<void> => {
  await writePasswordHash(db, userId, await hashPassword(password));
  await revoke(db, userId, "new-password");
};

/** An admin's way out for someone who lost their authenticator: the second factor off, its secret and codes gone. */
export const resetTwoFactor = async (
  db: Database,
  userId: string
): Promise<void> => {
  await db.delete(twoFactors).where(eq(twoFactors.userId, userId));
  await db
    .update(users)
    .set({ twoFactorEnabled: false, updatedAt: new Date() })
    .where(eq(users.id, userId));
};

/** An admin's way out for someone who lost the device their passkeys live on: every passkey gone, the count answered. */
export const removeAllPasskeys = async (
  db: Database,
  userId: string
): Promise<number> => {
  const rows = await db
    .delete(passkeys)
    .where(eq(passkeys.userId, userId))
    .returning({ id: passkeys.id });

  return rows.length;
};

// ---------- sign-in throttling (KV) ----------

const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_SECONDS = 15 * 60;

const loginKey = (ip: string | null, email: string): string =>
  `login:fail:${ip ?? "unknown"}:${email.toLowerCase()}`;

/** True when this client + email has exhausted its failed attempts for the window. KV is eventually consistent, which is fine for a brake. */
export const loginThrottled = async (
  kv: KVNamespace,
  ip: string | null,
  email: string
): Promise<boolean> => {
  const raw = await kv.get(loginKey(ip, email));

  return Number(raw ?? 0) >= LOGIN_MAX_FAILURES;
};

export const recordLoginFailure = async (
  kv: KVNamespace,
  ip: string | null,
  email: string
): Promise<void> => {
  const key = loginKey(ip, email);
  const n = Number((await kv.get(key)) ?? 0) + 1;
  await kv.put(key, String(n), { expirationTtl: LOGIN_WINDOW_SECONDS });
};

export const clearLoginFailures = async (
  kv: KVNamespace,
  ip: string | null,
  email: string
): Promise<void> => {
  await kv.delete(loginKey(ip, email));
};
