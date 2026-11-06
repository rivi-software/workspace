import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { checkPassword } from "~/lib/auth.server";
import { resolveMailbox } from "~/lib/mail/ingest.server";
import {
  PeopleError,
  addAlias,
  createPerson,
  listPeople,
  mailboxAddress,
  setPersonActive,
} from "~/lib/users.server";

import { db, mailbox } from "./fixtures";

describe("people", () => {
  it("makes addresses on the mail domain only", () => {
    expect(mailboxAddress(env, "Anna")).toBe(`anna@${env.MAIL_DOMAIN}`);
    expect(mailboxAddress(env, `anna@${env.MAIL_DOMAIN}`)).toBe(
      `anna@${env.MAIL_DOMAIN}`
    );
    expect(() => mailboxAddress(env, "anna@gmail.com")).toThrow(PeopleError);
    expect(() => mailboxAddress(env, "anna+x")).toThrow(PeopleError);
    expect(() => mailboxAddress(env, "a b")).toThrow(PeopleError);
  });

  it("creates a mailbox with a one-time password, refuses a taken address, and routes an alias", async () => {
    const created = await createPerson(db, env, {
      email: "anna",
      name: "Anna",
      role: "member",
    });

    const people = await listPeople(db);
    const person = people.find((p) => p.id === created.id);

    expect({
      email: created.email,
      person,
    }).toMatchObject({
      email: `anna@${env.MAIL_DOMAIN}`,
      person: {
        name: "Anna",
        role: "member",
        active: true,
        aliases: [],
      },
    });

    await expect(
      createPerson(db, env, { email: "anna", name: "Other", role: "member" })
    ).rejects.toThrow("already in use");

    await addAlias(db, env, created.id, "press");

    const resolveMailboxResult = await resolveMailbox(
      db,
      `press@${env.MAIL_DOMAIN}`
    );

    await expect(
      createPerson(db, env, { email: "press", name: "Press", role: "member" })
    ).rejects.toThrow("already in use");

    const admin = await mailbox("boss", "Boss");

    await expect(setPersonActive(db, admin, admin.id, false)).rejects.toThrow(
      PeopleError
    );

    await setPersonActive(db, admin, created.id, false);
    const people2 = await listPeople(db);

    expect({
      verified: await checkPassword(db, created.id, created.password),
      resolvedId: resolveMailboxResult?.id,
      updatedPerson: people2.find((p) => p.id === created.id),
    }).toMatchObject({
      verified: true,
      resolvedId: created.id,
      updatedPerson: {
        active: false,
      },
    });
  });
});
