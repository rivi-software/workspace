import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  drafts,
  driveNodes,
  messages,
  searchEntries,
  users,
} from "~/db/schema";
import { createEvent, listEvents } from "~/lib/calendar/calendar.server";
import {
  createFolder,
  finishUpload,
  setShare,
  startUpload,
} from "~/lib/drive/drive.server";
import { createGroup } from "~/lib/groups.server";
import { ingestInboundEmail, resolveMailbox } from "~/lib/mail/ingest.server";
import { REMOVAL_STEPS, continueRemoval } from "~/lib/removal.server";
import { createTask } from "~/lib/tasks/tasks.server";
import {
  PeopleError,
  addAlias,
  changeAddress,
  createPerson,
  removePerson,
  setPersonActive,
} from "~/lib/users.server";

import { adminMailbox, db, defined, mail, mailbox } from "./fixtures";
import { fakeSearchIndex } from "./search-index";

const domain = env.MAIL_DOMAIN;

/** A small file, sent whole, as the upload route does it. */
const putFile = async (
  userId: string,
  parentId: string | null,
  name: string
) => {
  const bytes = new TextEncoder().encode(`the text of ${name}`);

  const { node } = await startUpload(db, env, userId, {
    parentId,
    name,
    size: bytes.byteLength,
    multipart: false,
  });

  await env.DRIVE.put(defined(node.r2Key), bytes);

  return finishUpload(env, db, userId, node.id);
};

const objectsUnder = async (bucket: R2Bucket, prefix: string) => {
  const listed = await bucket.list({ prefix });

  return listed.objects.length;
};

const personRow = (id: string) =>
  db.query.users.findFirst({ where: eq(users.id, id) });

/** A person's primary address as stored, or null once they are gone. */
const addressOf = async (id: string) => {
  const row = await personRow(id);

  return row?.email ?? null;
};

/** Whose mailbox an address reaches, or null when it bounces. */
const reaches = async (address: string) => {
  const owner = await resolveMailbox(db, address);

  return owner?.id ?? null;
};

/** What the database does itself when the `users` row goes: deletes the row with it, or forgets the person. */
const LET_GO = new Set(["CASCADE", "SET NULL"]);

/** A group's own `groups` row names its `users` row, never a person's; `removePerson` refuses a group. */
const NEVER_A_PERSON = new Set(["groups.id"]);

