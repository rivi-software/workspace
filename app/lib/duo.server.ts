/**
 * Duo as the second factor of the password sign-in, when it is set up (docs/SSO.md, Second factor): after the password
 * checks out, `/login` sends the browser to Duo's Universal Prompt with the challenge sealed into a cookie, and
 * `/auth/duo` turns Duo's answer into the session. On when `DUO_CLIENT_ID`, `DUO_CLIENT_SECRET` and `DUO_API_HOST` are
 * all set; off, the password sign-in asks for the authenticator app of whoever set one up, as it always did, and a
 * passkey signs in on its own either way. Everything that signs in through the workspace (single sign-on) gets the
 * second factor with it.
 */
import { eq } from "drizzle-orm";

import type { Database } from "~/db";
import { sessions, users } from "~/db/schema";
import type { User } from "~/db/schema";

import { isSecure, startSession } from "./auth.server";
import { DuoClient, finishDuoChallenge, startDuoChallenge } from "./duo/client";
import type { DuoCarry } from "./duo/client";
import { duoEnabled } from "./duo/enabled";

export { duoEnabled } from "./duo/enabled";

export const DUO_CALLBACK_PATH = "/auth/duo";

const CHALLENGE_COOKIE = "workspace_duo";

/** What a test hands in for Duo's own endpoints: a `fetch` of its own (`fakeDuo` in `test/fake-duo.ts`). */
export interface DuoOptions {
  fetch?: typeof fetch;
}

/** Whether the password alone lets someone in while Duo cannot take sign-ins and they have no other second factor. */
const duoFailsOpen = (env: Pick<Env, "DUO_FAIL_OPEN">): boolean => {
  // The vars are typed from wrangler.jsonc as literals; a deployment sets any string, or none (a stub env).
  const value: string | undefined = env.DUO_FAIL_OPEN;

  return value === "true";
};

const duoClient = (env: Env, options: DuoOptions = {}): DuoClient =>
  new DuoClient({
    clientId: env.DUO_CLIENT_ID,
    clientSecret: env.DUO_CLIENT_SECRET,
    apiHost: env.DUO_API_HOST,
    redirectUri: `${env.APP_URL.replace(/\/+$/u, "")}${DUO_CALLBACK_PATH}`,
    fetch: options.fetch,
  });

const challengeCookie = (request: Request) => ({
  name: CHALLENGE_COOKIE,
  path: DUO_CALLBACK_PATH,
  secure: isSecure(request),
});

const redirect = (location: string, cookies: string[] = []): Response => {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
  });

  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(null, { status: 302, headers });
};

/** What the password sign-in does after a right password while Duo is on. */
export type DuoStep =
  /** Duo's prompt: the browser goes there. */
  | { kind: "prompt"; response: Response }
  /** Duo cannot take sign-ins now, and the person's authenticator app (or `DUO_FAIL_OPEN`) stands in for it. */
  | { kind: "without-duo" }
  /** Duo cannot take sign-ins now and nothing stands in for it: the sign-in page says so. */
  | { kind: "unavailable" };

/**
 * The password was right and Duo is on: Duo's prompt for the person when Duo can take it. When it cannot, a person with
 * an authenticator app goes on to their code instead, still two factors; anyone else waits for Duo, or goes on with the
 * password alone where `DUO_FAIL_OPEN` is `true`.
 */
export const duoStep = async (
  env: Env,
  request: Request,
  user: Pick<User, "id" | "email" | "name" | "twoFactorEnabled">,
  carry: DuoCarry,
  options: DuoOptions = {}
): Promise<DuoStep> => {
  const duo = duoClient(env, options);
  const health = await duo.healthCheck();

  if (health.ok) {
    return {
      kind: "prompt",
      response: await startDuoChallenge(duo, {
        secret: env.SESSION_SECRET,
        username: user.email,
        displayName: user.name,
        carry,
        cookie: challengeCookie(request),
      }),
    };
  }

  let instead: string | null = null;

  if (user.twoFactorEnabled) {
    instead = "authenticator-app";
  } else if (duoFailsOpen(env)) {
    instead = "password-alone";
  }

  console.warn(
    JSON.stringify({
      event: "duo.unavailable",
      reason: health.reason,
      instead,
    })
  );

  return instead ? { kind: "without-duo" } : { kind: "unavailable" };
};

/** `GET /auth/duo?state=…&duo_code=…`: Duo's answer becomes the session, or the sign-in page says why not. */
export const finishDuoSignIn = async (
  request: Request,
  env: Env,
  db: Database,
  options: DuoOptions = {}
): Promise<Response> => {
  if (!duoEnabled(env)) {
    return redirect("/login");
  }

  const outcome = await finishDuoChallenge(duoClient(env, options), {
    secret: env.SESSION_SECRET,
    request,
    cookie: challengeCookie(request),
  });

  const back = () =>
    redirect(`/login?${new URLSearchParams({ error: "duo" })}`, [
      outcome.clearCookie,
    ]);

  if (!outcome.ok) {
    console.warn(
      JSON.stringify({
        event: "duo.failed",
        reason: outcome.reason,
        code: outcome.error?.code,
      })
    );

    return back();
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, outcome.carry.userId),
  });

  if (!user?.active || user.email !== outcome.result.username) {
    return back();
  }

  // RFC 8176: the password, then what Duo reports (`mfa` with the factor); a policy that let the person through
  // without a prompt reports nothing, and the session says so.
  const amr = [...new Set(["pwd", ...outcome.result.amr])];
  const cookie = await startSession(request, env, user.id, amr);

  // Signing in again for an application (`prompt=login`): the session this browser had ends now the new one stands.
  if (outcome.carry.replaces) {
    await db.delete(sessions).where(eq(sessions.id, outcome.carry.replaces));
  }

  return redirect(outcome.carry.next, [cookie, outcome.clearCookie]);
};
