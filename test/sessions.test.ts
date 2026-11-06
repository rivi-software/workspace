import { SELF } from "cloudflare:test";
// Who is signed in, on Better Auth (`app/lib/auth.server.ts`, `app/lib/sign-in.server.ts`): the password form, the
// session cookie it answers, what ends a session (a revocation, a new password, a deactivation, a sign-out, one browser
// signed out from Settings), and the session token as the API's bearer token.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { User } from "~/db/schema";
import {
  authFor,
  checkPassword,
  endSession,
  listSessions,
  revoke,
  setPassword,
} from "~/lib/auth.server";
import { isJsonObject, stringOrNull } from "~/lib/guards";
import { passwordSignIn, safeNext } from "~/lib/sign-in.server";
import {
  PeopleError,
  changeOwnPassword,
  resetPassword,
  setPersonActive,
} from "~/lib/users.server";

import {
  PASSWORD,
  SESSION_COOKIE,
  db,
  defined,
  mailbox,
  rejection,
  sessionCookieOf,
  sessionFor,
  tokenOf,
  userOf,
} from "./fixtures";
import type { Json } from "./fixtures";

const NEW_PASSWORD = "a long new password";
const { origin } = new URL(env.APP_URL);

/** The password form's post, as a browser sends it from `/login`: no `sec-fetch-site` counts as this origin's. */
const signIn = (
  user: User,
  password: string,
  options: { next?: string; headers?: Record<string, string> } = {}
) =>
  passwordSignIn(
    new Request(`${env.APP_URL}/login`, {
      method: "POST",
      headers: options.headers,
    }),
    env,
    db,
    { email: user.email, password, next: options.next ?? "/mail" }
  );

/** What the form answered: where it sends the browser, and whether a session cookie goes with it. */
const outcome = (res: Response) => ({
  status: res.status,
  location: res.headers.get("location"),
  cookie: sessionCookieOf(res) !== null,
});

/** Where the form sends a browser back to, with the error it names. */
const backWith = (error: string) =>
  `/login?${new URLSearchParams({ next: "/mail", error })}`;

/** The `email` of the `user` in a JSON answer, or null. */
const emailIn = (body: Json): string | null =>
  isJsonObject(body) && isJsonObject(body.user)
    ? stringOrNull(body.user.email)
    : null;

/** The id of the person a browser sending this `cookie` header is signed in as, or null. */
const whoIs = async (cookie: string): Promise<string | null> => {
  const user = await userOf(cookie);

  return user?.id ?? null;
};

