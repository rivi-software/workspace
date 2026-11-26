// Settings → Account (`app/lib/account.server.ts`): what the tab loads of the person's security, and what its forms
// do, called as the route calls them.
import { isRedirect } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { passkeys, users } from "~/db/schema";
import {
  MAX_PASSKEYS,
  accountIntent,
  accountSettings,
} from "~/lib/account.server";
import { MAX_RECOVERY_ADDRESSES } from "~/lib/recovery.server";

import {
  db,
  defined,
  formOf,
  mailbox,
  recordingEmail,
  requestAs,
  sessionFor,
  userOf,
  withCookie,
} from "./fixtures";

const NEW_PASSWORD = "a long new password";

/** What a call throws, as thrown: a redirect is a Response, which `rejection` would wrap in an Error. */
const thrownBy = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (error) {
    return error;
  }

  return null;
};

/** The id of the person a browser sending this `cookie` header is signed in as, or null. */
const whoIs = async (cookie: string): Promise<string | null> => {
  const user = await userOf(cookie);

  return user?.id ?? null;
};

describe("Settings → Account", () => {
  it("loads the person's passkeys, sessions and recovery addresses, this browser's session marked", async () => {
    const user = await mailbox("account-load");
    const elsewhere = await sessionFor(user);
    const request = await requestAs(user);

    await db.insert(passkeys).values({
      id: "pk_account_load",
      userId: user.id,
      name: "Laptop",
      publicKey: "key",
      credentialID: "credential",
      counter: 0,
      deviceType: "multiDevice",
      backedUp: true,
      createdAt: new Date("2026-11-01T09:00:00Z"),
    });

    const loaded = await accountSettings(db, env, user, request);

    expect({
      ...loaded,
      sessions: loaded.sessions.length,
      current: loaded.sessions.filter((s) => s.current).length,
      elsewhere: await whoIs(elsewhere),
    }).toStrictEqual({
      twoFactorEnabled: false,
      passkeys: [
        {
          id: "pk_account_load",
          name: "Laptop",
          createdAt: "2026-11-01T09:00:00.000Z",
          backedUp: true,
        },
      ],
      maxPasskeys: MAX_PASSKEYS,
      // Both browsers, this one marked.
      sessions: 2,
      current: 1,
      recoveryAddresses: [],
      maxRecoveryAddresses: MAX_RECOVERY_ADDRESSES,
      mailDomain: env.MAIL_DOMAIN,
      elsewhere: user.id,
    });
  });

  it("saves the name, and answers a refusal as the form's error", async () => {
    const user = await mailbox("account-profile");
    const request = await requestAs(user);

    const saved = await accountIntent(
      db,
      env,
      user,
      formOf({ intent: "profile", name: "Renamed Person" }),
      request
    );

    const refused = await accountIntent(
      db,
      env,
      user,
      formOf({ intent: "profile", name: " " }),
      request
    );

    const row = await db.query.users.findFirst({
      where: eq(users.id, user.id),
    });

    expect({ saved, refused, name: row?.name }).toStrictEqual({
      saved: { message: "Saved." },
      refused: { error: "A name is needed." },
      name: "Renamed Person",
    });
  });

  it("changes the password with the current one and hands back this browser's new session, every other one ended", async () => {
    const user = await mailbox("account-password");
    const elsewhere = await sessionFor(user);
    const here = await sessionFor(user);

    const change = (current: string) =>
      accountIntent(
        db,
        env,
        user,
        formOf({
          intent: "password",
          current,
          password: NEW_PASSWORD,
          confirm: NEW_PASSWORD,
        }),
        withCookie(here)
      );

    const wrong = await change("not it");
    const changed = await change("password");
    const renewed = defined(defined(changed.cookie, "cookie").split(";")[0]);

    expect({
      wrong,
      message: changed.message,
      elsewhere: await whoIs(elsewhere),
      renewed: await whoIs(renewed),
    }).toStrictEqual({
      wrong: { error: "The current password is not right." },
      message:
        "Password changed. Every other browser and device is signed out.",
      elsewhere: null,
      renewed: user.id,
    });
  });

  it("adds a recovery address with the password, mails it again and removes it", async () => {
    const user = await mailbox("account-recovery");
    const request = await requestAs(user);
    const mail = recordingEmail();

    const act = (fields: Record<string, string>) =>
      accountIntent(db, mail.env, user, formOf(fields), request);

    const wrongPassword = await act({
      intent: "recovery-add",
      address: "account-recovery@gmail.com",
      current: "not it",
    });

    const added = await act({
      intent: "recovery-add",
      address: "account-recovery@gmail.com",
      current: "password",
    });

    const loaded = await accountSettings(db, env, user, request);
    const { id } = defined(loaded.recoveryAddresses[0]);
    const resent = await act({ intent: "recovery-resend", id });
    const removed = await act({ intent: "recovery-remove", id });
    const after = await accountSettings(db, env, user, request);

    expect({
      wrongPassword,
      added,
      listed: loaded.recoveryAddresses.map((r) => r.address),
      resent,
      mailed: mail.sent.length,
      removed,
      left: after.recoveryAddresses,
    }).toStrictEqual({
      wrongPassword: { error: "The current password is not right." },
      added: {
        message: "We sent a confirmation link to account-recovery@gmail.com.",
      },
      listed: ["account-recovery@gmail.com"],
      resent: { message: "Sent again to account-recovery@gmail.com." },
      mailed: 2,
      removed: { message: "Recovery address removed." },
      left: [],
    });
  });

  it("signs one other browser out, and answers nothing to an intent it does not know", async () => {
    const user = await mailbox("account-one-session");
    const elsewhere = await sessionFor(user);
    const here = await sessionFor(user);
    const request = withCookie(here);
    const loaded = await accountSettings(db, env, user, request);
    const other = defined(loaded.sessions.find((s) => !s.current));

    const ended = await accountIntent(
      db,
      env,
      user,
      formOf({ intent: "revoke-session", id: other.id }),
      request
    );

    const unknown = await accountIntent(
      db,
      env,
      user,
      formOf({ intent: "create" }),
      request
    );

    expect({
      ended,
      unknown,
      elsewhere: await whoIs(elsewhere),
      here: await whoIs(here),
    }).toStrictEqual({
      ended: { message: "Signed out there." },
      unknown: {},
      elsewhere: null,
      here: user.id,
    });
  });

  it("signs out everywhere, this browser too, and sends it to the sign-in page", async () => {
    const user = await mailbox("account-signout");
    const here = await sessionFor(user);
    const elsewhere = await sessionFor(user);

    const answer = await thrownBy(
      accountIntent(
        db,
        env,
        user,
        formOf({ intent: "signout-all" }),
        withCookie(here)
      )
    );

    expect({
      redirect: isRedirect(answer),
      href: isRedirect(answer) ? answer.options.href : null,
      here: await whoIs(here),
      elsewhere: await whoIs(elsewhere),
    }).toStrictEqual({
      redirect: true,
      href: "/login",
      here: null,
      elsewhere: null,
    });
  });
});
