// Duo as the second factor of the password sign-in (`app/lib/duo.server.ts`, `passwordSignIn` in
// `app/lib/sign-in.server.ts`), against Duo in memory (`fakeDuo`): the right password goes to Duo's prompt with the
// challenge sealed in a cookie, Duo's answer at `/auth/duo` becomes a Better Auth session that says how (`amr`), and
// every answer that does not check out goes back to the sign-in page. While Duo is down the authenticator app stands
// in for it, or the password alone where `DUO_FAIL_OPEN` allows it; without Duo the sign-in is Better Auth's as it was.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { sessions } from "~/db/schema";
import type { User } from "~/db/schema";
import { authFor, getSessionIdentity } from "~/lib/auth.server";
import { finishDuoSignIn } from "~/lib/duo.server";
import { passwordSignIn, secondFactorSignIn } from "~/lib/sign-in.server";
import { issuerOf } from "~/lib/sso/provider.server";
import { setPersonActive } from "~/lib/users.server";

import { createWorker } from "../workers/worker";
import { cookiesOf, enrolAuthenticator } from "./authenticator";
import { fakeDuo } from "./fake-duo";
import {
  PASSWORD,
  adminMailbox,
  db,
  defined,
  mailbox,
  sessionCookieOf,
  sessionFor,
  withCookie,
} from "./fixtures";
import { stubEnv } from "./stub-env";

const issuer = issuerOf(env);
const DUO_CLIENT_ID = "DIWORKSPACE000000001";
const DUO_CLIENT_SECRET = "w".repeat(40);
const NEXT = "/mail?folder=inbox";
const CHALLENGE_COOKIE = "workspace_duo";