describe("the password form", () => {
  it("refuses a wrong password, and after ten failures the right one too for a while", async () => {
    const user = await mailbox("wrong-password", "Wrong Password");
    const wrong = await signIn(user, "not the password");

    for (let i = 0; i < 9; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the failures are counted in KV by a read and a write, so the ten must be recorded one after another
      await signIn(user, "not the password");
    }

    const throttled = await signIn(user, PASSWORD);

    expect({
      wrong: outcome(wrong),
      throttled: outcome(throttled),
    }).toStrictEqual({
      wrong: { status: 302, location: backWith("invalid"), cookie: false },
      throttled: {
        status: 302,
        location: backWith("throttled"),
        cookie: false,
      },
    });
  });

  it("signs the person in with the right password, to where they were going", async () => {
    const user = await mailbox("right-password", "Right Password");
    const res = await signIn(user, PASSWORD, { next: "/drive?view=starred" });
    const cookie = defined(sessionCookieOf(res));
    const signedIn = await userOf(cookie);

    const elsewhere = await signIn(user, PASSWORD, {
      next: "https://evil.test/mail",
    });

    expect({
      status: res.status,
      location: res.headers.get("location"),
      cookieName: cookie.split("=")[0],
      who: signedIn?.id,
      lastSignInAt: [
        user.lastSignInAt,
        /^\d{4}-\d{2}-\d{2}T/u.test(signedIn?.lastSignInAt ?? ""),
      ],
      elsewhere: outcome(elsewhere),
    }).toStrictEqual({
      status: 302,
      location: "/drive?view=starred",
      cookieName: SESSION_COOKIE,
      who: user.id,
      lastSignInAt: [null, true],
      elsewhere: { status: 302, location: "/mail", cookie: true },
    });
  });

  it("sends a sign-in on to a path on this host alone", () => {
    expect({
      path: safeNext("/drive?view=starred#top", origin),
      elsewhere: safeNext("https://evil.test/mail", origin),
      protocolRelative: safeNext("//evil.test/mail", origin),
      backslash: safeNext("/\\evil.test", origin),
      dotted: safeNext("/.//evil.test", origin),
      empty: safeNext("", origin),
    }).toStrictEqual({
      path: "/drive?view=starred#top",
      elsewhere: "/mail",
      protocolRelative: "/mail",
      backslash: "/mail",
      dotted: "/mail",
      empty: "/mail",
    });
  });

  it("refuses a post from another site before it checks anything", async () => {
    const user = await mailbox("cross-site", "Cross Site");

    const crossSite = await signIn(user, PASSWORD, {
      headers: { "sec-fetch-site": "cross-site" },
    });

    const sameSite = await signIn(user, PASSWORD, {
      headers: { "sec-fetch-site": "same-site" },
    });

    const elsewhere = await signIn(user, PASSWORD, {
      headers: { origin: "https://evil.test" },
    });

    const own = await signIn(user, PASSWORD, {
      headers: { "sec-fetch-site": "same-origin", origin },
    });

    expect({
      crossSite: crossSite.status,
      sameSite: sameSite.status,
      elsewhere: elsewhere.status,
      own: outcome(own),
    }).toStrictEqual({
      crossSite: 403,
      sameSite: 403,
      elsewhere: 403,
      own: { status: 302, location: "/mail", cookie: true },
    });
  });

  it("refuses a deactivated person, whatever they type, and ends the sessions they had", async () => {
    const admin = await mailbox("sessions-admin", "Sessions Admin");
    const user = await mailbox("deactivated", "Deactivated");
    const before = await sessionFor(user);
    await setPersonActive(db, admin, user.id, false);
    const form = await signIn(user, PASSWORD);

    // Better Auth's own sign-in (a passkey, the API's client) refuses too: the session's hook says so.
    const auth = await authFor(env);

    const direct = await auth.api.signInEmail({
      body: { email: user.email, password: PASSWORD },
      headers: new Headers({ origin }),
      asResponse: true,
    });

    await setPersonActive(db, admin, user.id, true);
    const again = await signIn(user, PASSWORD);

    expect({
      before: await userOf(before),
      form: outcome(form),
      direct: direct.status,
      again: outcome(again),
    }).toStrictEqual({
      before: null,
      form: { status: 302, location: backWith("inactive"), cookie: false },
      direct: 403,
      again: { status: 302, location: "/mail", cookie: true },
    });
  });
});