describe("removing a person", () => {
  it("covers every column that names a person, or the database lets the row go without it", async () => {
    const tables = await env.DB.prepare(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%' and name != 'd1_migrations'"
    ).all<{ name: string }>();

    const covered = new Set(REMOVAL_STEPS.flatMap((s) => s.covers));
    const missing: string[] = [];

    for (const { name } of tables.results) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one table at a time, a handful in all
      const keys = await env.DB.prepare(
        `select "from", "table", on_delete from pragma_foreign_key_list('${name}')`
      ).all<{ from: string; table: string; on_delete: string }>();

      for (const k of keys.results) {
        const column = `${name}.${k.from}`;

        if (
          k.table === "users" &&
          !LET_GO.has(k.on_delete) &&
          !NEVER_A_PERSON.has(column) &&
          !covered.has(column)
        ) {
          missing.push(column);
        }
      }
    }

    expect(missing).toStrictEqual([]);
  });

  it("asks for a deactivated person and their address, never the admin's own account", async () => {
    const admin = await mailbox("rm-admin", "Admin");
    const kim = await mailbox("rm-kim", "Kim");

    await expect(
      removePerson(db, env, admin, admin.id, admin.email)
    ).rejects.toThrow("your own account");
    await expect(
      removePerson(db, env, admin, kim.id, kim.email)
    ).rejects.toThrow("Deactivate them first");

    await setPersonActive(db, admin, kim.id, false);

    await expect(
      removePerson(db, env, admin, kim.id, "someone@else")
    ).rejects.toThrow(PeopleError);
    const kept = await personRow(kim.id);

    expect(kept?.removingSince).toBeNull();
  });

  it("deletes their mail, Drive, calendar and tasks, keeps what colleagues own, and frees the address", async () => {
    const admin = await mailbox("rm-boss", "Boss");
    const colleague = await mailbox("rm-colleague", "Colleague");
    const leaver = await mailbox("rm-leaver", "Leaver");
    await addAlias(db, env, leaver.id, "rm-sales");

    // Mail, with an attachment and the raw message.
    const parsed = mail({ to: [{ email: leaver.email, name: null }] });
    parsed.attachments.push({
      filename: "report.pdf",
      mimeType: "application/pdf",
      content: new TextEncoder().encode("%PDF-1.4"),
      contentId: null,
      inline: false,
    });

    const filed = await ingestInboundEmail(
      env,
      new TextEncoder().encode("raw").buffer,
      parsed,
      leaver.email
    );

    expect(filed.status).toBe("stored");

    // Their Drive, a folder of it shared with the colleague; and a file they made in the colleague's folder.
    const folder = await createFolder(db, leaver.id, null, "Projects");
    await putFile(leaver.id, folder.id, "plan.txt");
    await setShare(db, leaver.id, folder.id, colleague.id, "editor");
    const theirs = await createFolder(db, colleague.id, null, "Shared work");
    await setShare(db, colleague.id, theirs.id, leaver.id, "editor");
    const made = await putFile(leaver.id, theirs.id, "notes.txt");

    // A colleague's meeting they were invited to, their own event and a task.
    const meeting = await createEvent(db, colleague.id, {
      title: "Planning",
      description: "",
      location: "",
      startsAt: "2026-11-03T09:00:00.000Z",
      endsAt: "2026-11-03T10:00:00.000Z",
      allDay: false,
      timeZone: "UTC",
      attendees: [leaver.id],
    });

    await createEvent(db, leaver.id, {
      title: "Dentist",
      description: "",
      location: "",
      startsAt: "2026-11-04T09:00:00.000Z",
      endsAt: "2026-11-04T10:00:00.000Z",
      allDay: false,
      timeZone: "UTC",
      attendees: [],
    });

    await createTask(db, leaver.id, { title: "Hand over" });

    await expect(objectsUnder(env.MAIL, `raw/${leaver.id}/`)).resolves.toBe(1);
    await expect(objectsUnder(env.MAIL, `att/${leaver.id}/`)).resolves.toBe(1);

    await setPersonActive(db, admin, leaver.id, false);

    const removed = await removePerson(
      db,
      env,
      admin,
      leaver.id,
      ` ${leaver.email.toUpperCase()} `
    );

    const kept = defined(
      await db.query.driveNodes.findFirst({
        where: eq(driveNodes.id, made.id),
      })
    );

    const events = await listEvents(
      db,
      colleague.id,
      "2026-11-01T00:00:00.000Z",
      "2026-11-30T00:00:00.000Z"
    );

    expect({
      removed,
      row: await personRow(leaver.id),
      raw: await objectsUnder(env.MAIL, `raw/${leaver.id}/`),
      att: await objectsUnder(env.MAIL, `att/${leaver.id}/`),
      drive: await objectsUnder(env.DRIVE, `drive/${leaver.id}/`),
      theirNodes: await db.query.driveNodes.findMany({
        where: eq(driveNodes.userId, leaver.id),
      }),
      kept: { userId: kept.userId, createdBy: kept.createdBy },
      keptObject: await env.DRIVE.head(defined(kept.r2Key)),
      meeting: events.find((e) => e.id === meeting.id)?.title,
      alias: await reaches(`rm-sales@${domain}`),
    }).toMatchObject({
      removed: { email: leaver.email, gone: true },
      row: undefined,
      raw: 0,
      att: 0,
      drive: 0,
      theirNodes: [],
      kept: { userId: colleague.id, createdBy: null },
      // SAFETY: `expect.anything()` is an asymmetric matcher typed `any`; it only stands in for the object here.
      keptObject: expect.anything() as unknown,
      meeting: "Planning",
      alias: null,
    });

    // The address and the alias can be given out again.
    const again = await createPerson(db, env, {
      email: "rm-leaver",
      name: "Someone new",
      role: "member",
    });

    await expect(reaches(leaver.email)).resolves.toBe(again.id);
  });

  it("bounces mail and stays deactivated while the cron is still deleting", async () => {
    const admin = await mailbox("rm-boss2", "Boss");
    const leaver = await mailbox("rm-slow", "Slow");

    await ingestInboundEmail(
      env,
      null,
      mail({ to: [{ email: leaver.email, name: null }] }),
      leaver.email
    );

    await setPersonActive(db, admin, leaver.id, false);

    await db
      .update(users)
      .set({ removingSince: new Date().toISOString() })
      .where(eq(users.id, leaver.id));

    // One round is not enough: the person is still there, half deleted.
    await expect(continueRemoval(env, db, leaver.id, 1)).resolves.toBeFalsy();

    const bounced = await ingestInboundEmail(
      env,
      null,
      mail({ to: [{ email: leaver.email, name: null }] }),
      leaver.email
    );

    expect({
      bounced: bounced.status,
      row: (await personRow(leaver.id)) ? "kept" : "gone",
    }).toStrictEqual({ bounced: "no-mailbox", row: "kept" });

    await expect(setPersonActive(db, admin, leaver.id, true)).rejects.toThrow(
      "being removed"
    );

    // The admin's request again, or the cron: either finishes it.
    await expect(continueRemoval(env, db, leaver.id)).resolves.toBeTruthy();
    await expect(personRow(leaver.id)).resolves.toBeUndefined();
  });
});

