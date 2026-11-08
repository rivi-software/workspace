/**
 * What a visitor proves: someone outside the workspace on a page under `/s/`, opened by the token in its address. A
 * link (`links.server.ts`, #2836) and a signing request's customer page (`signing.server.ts`, #2974) both come
 * through here, each with its own `Visits`: its table, its counters, its pass and its code's mail. This module keeps:
 *
 * - the lookup of a token, throttled per client: one whose tokens opened nothing `LOOKUP_MISSES` times in
 *   `THROTTLE_SECONDS` is refused before any lookup (`admit`), and a route that serves bytes answers it 429
 *   (`tooManyRequests`);
 * - the code mailed to confirm an address (an invite's, a customer's): `CODES_PER_HOUR` a row, six digits kept as the
 *   SHA-256 of the row's id and the code, `CODE_TTL_MS`, `CODE_TRIES` tries each taken in one conditional `UPDATE`
 *   before the code is compared, and spent by the right one (`sendCode`, `confirmCode`);
 * - the pass a visitor carries once a proof was right: a sealed cookie naming its row, `Path=/s/`, at most
 *   `PASS_TTL_SECONDS` and never past the row's own end (`passCookie`, `readPasses`);
 * - the page's classic form posts (`visitorPost`): refused from another site by the sign-in form's rule
 *   (`sameOriginPost`), the code's two forms answered, everything answered with a redirect back to the page.
 *
 * What a token opens and what a visitor sees once in stay with each kind: Drive's gate (`openLink`) and a link's
 * password, a signing request's states.
 */
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "~/db";
import { driveLinks, signingRequests } from "~/db/schema";
import { sha256Hex } from "~/lib/crypto";
import {
  defined,
  formText,
  numberOr,
  parseJsonObject,
  stringOrNull,
} from "~/lib/guards";

import { isSecure, sameOriginPost } from "../auth.server";
import { openSecret, sealSecret } from "../secret-box.server";
import { mailOut } from "./mail-out.server";

/** Tokens that open nothing, from one client in `THROTTLE_SECONDS`, before it is refused outright. */
const LOOKUP_MISSES = 30;

/** How long a client's failures count, from the last one. */
const THROTTLE_SECONDS = 15 * 60;

/** A code works this long, for this many tries; one row is mailed this many codes in an hour. */
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_TRIES = 5;
const CODES_PER_HOUR = 5;

/** A pass lasts this long, and never past its row's end. */
const PASS_TTL_SECONDS = 24 * 60 * 60;

/** The tables a visitor proves something on. Both carry the code's columns under the same names. */
const tables = { "drive-link": driveLinks, signing: signingRequests };

/** What this module reads of a row: its id and its code's columns. */
interface ProofRow {
  id: string;
  codeHash: string | null;
  codeExpiresAt: string | null;
  confirmedAt: string | null;
}

/** Where a step of a visitor's came from, for the hooks that record it: null when no request made it (a test). */
interface Step {
  db: Database;
  request: Request | null;
  at: number;
}

/** What one kind of row a visitor opens brings to this module: a link, or a signing request. */
export interface Visits<Row extends ProofRow> {
  /** Picks the row's table, and starts the keys of its counters in KV (`drive-link:miss:…`, `signing:codes:…`). */
  name: keyof typeof tables;
  /**
   * How its pass is sealed and named: the seal's purpose, the cookie's name before the row's id, and the field of the
   * pass that holds the id. Each kind had its own before this module, and keeps it, so a pass made then still opens.
   */
  pass: { seal: string; cookie: string; field: string };
  /** When the row stops opening for a visitor, in milliseconds, or null for no end: a pass never outlives it. */
  endsAt: (row: Row) => number | null;
  /** The address the row's code is mailed to, or null when it asks for none. */
  codeTo: (row: Row) => string | null;
  /** What the code opens, as its mail says: "Your code to open <this>: 123456". */
  codeOpens: (row: Row, env: Env) => string;
  /** What a mailed code, and a confirmed one, leave on record besides: a request's history, a log line. */
  codeSent?: (row: Row, step: Step) => Promise<void> | void;
  confirmed?: (row: Row, step: Step) => Promise<void> | void;
}

/* ---------- throttles ---------- */

const clientOf = (request: Request): string =>
  request.headers.get("cf-connecting-ip") ?? "unknown";

/**
 * Failures from the request's client, counted in KV under `scope` (and `of`, when they are failures at one thing),
 * each kept `THROTTLE_SECONDS` from the last. KV is eventually consistent, which is fine for a brake: two requests in
 * the same instant can both pass.
 */
export const failuresOf = (
  env: Env,
  request: Request,
  scope: string,
  of?: string
) => {
  const key = `${scope}:${clientOf(request)}${of === undefined ? "" : `:${of}`}`;
  const counted = async () => Number((await env.KV.get(key)) ?? 0);

  return {
    reached: async (limit: number) => (await counted()) >= limit,
    add: async () => {
      await env.KV.put(key, String((await counted()) + 1), {
        expirationTtl: THROTTLE_SECONDS,
      });
    },
  };
};

