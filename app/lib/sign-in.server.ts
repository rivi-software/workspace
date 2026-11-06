import { eq } from "drizzle-orm";

import type { Database } from "~/db";
import { users } from "~/db/schema";
import { isJsonObject } from "~/lib/guards";

import {
  authFor,
  clearLoginFailures,
  loginThrottled,
  recordLoginFailure,
  sameOriginPost,
} from "./auth.server";

export type SignInError = "invalid" | "throttled" | "inactive" | "two-factor";

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

/**
 * The password form of `/login`: only from this origin, throttled per client and address, then Better Auth's
 * password sign-in, which answers the session cookie, or the two-factor cookie when the person has an authenticator
 * app (then `/two-factor` takes the code). The route is outside Start's CSRF middleware, which only checks server
 * functions.
 */
export const passwordSignIn = async (
  request: Request,
  env: Env,
  db: Database,
  input: { email: string; password: string; next: string }
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
    columns: { active: true },
    where: eq(users.email, email),
  });

  if (person && !person.active) {
    return back("inactive");
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
