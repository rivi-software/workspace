import { eq } from "drizzle-orm";

import type { Database } from "~/db";
import { sessions, users } from "~/db/schema";
import { isJsonObject } from "~/lib/guards";

import {
  authFor,
  checkPassword,
  clearLoginFailures,
  loginThrottled,
  recordLoginFailure,
  sameOriginPost,
  startSession,
} from "./auth.server";
import { duoEnabled, duoStep } from "./duo.server";
import type { DuoOptions } from "./duo.server";

export type SignInError =
  | "invalid"
  | "throttled"
  | "inactive"
  | "two-factor"
  | "duo"
  | "duo-unavailable";

/** Where a password sign-in continues when the person has an authenticator app: the code's page. */
export const TWO_FACTOR_PATH = "/two-factor";

/**
 * Where a sign-in continues: a path on this host, never another site. `next` is resolved against `origin` the way
 * the browser resolves the Location header, so a value it reads as another origin (`/\evil.test`, or
 * `/<tab>/evil.test` once the tab is dropped) goes to Mail, and only the resolved path, query and fragment are
 * kept. A path that resolves to `//…` (`/.//evil.test`) is refused too: as a Location header it is another origin
 * again.
 */
export const safeNext = (next: string, origin: string) => {
  if (!next.startsWith("/") || next.includes("\\")) {
    return "/mail";
  }

  const url = URL.parse(next, origin);

  if (url?.origin !== origin || url.pathname.startsWith("//")) {
    return "/mail";
  }

  return `${url.pathname}${url.search}${url.hash}`;
};

/** A 302 to `location` that carries every `Set-Cookie` of Better Auth's answer: the session, or the two-factor step. */
export const redirectWithCookies = (
  location: string,
  from: Response | null
): Response => {
  const headers = new Headers({ Location: location });

  for (const cookie of from?.headers.getSetCookie() ?? []) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(null, { status: 302, headers });
};

/** Whether Better Auth's sign-in answer asks for the second factor before there is a session. */
const asksForSecondFactor = async (res: Response): Promise<boolean> => {
  try {
    const body: unknown = await res.clone().json();

    return isJsonObject(body) && body.twoFactorRedirect === true;
  } catch {
    return false;
  }
};

/** The session this browser has, which signing in again for an application (`reauth`) replaces once the new one stands. */
const sessionToReplace = async (
  request: Request,
  env: Env,
  reauth: boolean
): Promise<string | null> => {
  if (!reauth) {
    return null;
  }

  const auth = await authFor(env);
  const current = await auth.api.getSession({ headers: request.headers });

  return current?.session.id ?? null;
};

const endReplaced = async (db: Database, sessionId: string | null) => {
  if (sessionId) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  }
};

/**
 * The password form of `/login`: only from this origin, throttled per client and address, then the second factor.
 * With Duo set up (`duo.server.ts`), the workspace checks the password itself and sends the browser to Duo's prompt,
 * whose answer `/auth/duo` turns into the session. Without Duo, Better Auth's password sign-in answers the session
 * cookie, or the two-factor cookie when the person has an authenticator app (then `/two-factor` takes the code). A
 * passkey signs in on its own, from the page, either way. `reauth` is a fresh sign-in an application asked for
 * (`prompt=login`, docs/SSO.md): the session this browser had ends once the new one stands. The route is outside
 * Start's CSRF middleware, which only checks server functions.
 */
// oxlint-disable-next-line eslint/complexity -- one sign-in: the origin, the throttle, the person, then the second factor of the workspace's choice, each step in turn
export const passwordSignIn = async (
  request: Request,
  env: Env,
  db: Database,
  input: { email: string; password: string; next: string; reauth?: boolean },
  options: DuoOptions = {}
): Promise<Response> => {
  // A form on another site would sign this browser in to the account it names (login CSRF), so it is refused
  // before anything is checked, counted or started.
  if (!sameOriginPost(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  const email = input.email.toLowerCase().trim();
  const next = safeNext(input.next, new URL(request.url).origin);
  const ip = request.headers.get("cf-connecting-ip");

  const back = (error: SignInError) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/login?${new URLSearchParams({ next, error })}` },
    });

  if (await loginThrottled(env.KV, ip, email)) {
    return back("throttled");
  }

  // A deactivated person is told so, whatever they typed: their mail stays, their sign-in does not.
  const person = await db.query.users.findFirst({
    columns: {
      id: true,
      email: true,
      name: true,
      active: true,
      twoFactorEnabled: true,
    },
    where: eq(users.email, email),
  });

  if (person && !person.active) {
    return back("inactive");
  }

  const replaces = await sessionToReplace(request, env, input.reauth === true);

  if (duoEnabled(env)) {
    if (!person || !(await checkPassword(db, person.id, input.password))) {
      await recordLoginFailure(env.KV, ip, email);

      return back("invalid");
    }

    await clearLoginFailures(env.KV, ip, email);

    const step = await duoStep(
      env,
      request,
      person,
      { userId: person.id, next, replaces },
      options
    );

    if (step.kind === "prompt") {
      return step.response;
    }

    if (step.kind === "unavailable") {
      return back("duo-unavailable");
    }

    // Duo cannot take sign-ins now: the person's authenticator app stands in for it through Better Auth's sign-in
    // below, or, where `DUO_FAIL_OPEN` allows it, the password alone.
    if (!person.twoFactorEnabled) {
      const cookie = await startSession(request, env, person.id, ["pwd"]);

      await endReplaced(db, replaces);

      return new Response(null, {
        status: 302,
        headers: { Location: next, "Set-Cookie": cookie },
      });
    }
  }

  const auth = await authFor(env);

  const res = await auth.api.signInEmail({
    body: { email, password: input.password },
    headers: request.headers,
    asResponse: true,
  });

  if (!res.ok) {
    await recordLoginFailure(env.KV, ip, email);

    return back(res.status === 429 ? "throttled" : "invalid");
  }

  await clearLoginFailures(env.KV, ip, email);

  if (await asksForSecondFactor(res)) {
    return redirectWithCookies(
      `${TWO_FACTOR_PATH}?${new URLSearchParams({ next })}`,
      res
    );
  }

  await endReplaced(db, replaces);

  return redirectWithCookies(next, res);
};

/** The two-factor page's form: the authenticator's code, or one of the backup codes, then the session. */
export const secondFactorSignIn = async (
  request: Request,
  env: Env,
  input: { code: string; backup: boolean; trust: boolean; next: string }
): Promise<Response> => {
  if (!sameOriginPost(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  const next = safeNext(input.next, new URL(request.url).origin);
  const code = input.code.replaceAll(/\s+/gu, "");
  const auth = await authFor(env);

  const res = input.backup
    ? await auth.api.verifyBackupCode({
        body: { code, trustDevice: input.trust },
        headers: request.headers,
        asResponse: true,
      })
    : await auth.api.verifyTOTP({
        body: { code, trustDevice: input.trust },
        headers: request.headers,
        asResponse: true,
      });

  if (!res.ok) {
    const error = res.status === 429 ? "throttled" : "two-factor";

    return new Response(null, {
      status: 302,
      headers: {
        Location: `${TWO_FACTOR_PATH}?${new URLSearchParams({ next, error })}`,
      },
    });
  }

  return redirectWithCookies(next, res);
};