/**
 * What a token opens, through `open` (a link through Drive's gate, a signing request by its token's SHA-256), unless
 * the client is throttled: one whose tokens opened nothing `LOOKUP_MISSES` times in `THROTTLE_SECONDS` is refused
 * before any lookup. A token is 32 random bytes, not something to guess; the count is a brake on whoever tries.
 */
export const admit = async <Row extends ProofRow, T>(
  env: Env,
  request: Request,
  visits: Visits<Row>,
  open: () => Promise<T | null>
): Promise<T | null | "throttled"> => {
  const misses = failuresOf(env, request, `${visits.name}:miss`);

  if (await misses.reached(LOOKUP_MISSES)) {
    return "throttled";
  }

  const found = await open();

  if (!found) {
    await misses.add();
  }

  return found;
};

/** What a route that serves bytes answers a throttled client. */
export const tooManyRequests = () =>
  new Response("too many requests", {
    status: 429,
    headers: {
      "Retry-After": String(THROTTLE_SECONDS),
      "Cache-Control": "no-store",
    },
  });

/* ---------- the mailed code ---------- */

const codeHashOf = (row: ProofRow, code: string) =>
  sha256Hex(`${row.id}:${code}`);

/**
 * A new one-time code for the row, mailed to its address: six digits, `CODE_TTL_MS`, `CODE_TRIES` tries; it replaces
 * the one before. False when the row asks for no code, or had `CODES_PER_HOUR` codes in the last hour already.
 */
export const sendCode = async <Row extends ProofRow>(
  env: Env,
  db: Database,
  visits: Visits<Row>,
  row: Row,
  request: Request | null,
  at = Date.now()
): Promise<boolean> => {
  const to = visits.codeTo(row);

  if (!to) {
    return false;
  }

  const key = `${visits.name}:codes:${row.id}`;
  const sent = Number((await env.KV.get(key)) ?? 0);

  if (sent >= CODES_PER_HOUR) {
    return false;
  }

  await env.KV.put(key, String(sent + 1), { expirationTtl: 3600 });

  const code = String(
    defined(crypto.getRandomValues(new Uint32Array(1))[0], "the first item") %
      1_000_000
  ).padStart(6, "0");

  const table = tables[visits.name];
  await db
    .update(table)
    .set({
      codeHash: await codeHashOf(row, code),
      codeExpiresAt: new Date(at + CODE_TTL_MS).toISOString(),
      codeAttempts: 0,
    })
    .where(eq(table.id, row.id));
  await mailOut(
    env,
    to,
    env.APP_NAME,
    `Your code: ${code}`,
    [
      `Your code to open ${visits.codeOpens(row, env)}: ${code}`,
      "It works once, for 10 minutes. If you did not ask for it, you can ignore this mail.",
    ].join("\n\n")
  );
  await visits.codeSent?.(row, { db, request, at });

  return true;
};

/**
 * Whether `typed` is the row's live code. A wrong one counts against it, and the right one is spent: of two requests
 * with it, one wins.
 */
export const confirmCode = async <Row extends ProofRow>(
  db: Database,
  visits: Visits<Row>,
  row: Row,
  typed: string,
  request: Request | null,
  at = Date.now()
): Promise<boolean> => {
  const code = typed.replaceAll(/\D/gu, "");

  if (
    !row.codeHash ||
    !row.codeExpiresAt ||
    Date.parse(row.codeExpiresAt) <= at
  ) {
    return false;
  }

  const table = tables[visits.name];

  // The try is taken before comparing, in one statement on the row: parallel guesses that all read the same
  // `code_attempts` from `row` still get `CODE_TRIES` tries between them, not each.
  const [tried] = await db
    .update(table)
    .set({ codeAttempts: sql`${table.codeAttempts} + 1` })
    .where(
      and(
        eq(table.id, row.id),
        eq(table.codeHash, row.codeHash),
        sql`${table.codeAttempts} < ${CODE_TRIES}`
      )
    )
    .returning({ id: table.id });

  if (!tried) {
    return false;
  }

  if (code.length !== 6 || (await codeHashOf(row, code)) !== row.codeHash) {
    return false;
  }

  const [spent] = await db
    .update(table)
    .set({
      codeHash: null,
      codeExpiresAt: null,
      codeAttempts: 0,
      confirmedAt: row.confirmedAt ?? new Date(at).toISOString(),
    })
    .where(and(eq(table.id, row.id), eq(table.codeHash, row.codeHash)))
    .returning({ id: table.id });

  if (spent) {
    await visits.confirmed?.(row, { db, request, at });
  }

  return !!spent;
};

/* ---------- the pass a visitor carries ---------- */