/** The value of the answer's `Set-Cookie` for `name`, or null when it sets none. */
const cookieValue = (res: Response, name: string): string | null => {
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`));

  return cookie?.split(";")[0]?.slice(name.length + 1) ?? null;
};

/** The whole `Set-Cookie` for `name`, attributes and all, or null. */
const setCookieFor = (res: Response, name: string): string | null =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? null;

/** Where a 302 sends the browser, or null for any other answer. */
const locationOf = (res: Response): string | null =>
  res.status === 302 ? res.headers.get("location") : null;

/** How the browser sending this `cookie` header signed in, or null when it is signed in as nobody. */
const amrOf = async (cookie: string | null) => {
  const identity = cookie
    ? await getSessionIdentity(withCookie(cookie), env, db)
    : null;

  return identity ? { user: identity.user.id, amr: identity.amr } : null;
};

/** Where an answer sends the browser, and the session it sets. */
const outcome = (res: Response) => ({
  location: locationOf(res),
  session: sessionCookieOf(res),
});

/** The sign-in page a refusal sends the browser back to, naming the error. */
const backWith = (error: string, next = NEXT) =>
  `/login?${new URLSearchParams({ next, error }).toString()}`;

/** The password form's post, as a browser sends it from `/login`, from one client of its own. */
const loginRequest = (ip: string, cookie?: string) => {
  const headers = new Headers({ "cf-connecting-ip": ip });

  if (cookie) {
    headers.set("cookie", cookie);
  }

  return new Request(`${issuer}/login`, { method: "POST", headers });
};

/** The workspace with Duo set up against a fake Duo of its own; `DUO_FAIL_OPEN` as given. */
const withDuo = async (ip: string, failOpen = false) => {
  const duo = await fakeDuo({
    clientId: DUO_CLIENT_ID,
    clientSecret: DUO_CLIENT_SECRET,
  });

  const duoEnv = stubEnv({
    ...env,
    DUO_CLIENT_ID,
    DUO_CLIENT_SECRET,
    DUO_API_HOST: duo.apiHost,
    DUO_FAIL_OPEN: failOpen ? "true" : "",
  });

  const signIn = (
    user: User,
    options: { password?: string; cookie?: string; reauth?: boolean } = {}
  ) =>
    passwordSignIn(
      loginRequest(ip, options.cookie),
      duoEnv,
      db,
      {
        email: user.email,
        password: options.password ?? PASSWORD,
        next: NEXT,
        reauth: options.reauth,
      },
      { fetch: duo.fetch }
    );

  /** Duo sends the browser back to `/auth/duo`, with the challenge cookie unless it is null. */
  const backFromDuo = (url: string, challenge: string | null) => {
    const headers = new Headers();

    if (challenge !== null) {
      headers.set("cookie", `${CHALLENGE_COOKIE}=${challenge}`);
    }

    return finishDuoSignIn(new Request(url, { headers }), duoEnv, db, {
      fetch: duo.fetch,
    });
  };

  /** The password, then Duo's prompt approved as `over` says: Duo's way back, and the challenge cookie. */
  const approved = async (
    user: User,
    over: Parameters<typeof duo.approve>[1] = {}
  ) => {
    const prompt = await signIn(user);
    const location = defined(locationOf(prompt), "Duo's prompt");
    const { callbackUrl } = await duo.approve(location, over);

    return {
      prompt,
      location,
      callbackUrl,
      challenge: cookieValue(prompt, CHALLENGE_COOKIE),
    };
  };

  return { duo, duoEnv, signIn, backFromDuo, approved };
};

describe("the password sign-in with Duo", () => {
  it("sends the right password to Duo's prompt, and Duo's approval becomes the session", async () => {
    const user = await mailbox("duo-on", "Duo On");
    const { duo, backFromDuo, approved } = await withDuo("198.51.100.1");
    const { prompt, location, callbackUrl, challenge } = await approved(user);
    const request = await duo.authorizeRequest(location);
    const done = await backFromDuo(callbackUrl, challenge);
    const session = sessionCookieOf(done);

    // The cookie is Better Auth's own: its session API reads it.
    const auth = await authFor(env);

    const found = await auth.api.getSession({
      headers: new Headers({ cookie: session ?? "" }),
    });

    expect({
      prompt: {
        to: location.startsWith(`https://${duo.apiHost}/oauth/v1/authorize?`),
        session: sessionCookieOf(prompt),
        challenge: setCookieFor(prompt, CHALLENGE_COOKIE)?.includes(
          "Path=/auth/duo;"
        ),
        health: duo.calls.health,
      },
      request: {
        duo_uname: request.duo_uname,
        display_username: request.display_username,
        redirect_uri: request.redirect_uri,
      },
      done: {
        location: locationOf(done),
        cleared: setCookieFor(done, CHALLENGE_COOKIE)?.includes("Max-Age=0"),
      },
      identity: await amrOf(session),
      found: found?.user.id,
    }).toStrictEqual({
      prompt: { to: true, session: null, challenge: true, health: 1 },
      request: {
        duo_uname: user.email,
        display_username: "Duo On",
        redirect_uri: `${issuer}/auth/duo`,
      },
      done: { location: NEXT, cleared: true },
      identity: { user: user.id, amr: ["pwd", "mfa", "otp"] },
      found: user.id,
    });
  });

  it("goes back to the sign-in page for an answer that does not check out", async () => {
    const user = await mailbox("duo-refused", "Duo Refused");
    const { backFromDuo, approved } = await withDuo("198.51.100.2");
    const first = await approved(user);

    const refusals = {
      otherState: outcome(
        await backFromDuo(
          first.callbackUrl.replace(/state=[^&]+/u, "state=x"),
          first.challenge
        )
      ),
      noCookie: outcome(await backFromDuo(first.callbackUrl, null)),
    };

    // The same answer with its cookie still signs in, once.
    const accepted = outcome(
      await backFromDuo(first.callbackUrl, first.challenge)
    );

    const replay = outcome(
      await backFromDuo(first.callbackUrl, first.challenge)
    );

    const denied = await approved(user, { result: "deny" });
    const someoneElse = await approved(user, { username: "mallory@evil.test" });

    const back = { location: "/login?error=duo", session: null };

    expect({
      refusals,
      accepted: accepted.location,
      replay,
      denied: outcome(await backFromDuo(denied.callbackUrl, denied.challenge)),
      someoneElse: outcome(
        await backFromDuo(someoneElse.callbackUrl, someoneElse.challenge)
      ),
    }).toStrictEqual({
      refusals: { otherState: back, noCookie: back },
      accepted: NEXT,
      replay: back,
      denied: back,
      someoneElse: back,
    });
  });

  it("refuses a person deactivated while Duo asked, and a wrong password never reaches Duo", async () => {
    const user = await mailbox("duo-deactivated", "Duo Deactivated");

    const { duo, signIn, backFromDuo, approved } =
      await withDuo("198.51.100.3");

    const wrong = await signIn(user, { password: "not the password" });
    const healthAfterWrong = duo.calls.health;
    const pending = await approved(user);

    await setPersonActive(db, await adminMailbox("duo-admin"), user.id, false);

    const gone = await backFromDuo(pending.callbackUrl, pending.challenge);

    expect({
      wrong: [locationOf(wrong), sessionCookieOf(wrong), healthAfterWrong],
      gone: [locationOf(gone), sessionCookieOf(gone)],
    }).toStrictEqual({
      wrong: [backWith("invalid"), null, 0],
      gone: ["/login?error=duo", null],
    });
  });

  it("refuses the sign-in while Duo is down, unless it may fail open", async () => {
    const user = await mailbox("duo-down", "Duo Down");
    const closed = await withDuo("198.51.100.4");
    closed.duo.down = true;
    const refused = await closed.signIn(user);
    const open = await withDuo("198.51.100.5", true);
    open.duo.down = true;
    const through = await open.signIn(user);

    expect({
      refused: [locationOf(refused), refused.headers.get("set-cookie")],
      through: [
        locationOf(through),
        await amrOf(sessionCookieOf(through)),
        open.duo.calls.token,
      ],
    }).toStrictEqual({
      refused: [backWith("duo-unavailable"), null],
      through: [NEXT, { user: user.id, amr: ["pwd"] }, 0],
    });
  });

  it("asks for the authenticator app instead while Duo is down, fail open or not", async () => {
    const user = await mailbox("duo-down-app", "Duo Down App");
    const app = await enrolAuthenticator(user);
    const closed = await withDuo("198.51.100.6");
    closed.duo.down = true;
    const step = await closed.signIn(user);
    const open = await withDuo("198.51.100.7", true);
    open.duo.down = true;
    const openStep = await open.signIn(user);

    // The code's page then makes the session, two factors without Duo.
    const done = await secondFactorSignIn(
      new Request(`${issuer}/two-factor`, {
        method: "POST",
        headers: { cookie: cookiesOf(step) },
      }),
      closed.duoEnv,
      { code: await app.code(), backup: false, trust: false, next: NEXT }
    );

    const twoFactor = `/two-factor?${new URLSearchParams({ next: NEXT }).toString()}`;

    expect({
      closed: [
        locationOf(step),
        // Better Auth's two-factor cookie, and no session yet.
        step.headers.getSetCookie().some((c) => c.includes("two_factor")),
        await amrOf(sessionCookieOf(step)),
      ],
      open: [locationOf(openStep), await amrOf(sessionCookieOf(openStep))],
      done: [locationOf(done), await amrOf(sessionCookieOf(done))],
    }).toStrictEqual({
      closed: [twoFactor, true, null],
      open: [twoFactor, null],
      done: [NEXT, { user: user.id, amr: ["pwd", "otp", "mfa"] }],
    });
  });

  it("replaces the browser's session on a fresh sign-in for an application", async () => {
    const user = await mailbox("duo-reauth", "Duo Reauth");
    const { duo, signIn, backFromDuo } = await withDuo("198.51.100.8");
    const before = await sessionFor(user);
    const old = defined(await getSessionIdentity(withCookie(before), env, db));
    const prompt = await signIn(user, { cookie: before, reauth: true });

    // The old session stands while Duo asks.
    const during = await db.query.sessions.findFirst({
      where: eq(sessions.id, old.sid),
    });

    const { callbackUrl } = await duo.approve(
      defined(locationOf(prompt), "Duo's prompt")
    );

    const done = await backFromDuo(
      callbackUrl,
      cookieValue(prompt, CHALLENGE_COOKIE)
    );

    const after = await db.query.sessions.findFirst({
      where: eq(sessions.id, old.sid),
    });

    expect({
      during: during?.id,
      after,
      identity: await amrOf(sessionCookieOf(done)),
    }).toStrictEqual({
      during: old.sid,
      after: undefined,
      identity: { user: user.id, amr: ["pwd", "mfa", "otp"] },
    });
  });

  it("replaces the browser's session on a fresh sign-in through the password alone too", async () => {
    const user = await mailbox("duo-reauth-open", "Duo Reauth Open");
    const open = await withDuo("198.51.100.9", true);
    open.duo.down = true;
    const before = await sessionFor(user);
    const old = defined(await getSessionIdentity(withCookie(before), env, db));
    const through = await open.signIn(user, { cookie: before, reauth: true });

    expect({
      old: await db.query.sessions.findFirst({
        where: eq(sessions.id, old.sid),
      }),
      identity: await amrOf(sessionCookieOf(through)),
    }).toStrictEqual({
      old: undefined,
      identity: { user: user.id, amr: ["pwd"] },
    });
  });
});

