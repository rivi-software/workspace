import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { createDb } from "~/db";
import { aliases, users } from "~/db/schema";
import type { User } from "~/db/schema";
import {
  authFor,
  createPasswordAccount,
  getSessionUser,
  sessionCookieName,
} from "~/lib/auth.server";
import type { ParsedMail } from "~/lib/mail/ingest.server";

import { stubEnv } from "./stub-env";

export const db = createDb(env.DB);

/** The value a test's setup produced, or a thrown error naming what it lacked, instead of a `!` that lets `undefined` run on. */
export const defined = <T>(value: T | null | undefined, what = "value"): T => {
  if (value === null || value === undefined) {
    throw new Error(`Expected a ${what}, got ${String(value)}`);
  }

  return value;
};

/** What a promise rejects with (a thrown non-Error wrapped in one), or null when it resolves: a test collects it to assert once. */
export const rejection = async (
  promise: Promise<unknown>
): Promise<Error | null> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }

  return null;
};

/** What `run` throws (a thrown non-Error wrapped in an Error), or null when it returns. */
export const thrown = (run: () => void): Error | null => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }

  return null;
};

/** The password every test mailbox signs in with. */
export const PASSWORD = "password";

/** A mailbox on the configured domain (the tests pin `vars`), created once per address, with the password "password". */
export const mailbox = async (
  local: string,
  name = local,
  extra: string[] = []
): Promise<User> => {
  const email = `${local}@${env.MAIL_DOMAIN}`;

  const existing = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (existing) {
    return existing;
  }

  const id = `usr_${local}`;
  await db.insert(users).values({ id, email, name });
  await createPasswordAccount(db, id, PASSWORD);

  if (extra.length > 0) {
    await db
      .insert(aliases)
      .values(extra.map((address) => ({ address, userId: id })));
  }

  return defined(await db.query.users.findFirst({ where: eq(users.id, id) }));
};

/** The session cookie's name, as Better Auth sets it on the tests' https origin (`__Secure-workspace.session_token`). */
export const SESSION_COOKIE = sessionCookieName(env);

/** The `Set-Cookie` of Better Auth's answer that carries the session, as a `cookie` header value. */
export const sessionCookieOf = (res: Response): string | null => {
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));

  return cookie ? defined(cookie.split(";")[0]) : null;
};

/**
 * A browser signed in as the person through Better Auth's password sign-in (the fixture's password): the `cookie`
 * header its requests carry. `env` names the bindings the sign-in runs on, a stand-in's included.
 */
export const sessionFor = async (
  user: User,
  options: { env?: Env; password?: string } = {}
): Promise<string> => {
  const auth = await authFor(options.env ?? env);

  const res = await auth.api.signInEmail({
    body: { email: user.email, password: options.password ?? PASSWORD },
    headers: new Headers({ origin: new URL(env.APP_URL).origin }),
    asResponse: true,
  });

  return defined(sessionCookieOf(res), `a session for ${user.email}`);
};

/** The session token itself, for a bearer `Authorization` header (the API's tests). */
export const tokenOf = (cookie: string): string =>
  decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1)).split(".")[0] ??
  "";

/** Who a browser sending this `cookie` header is signed in as, or null. */
export const userOf = (cookie: string) =>
  getSessionUser(new Request(env.APP_URL, { headers: { cookie } }), env, db);

let counter = 0;

const nextCounter = () => {
  counter += 1;

  return counter;
};

/** A parsed inbound message with sensible defaults, as `parseRawEmail` would return it. */
export const mail = (over: Partial<ParsedMail> = {}): ParsedMail => {
  counter += 1;

  return {
    messageId: `<m${counter}.${Date.now()}@acme.com>`,
    inReplyTo: null,
    references: [],
    from: { email: "jane@acme.com", name: "Jane Doe" },
    to: [{ email: `rik@${env.MAIL_DOMAIN}`, name: null }],
    cc: [],
    replyTo: null,
    subject: `Hello ${counter}`,
    text: `Message ${counter}`,
    html: null,
    date: new Date().toISOString(),
    attachments: [],
    size: 100,
    unsubscribe: null,
    automated: false,
    signals: null,
    ...over,
  };
};