/**
 * The cookie that lets a visitor back in without proving it again: sealed, naming its row, until `PASS_TTL_SECONDS`
 * or the row's end, sent only under `/s/`. Whoever reads it still decides on every request what it opens.
 */
export const passCookie = async <Row extends ProofRow>(
  request: Request,
  env: Env,
  visits: Visits<Row>,
  row: Row,
  at = Date.now()
): Promise<string> => {
  const { seal, cookie, field } = visits.pass;

  const end = Math.min(
    at + PASS_TTL_SECONDS * 1000,
    visits.endsAt(row) ?? Infinity
  );

  const value = await sealSecret(
    env,
    seal,
    JSON.stringify({ [field]: row.id, exp: end })
  );

  const maxAge = Math.max(0, Math.floor((end - at) / 1000));

  return `${cookie}${row.id}=${value}; Path=/s/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isSecure(request) ? "; Secure" : ""}`;
};

/** The rows the request's pass cookies are good for: sealed by us, for that row, not past their end. */
export const readPasses = async <Row extends ProofRow>(
  request: Request,
  env: Env,
  visits: Visits<Row>,
  at = Date.now()
): Promise<Set<string>> => {
  const { seal, cookie, field } = visits.pass;
  const out = new Set<string>();
  const header = request.headers.get("cookie") ?? "";

  for (const part of header.split(";").slice(0, 50)) {
    const [name, ...rest] = part.trim().split("=");

    if (!name?.startsWith(cookie)) {
      continue;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- run in turn: the lists are short and their order is kept
    const opened = await openSecret(env, seal, rest.join("="));

    if (!opened) {
      continue;
    }

    // A cookie that does not open to a pass of ours reads as an empty one, and is skipped.
    const pass = parseJsonObject(opened);
    const id = stringOrNull(pass[field]);

    if (
      id !== null &&
      name === `${cookie}${id}` &&
      numberOr(pass.exp, Number.NEGATIVE_INFINITY) > at
    ) {
      out.add(id);
    }
  }

  return out;
};

/* ---------- the page's form posts ---------- */

/** A redirect back to the visitor's page, with what it should show and, once a proof was right, the pass. */
type Back = (params?: Record<string, string>, pass?: string) => Response;

/**
 * A classic form post to a visitor's page, which works without JavaScript. A post from another site is refused (403):
 * only a page on this origin, or no browser at all, posts here (`sameOriginPost`). Everything else is answered with a
 * redirect back to `page.path`, keeping the `page.keep` params of the address posted to, with the `step` to show or
 * the `error` (`throttled`, `code`, `codes`), and the pass once a proof was right.
 *
 * `page.own` answers a form of the page's own first (a link's password), or null to go on. Then `page.row` finds
 * the row the code's forms are for, null when the token opens none that asks for a code: `send-code` mails one,
 * and `code` confirms it.
 */
export const visitorPost = async <Row extends ProofRow>(
  env: Env,
  db: Database,
  request: Request,
  visits: Visits<Row>,
  page: {
    path: string;
    keep?: readonly string[];
    /** The posted form, read once, and only when an answer needs it. */
    form: () => Promise<FormData>;
    own?: (form: FormData, back: Back) => Promise<Response | null>;
    row: () => Promise<Row | null | "throttled">;
  },
  at = Date.now()
): Promise<Response> => {
  if (!sameOriginPost(request)) {
    return new Response(null, { status: 403 });
  }

  const url = new URL(request.url);

  const back: Back = (params: Record<string, string> = {}, pass?: string) => {
    const next = new URLSearchParams();

    for (const name of page.keep ?? []) {
      const value = url.searchParams.get(name);

      if (value) {
        next.set(name, value);
      }
    }

    for (const [k, v] of Object.entries(params)) {
      next.set(k, v);
    }

    const query = next.toString();

    const headers = new Headers({
      Location: `${page.path}${query ? `?${query}` : ""}`,
    });

    if (pass) {
      headers.append("Set-Cookie", pass);
    }

    return new Response(null, { status: 303, headers });
  };

  let posted: FormData | null = null;

  const form = async () => {
    posted ??= await page.form();

    return posted;
  };

  if (page.own) {
    const answered = await page.own(await form(), back);

    if (answered) {
      return answered;
    }
  }

  const row = await page.row();

  if (row === "throttled") {
    return back({ error: "throttled" });
  }

  if (!row) {
    return back();
  }

  const fields = await form();
  const intent = formText(fields, "intent");

  if (intent === "send-code") {
    return (await sendCode(env, db, visits, row, request, at))
      ? back({ step: "code" })
      : back({ step: "code", error: "codes" });
  }

  if (intent === "code") {
    if (
      await confirmCode(db, visits, row, formText(fields, "code"), request, at)
    ) {
      return back({}, await passCookie(request, env, visits, row, at));
    }

    return back({ step: "code", error: "code" });
  }

  return back();
};