describe("Better Auth's own password endpoint with Duo", () => {
  it("is closed over HTTP while Duo is on, so nobody signs in past Duo", async () => {
    const user = await mailbox("duo-http", "Duo Http");
    const { duoEnv } = await withDuo("198.51.100.10");

    const post = (bindings: Env) =>
      createWorker(() => new Response("not Start", { status: 404 })).fetch(
        // SAFETY: Workers adds `cf` to the request it hands `fetch`; nothing in workers/ or app/ reads `request.cf`.
        new Request(`${issuer}/api/auth/sign-in/email`, {
          method: "POST",
          headers: {
            origin: new URL(issuer).origin,
            "content-type": "application/json",
            "cf-connecting-ip": "198.51.100.10",
          },
          body: JSON.stringify({ email: user.email, password: PASSWORD }),
        }) as Request<unknown, IncomingRequestCfProperties>,
        bindings
      );

    const closed = await post(duoEnv);
    // Without Duo the same post signs in, so the 404 is the closed path and not the request.
    const open = await post(env);

    expect({
      closed: [closed.status, sessionCookieOf(closed)],
      open: [open.status, sessionCookieOf(open) !== null],
    }).toStrictEqual({
      closed: [404, null],
      open: [200, true],
    });
  });
});

describe("the password sign-in without Duo", () => {
  it("is Better Auth's own sign-in, and the Duo callback has nothing to do", async () => {
    const user = await mailbox("duo-off", "Duo Off");

    const res = await passwordSignIn(loginRequest("198.51.100.20"), env, db, {
      email: user.email,
      password: PASSWORD,
      next: NEXT,
    });

    const offCallback = await finishDuoSignIn(
      new Request(`${issuer}/auth/duo?state=x&duo_code=y`),
      env,
      db
    );

    expect({
      location: locationOf(res),
      challenge: cookieValue(res, CHALLENGE_COOKIE),
      identity: await amrOf(sessionCookieOf(res)),
      callback: locationOf(offCallback),
    }).toStrictEqual({
      location: NEXT,
      challenge: null,
      identity: { user: user.id, amr: ["pwd"] },
      callback: "/login",
    });
  });

  it("asks a person with an authenticator app for the code, as it always did", async () => {
    const user = await mailbox("duo-off-app", "Duo Off App");
    await enrolAuthenticator(user);

    const res = await passwordSignIn(loginRequest("198.51.100.21"), env, db, {
      email: user.email,
      password: PASSWORD,
      next: NEXT,
    });

    expect({
      location: locationOf(res),
      identity: await amrOf(sessionCookieOf(res)),
    }).toStrictEqual({
      location: `/two-factor?${new URLSearchParams({ next: NEXT }).toString()}`,
      identity: null,
    });
  });
});