describe("a session", () => {
  it("ends at a revocation, with the person's other sessions and nobody else's", async () => {
    const user = await mailbox("revoked", "Revoked");
    const other = await mailbox("revoked-other", "Revoked Other");
    const one = await sessionFor(user);
    const two = await sessionFor(user);
    const theirs = await sessionFor(other);
    await revoke(db, user.id, "sign-out-everywhere");
    const after = await sessionFor(user);

    expect({
      one: await userOf(one),
      two: await userOf(two),
      theirs: await whoIs(theirs),
      after: await whoIs(after),
    }).toStrictEqual({
      one: null,
      two: null,
      theirs: other.id,
      after: user.id,
    });
  });

  it("ends alone when the person signs that browser out, and only a session of their own", async () => {
    const user = await mailbox("one-session", "One Session");
    const other = await mailbox("one-session-other", "One Session Other");
    const here = await sessionFor(user);
    const there = await sessionFor(user);
    const theirs = await sessionFor(other);
    const request = new Request(env.APP_URL, { headers: { cookie: here } });
    const listed = await listSessions(request, env, db, user.id);
    const hereId = defined(listed.find((s) => s.current)).id;
    const thereId = defined(listed.find((s) => !s.current)).id;

    // Another person posting this one's session id ends nothing.
    await endSession(db, other.id, hereId);
    await endSession(db, user.id, thereId);
    const left = await listSessions(request, env, db, user.id);

    expect({
      listed: listed.length,
      here: await whoIs(here),
      there: await userOf(there),
      theirs: await whoIs(theirs),
      left: left.map((s) => [s.id, s.current]),
    }).toStrictEqual({
      listed: 2,
      here: user.id,
      there: null,
      theirs: other.id,
      left: [[hereId, true]],
    });
  });

  it("ends with every session when the password is set anew, which signs in from then on", async () => {
    const user = await mailbox("new-password", "New Password");
    const elsewhere = await sessionFor(user);
    await setPassword(db, user.id, NEW_PASSWORD);
    const old = await signIn(user, PASSWORD);
    const fresh = await signIn(user, NEW_PASSWORD);

    // Settings → People: an admin's one-time password ends them the same way.
    const oneTime = await resetPassword(db, user.id);
    const handed = await signIn(user, oneTime);

    expect({
      elsewhere: await userOf(elsewhere),
      old: outcome(old),
      fresh: outcome(fresh),
      freshStill: await userOf(defined(sessionCookieOf(fresh))),
      handed: outcome(handed),
      checks: [
        await checkPassword(db, user.id, PASSWORD),
        await checkPassword(db, user.id, NEW_PASSWORD),
        await checkPassword(db, user.id, oneTime),
      ],
    }).toStrictEqual({
      elsewhere: null,
      old: { status: 302, location: backWith("invalid"), cookie: false },
      fresh: { status: 302, location: "/mail", cookie: true },
      freshStill: null,
      handed: { status: 302, location: "/mail", cookie: true },
      checks: [false, false, true],
    });
  });

  it("goes on in this browser alone when the person changes their own password", async () => {
    const user = await mailbox("own-password", "Own Password");
    const elsewhere = await sessionFor(user);
    const here = await sessionFor(user);
    const request = new Request(env.APP_URL, { headers: { cookie: here } });

    const change = (current: string, confirm = NEW_PASSWORD) =>
      changeOwnPassword(request, env, {
        current,
        password: NEW_PASSWORD,
        confirm,
      });

    const wrong = await rejection(change("wrong"));
    const mismatch = await rejection(change(PASSWORD, "something else"));
    const setCookie = defined(await change(PASSWORD));
    const renewed = defined(setCookie.split(";")[0]);

    expect({
      wrong: [wrong instanceof PeopleError, wrong?.message],
      mismatch: [mismatch instanceof PeopleError, mismatch?.message],
      elsewhere: await userOf(elsewhere),
      here: await userOf(here),
      renewed: await whoIs(renewed),
      checks: [
        await checkPassword(db, user.id, PASSWORD),
        await checkPassword(db, user.id, NEW_PASSWORD),
      ],
    }).toStrictEqual({
      wrong: [true, "The current password is not right."],
      mismatch: [true, "The new passwords do not match."],
      elsewhere: null,
      here: null,
      renewed: user.id,
      checks: [false, true],
    });
  });

  it("is read by the Worker's own endpoint, and ends at a sign-out", async () => {
    const user = await mailbox("worker-session", "Worker Session");
    const cookie = await sessionFor(user);

    const session = await SELF.fetch(`${env.APP_URL}/api/auth/get-session`, {
      headers: { cookie },
    });

    const body: Json = await session.json();

    const signedOut = await SELF.fetch(`${env.APP_URL}/api/auth/sign-out`, {
      method: "POST",
      headers: { cookie, origin },
    });

    const signedOutBody: Json = await signedOut.json();

    const cleared = signedOut.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`));

    const none = await SELF.fetch(`${env.APP_URL}/api/auth/get-session`, {
      headers: { cookie },
    });

    const noneBody: Json = await none.json();

    expect({
      session: [session.status, emailIn(body)],
      signedOut: [signedOut.status, signedOutBody],
      cleared: cleared?.includes("Max-Age=0"),
      after: await userOf(cookie),
      none: [none.status, noneBody],
    }).toStrictEqual({
      session: [200, user.email],
      signedOut: [200, { success: true }],
      cleared: true,
      after: null,
      none: [200, null],
    });
  });

  it("is the API's bearer token", async () => {
    const user = await mailbox("bearer", "Bearer");
    const cookie = await sessionFor(user);

    const me = await SELF.fetch(`${env.APP_URL}/api/v1/me`, {
      headers: { authorization: `Bearer ${tokenOf(cookie)}` },
    });

    const body: Json = await me.json();

    expect({ status: me.status, email: emailIn(body) }).toStrictEqual({
      status: 200,
      email: user.email,
    });
  });
});