/** A raw RFC 5322 message for the parser and the email handler. */
export const rawMail = (options: {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  messageId?: string;
  inReplyTo?: string;
  html?: string;
  /** The Date header; now when not given. */
  date?: Date;
  /** Header lines above the rest, as the receiving MX writes its own (`Authentication-Results: …`). */
  received?: string[];
}): string => {
  const id = options.messageId ?? `<raw${nextCounter()}@acme.com>`;

  const lines = [
    ...(options.received ?? []),
    `From: ${options.from ?? '"Jane Doe" <jane@acme.com>'}`,
    `To: ${options.to ?? `rik@${env.MAIL_DOMAIN}`}`,
    `Subject: ${options.subject ?? "Raw subject"}`,
    `Message-ID: ${id}`,
    options.inReplyTo ? `In-Reply-To: ${options.inReplyTo}` : null,
    `Date: ${(options.date ?? new Date()).toUTCString()}`,
  ].filter((l): l is string => !!l);

  if (options.html) {
    const boundary = "b0undary";
    lines.push(
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      "",
      options.body ?? "Plain text",
      `--${boundary}`,
      'Content-Type: text/html; charset="utf-8"',
      "",
      options.html,
      `--${boundary}--`
    );
  } else {
    lines.push(
      'Content-Type: text/plain; charset="utf-8"',
      "",
      options.body ?? "Hi there"
    );
  }

  return lines.join("\r\n");
};

/** The shape the Email Workers runtime hands `email()`: the raw stream, the envelope, and a reject that records its reason. */
export const forwardable = (raw: string, from: string, to: string) => {
  const rejected: string[] = [];
  const bytes = new TextEncoder().encode(raw);

  const message: ForwardableEmailMessage = {
    from,
    to,
    headers: new Headers(),
    raw: new Blob([bytes]).stream(),
    rawSize: bytes.byteLength,
    setReject: (reason: string) => {
      rejected.push(reason);
    },
    forward: () => Promise.resolve({ messageId: "" }),
    reply: () => Promise.resolve({ messageId: "" }),
  };

  return { message, rejected };
};

/** A recording EMAIL binding: what the code sends, without Email Service. */
export const recordingEmail = (fail?: string, messageId?: string) => {
  const sent: EmailMessageBuilder[] = [];

  const binding = {
    send(message: EmailMessageBuilder) {
      if (fail) {
        return Promise.reject(
          Object.assign(new Error(fail), { code: "EMAIL_FAILED" })
        );
      }

      sent.push(message);

      return Promise.resolve({
        messageId: messageId ?? `<sent${nextCounter()}@${env.MAIL_DOMAIN}>`,
      });
    },
  };

  return { sent, env: stubEnv({ ...env, EMAIL: binding }) };
};

/** Whether `promise` rejects with a message containing `text`. */
export const rejectionIncludes = async (
  promise: Promise<unknown>,
  text: string
): Promise<boolean> => {
  const error = await rejection(promise);

  return error?.message.includes(text) ?? false;
};

/** Whether `promise` rejects with a message matching `pattern`. */
export const rejectionMatches = async (
  promise: Promise<unknown>,
  pattern: RegExp
): Promise<boolean> => {
  const error = await rejection(promise);

  return pattern.test(error?.message ?? "");
};

/** A JSON value, what a parsed body or a request's params can hold. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/** The query string for the params that are set; an `undefined` one leaves its key out. */
export const queryOf = (
  params: Record<string, string | undefined>
): URLSearchParams =>
  new URLSearchParams(
    Object.entries(params).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]]
    )
  );

/** A sorted copy, as `toSorted` makes (the tests' lib stops short of ES2023). */
export const sorted = <T>(
  items: readonly T[],
  compare?: (a: T, b: T) => number
): T[] =>
  // oxlint-disable-next-line unicorn/no-array-sort -- a copy is sorted; `toSorted` is not in the ES2022 lib the tests compile against
  [...items].sort(compare);