describe("changing a person's address", () => {
  it("keeps the old address as an alias, so mail to it still arrives", async () => {
    const ann = await mailbox("ca-ann", "Ann");

    const changed = await changeAddress(db, env, ann.id, "ca-anna", true);

    expect({
      changed,
      email: await addressOf(ann.id),
      newAddress: await reaches(`ca-anna@${domain}`),
      oldAddress: await reaches(`ca-ann@${domain}`),
    }).toStrictEqual({
      changed: { address: `ca-anna@${domain}`, hasPgpKey: false },
      email: `ca-anna@${domain}`,
      newAddress: ann.id,
      oldAddress: ann.id,
    });

    // An alias of their own becomes the address, and the one it replaces an alias.
    await changeAddress(db, env, ann.id, "ca-ann", true);

    const aliases = await db.query.aliases.findMany({
      where: (a, { eq: is }) => is(a.userId, ann.id),
    });

    expect({
      email: await addressOf(ann.id),
      aliases: aliases.map((a) => a.address),
    }).toStrictEqual({
      email: `ca-ann@${domain}`,
      aliases: [`ca-anna@${domain}`],
    });
  });

  it("frees the old address when asked, and moves drafts from it to the new one", async () => {
    const bo = await mailbox("ca-bo", "Bo");

    await db.insert(drafts).values({
      id: "dr_ca_bo",
      userId: bo.id,
      fromEmail: bo.email,
    });

    await changeAddress(db, env, bo.id, "ca-bob", false);

    const draft = await db.query.drafts.findFirst({
      where: eq(drafts.id, "dr_ca_bo"),
    });

    expect({
      oldAddress: await reaches(`ca-bo@${domain}`),
      draftFrom: draft?.fromEmail,
    }).toStrictEqual({ oldAddress: null, draftFrom: `ca-bob@${domain}` });
  });

  it("refuses an address someone else has, the same address, and one off the domain", async () => {
    const cy = await mailbox("ca-cy", "Cy");
    const dee = await mailbox("ca-dee", "Dee");
    await addAlias(db, env, dee.id, "ca-help");

    await expect(changeAddress(db, env, cy.id, "ca-dee", true)).rejects.toThrow(
      "already in use"
    );
    await expect(
      changeAddress(db, env, cy.id, "ca-help", true)
    ).rejects.toThrow("already in use");
    await expect(changeAddress(db, env, cy.id, "ca-cy", true)).rejects.toThrow(
      "their address already"
    );
    await expect(
      changeAddress(db, env, cy.id, "cy@gmail.com", true)
    ).rejects.toThrow(PeopleError);
    await expect(addressOf(cy.id)).resolves.toBe(cy.email);
  });
});

describe("removing a person beside groups and the search by meaning", () => {
  it("never removes a group or changes its address through People", async () => {
    const admin = await adminMailbox("rg-admin");

    const group = await createGroup(db, env, admin, {
      email: "rg-sales",
      name: "Sales",
      mode: "shared",
    });

    await expect(
      removePerson(db, env, admin, group.id, group.email)
    ).rejects.toThrow("no such person");
    await expect(
      changeAddress(db, env, group.id, "rg-team", true)
    ).rejects.toThrow("no such person");
    await expect(addressOf(group.id)).resolves.toBe(group.email);
  });

  it("takes their vectors out of the index, and keeps a shared inbox's message without its writer", async () => {
    const admin = await adminMailbox("rs-admin");
    const colleague = await mailbox("rs-colleague", "Colleague");
    const leaver = await mailbox("rs-leaver", "Leaver");
    const search = fakeSearchIndex();

    // A message in a shared group inbox, written by the leaver.
    const group = await createGroup(db, env, admin, {
      email: "rs-support",
      name: "Support",
      mode: "shared",
    });

    const filed = await ingestInboundEmail(
      env,
      null,
      mail({ to: [{ email: group.email, name: null }] }),
      group.email
    );

    if (filed.status !== "stored") {
      throw new Error(`not stored: ${filed.status}`);
    }

    await db
      .update(messages)
      .set({ sentBy: leaver.id })
      .where(eq(messages.threadId, filed.threadId));

    // What the index holds of the leaver's and of the colleague's.
    await search.index.put([
      { id: "th_rs_leaver", kind: "mail", owner: leaver.id, text: "theirs" },
      {
        id: "th_rs_colleague",
        kind: "mail",
        owner: colleague.id,
        text: "kept",
      },
    ]);
    await db.insert(searchEntries).values([
      {
        id: "th_rs_leaver",
        kind: "mail",
        userId: leaver.id,
        sourceAt: "2026-11-01T00:00:00.000Z",
      },
      {
        id: "th_rs_colleague",
        kind: "mail",
        userId: colleague.id,
        sourceAt: "2026-11-01T00:00:00.000Z",
      },
    ]);

    await setPersonActive(db, admin, leaver.id, false);

    const removed = await removePerson(
      db,
      search.env,
      admin,
      leaver.id,
      leaver.email
    );

    const groupMessages = await db.query.messages.findMany({
      where: eq(messages.threadId, filed.threadId),
    });

    const entries = await db.query.searchEntries.findMany();

    expect({
      gone: removed.gone,
      indexed: search.ids(),
      entries: entries.map((e) => e.id).filter((id) => id.startsWith("th_rs_")),
      writers: groupMessages.map((m) => m.sentBy),
    }).toStrictEqual({
      gone: true,
      indexed: ["th_rs_colleague"],
      entries: ["th_rs_colleague"],
      writers: [null],
    });
  });
});
