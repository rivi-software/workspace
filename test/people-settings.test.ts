// Settings → People (`app/lib/people.server.ts`): what the tab loads for an admin, and what its forms do, called as the
// route calls them.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { passkeys, twoFactors, users } from "~/db/schema";
import type { User } from "~/db/schema";
import { checkPassword } from "~/lib/auth.server";
import { peopleIntent, peopleSettings } from "~/lib/people.server";
import { listPeople } from "~/lib/users.server";

import {
  adminMailbox,
  db,
  defined,
  formOf,
  mailbox,
  sessionFor,
  userOf,
} from "./fixtures";

/** An admin's People form, as the page posts it. */
const act = (admin: User, fields: Record<string, string>) =>
  peopleIntent(db, env, admin, formOf(fields));

/** The person as People lists them, found by `match`. */
const personWhere = async (
  match: (p: { id: string; email: string }) => boolean
) => {
  const people = await listPeople(db);

  return people.find(match);
};

describe("Settings → People", () => {
  it("refuses every form to a member and changes nothing", async () => {
    const member = await mailbox("people-member");
    const colleague = await mailbox("people-colleague");

    const forms: Record<string, string>[] = [
      { intent: "create", email: "people-sneaked", name: "Sneaked" },
      { intent: "admin", id: member.id },
      { intent: "deactivate", id: colleague.id },
      { intent: "reset", id: colleague.id },
    ];

    const answers = await Promise.all(
      forms.map((fields) => act(member, fields))
    );

    const people = await listPeople(db);

    expect({
      answers,
      sneaked: people.some((p) => p.email.startsWith("people-sneaked@")),
      member: people.find((p) => p.id === member.id)?.role,
      colleague: people.find((p) => p.id === colleague.id)?.active,
      password: await checkPassword(db, colleague.id, "password"),
    }).toStrictEqual({
      answers: Array.from({ length: 4 }, () => ({
        error: "Only an admin can manage people.",
      })),
      sneaked: false,
      member: "member",
      colleague: true,
      password: true,
    });
  });

  it("makes a mailbox with a one-time password, changes its role and aliases, and refuses an admin's own deactivation", async () => {
    const admin = await adminMailbox("people-admin");

    const created = await act(admin, {
      intent: "create",
      email: "people-new",
      name: "New Person",
      role: "member",
    });

    const person = defined(
      await personWhere((p) => p.email.startsWith("people-new@")),
      "person"
    );

    const answers = {
      admin: await act(admin, { intent: "admin", id: person.id }),
      member: await act(admin, { intent: "member", id: person.id }),
      alias: await act(admin, {
        intent: "alias",
        id: person.id,
        alias: "people-press",
      }),
      deactivate: await act(admin, { intent: "deactivate", id: person.id }),
      selfDeactivate: await act(admin, { intent: "deactivate", id: admin.id }),
      taken: await act(admin, {
        intent: "create",
        email: "people-new",
        name: "Again",
      }),
    };

    const shown = await peopleSettings(db, env, admin);

    expect({
      created: {
        message: created.message,
        signsIn: await checkPassword(
          db,
          person.id,
          defined(created.password, "password")
        ),
      },
      answers,
      mailDomain: shown.mailDomain,
      person: shown.people.find((p) => p.id === person.id),
    }).toMatchObject({
      created: {
        message: `people-new@${env.MAIL_DOMAIN} is ready. Their one-time password:`,
        signsIn: true,
      },
      answers: {
        admin: { message: "Now an admin." },
        member: { message: "Now a member." },
        alias: {
          message: `people-press@${env.MAIL_DOMAIN} now reaches this mailbox.`,
        },
        deactivate: { message: "Deactivated." },
        selfDeactivate: { error: "You cannot deactivate your own account." },
        taken: { error: `people-new@${env.MAIL_DOMAIN} is already in use.` },
      },
      mailDomain: env.MAIL_DOMAIN,
      person: {
        role: "member",
        active: false,
        aliases: [`people-press@${env.MAIL_DOMAIN}`],
      },
    });
  });

  it("gives a new one-time password and signs a person out everywhere", async () => {
    const admin = await adminMailbox("people-resetter");
    const person = await mailbox("people-reset");
    const before = await sessionFor(person);

    const reset = await act(admin, { intent: "reset", id: person.id });
    const password = defined(reset.password, "password");
    const again = await sessionFor(person, { password });
    const signout = await act(admin, { intent: "signout", id: person.id });

    expect({
      reset: reset.message,
      works: await checkPassword(db, person.id, password),
      before: await userOf(before),
      signout,
      after: await userOf(again),
    }).toStrictEqual({
      reset: "Signed out everywhere. Their new one-time password:",
      works: true,
      before: null,
      signout: {
        message:
          "Signed out everywhere: their next request asks them to sign in.",
      },
      after: null,
    });
  });

  it("removes a person's passkeys and resets their authenticator app", async () => {
    const admin = await adminMailbox("people-keys");
    const person = await mailbox("people-lost-device");

    await db.insert(passkeys).values(
      ["one", "two"].map((n) => ({
        id: `pk_people_${n}`,
        userId: person.id,
        publicKey: "key",
        credentialID: `credential-${n}`,
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      }))
    );

    await db.insert(twoFactors).values({
      id: "tfa_people_lost",
      userId: person.id,
      secret: "secret",
      backupCodes: "codes",
    });

    await db
      .update(users)
      .set({ twoFactorEnabled: true })
      .where(eq(users.id, person.id));

    const removed = await act(admin, {
      intent: "passkeys-remove",
      id: person.id,
    });

    const reset = await act(admin, {
      intent: "two-factor-reset",
      id: person.id,
    });

    const shown = await peopleSettings(db, env, admin);

    expect({
      removed,
      reset,
      person: shown.people.find((p) => p.id === person.id),
    }).toMatchObject({
      removed: { message: "2 passkeys removed." },
      reset: {
        message:
          "Two-factor authentication reset: their next password sign-in needs no code until they set up an authenticator app again.",
      },
      person: { passkeys: 0, twoFactorEnabled: false },
    });
  });

  it("answers nothing to an intent it does not know", async () => {
    const admin = await adminMailbox("people-unknown");

    await expect(act(admin, { intent: "profile" })).resolves.toStrictEqual({});
  });
});
