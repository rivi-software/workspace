// Group inboxes, the distribution kind: Settings → Groups (`app/lib/groups.server.ts`) as its forms call it, the
// delivery to every member (`resolveDelivery`), sending as the group, and a group never counting as a person.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { User } from "~/db/schema";
import { colleagues } from "~/lib/drive/drive.server";
import { groupsIntent, groupsSettings } from "~/lib/groups.server";
import {
  MailboxError,
  mailboxFor,
  resolveDelivery,
} from "~/lib/mail/groups.server";
import {
  handleInboundEmail,
  ingestInboundEmail,
} from "~/lib/mail/ingest.server";
import { listThreads, loadThread } from "~/lib/mail/mailbox.server";
import { sendableAddresses, sendMail } from "~/lib/mail/send.server";
import { listPeople, setPersonActive } from "~/lib/users.server";

import {
  adminMailbox,
  db,
  defined,
  formOf,
  forwardable,
  mail,
  mailbox,
  rawMail,
  recordingEmail,
  rejection,
} from "./fixtures";

const domain = env.MAIL_DOMAIN;

/** A Groups form, as the page posts it. */
const act = (user: User, fields: Record<string, string>) =>
  groupsIntent(db, env, user, formOf(fields));

/** A new group an admin made, found by its address. */
const makeGroup = async (
  admin: User,
  local: string,
  mode: "distribute" | "shared" = "distribute"
) => {
  const made = await act(admin, {
    intent: "create",
    email: local,
    name: `Team ${local}`,
    mode,
  });

  expect(made.error).toBeUndefined();

  const { groups } = await groupsSettings(db, env, admin);

  return defined(groups.find((g) => g.email === `${local}@${domain}`));
};

/** The subjects in a person's inbox. */
const inboxOf = async (user: User) => {
  const rows = await listThreads(db, user.id, { folder: "inbox" });

  return rows.map((t) => t.subject);
};

/** What the Groups tab shows a person, in short. */
const seen = async (user: User) => {
  const settings = await groupsSettings(db, env, user);

  return {
    groups: settings.groups.map((g) => ({
      email: g.email,
      name: g.name,
      myRole: g.myRole,
      canManage: g.canManage,
      members: g.members.map((m) => `${m.name}:${m.role}`),
    })),
    canAdd: settings.people.length > 0,
    canCreate: settings.canCreate,
  };
};

describe("Settings → Groups", () => {
  it("lets an admin alone make a group, on a free address of the mail domain", async () => {
    const admin = await adminMailbox("grp-admin");

    const member = await mailbox("grp-member", "Mo Member", [
      `grp-alias@${domain}`,
    ]);

    const refused = await act(member, {
      intent: "create",
      email: "sales",
      name: "Sales",
      mode: "distribute",
    });

    const taken = await Promise.all(
      [member.email, `grp-alias@${domain}`].map((email) =>
        act(admin, { intent: "create", email, name: "Taken", mode: "shared" })
      )
    );

    const sales = await makeGroup(admin, "sales");

    const again = await act(admin, {
      intent: "create",
      email: "sales",
      name: "Again",
      mode: "distribute",
    });

    expect({
      refused: refused.error,
      taken: taken.map((t) => t.error),
      sales: {
        name: sales.name,
        mode: sales.mode,
        active: sales.active,
        members: sales.members,
      },
      again: again.error,
    }).toStrictEqual({
      refused: "Only an admin can do that.",
      taken: [
        `${member.email} is already in use.`,
        `grp-alias@${domain} is already in use.`,
      ],
      sales: {
        name: "Team sales",
        mode: "distribute",
        active: true,
        members: [],
      },
      again: `sales@${domain} is already in use.`,
    });
  });

  it("lets an owner change the members and a member only look, and shows each person their own groups", async () => {
    const admin = await adminMailbox("grp-admin2");
    const owner = await mailbox("grp-owner", "Olga Owner");
    const plain = await mailbox("grp-plain", "Pat Plain");
    const outsider = await mailbox("grp-outsider", "Otto Outsider");
    const group = await makeGroup(admin, "support-team");
    await makeGroup(admin, "other-team");

    await act(admin, {
      intent: "add",
      id: group.id,
      email: owner.email,
      role: "owner",
    });

    const byOwner = await act(owner, {
      intent: "add",
      id: group.id,
      email: plain.email,
      role: "member",
    });

    const byMember = await act(plain, {
      intent: "add",
      id: group.id,
      email: outsider.email,
      role: "member",
    });

    const unknown = await act(owner, {
      intent: "add",
      id: group.id,
      email: `nobody@${domain}`,
      role: "member",
    });

    // An owner may rename it, never turn it off: that is an admin's.
    const renamed = await act(owner, {
      intent: "rename",
      id: group.id,
      name: "Support",
    });

    const offByOwner = await act(owner, { intent: "deactivate", id: group.id });

    const support = {
      email: `support-team@${domain}`,
      name: "Support",
      members: ["Olga Owner:owner", "Pat Plain:member"],
    };

    expect({
      byOwner: byOwner.message,
      byMember: byMember.error,
      unknown: unknown.error,
      renamed: renamed.message,
      offByOwner: offByOwner.error,
      owner: await seen(owner),
      plain: await seen(plain),
      outsider: await seen(outsider),
    }).toStrictEqual({
      byOwner: "Pat Plain is in the group.",
      byMember:
        "Only an admin or an owner of the group can change its members.",
      unknown: `Nobody active in the workspace has the address "nobody@${domain}".`,
      renamed: "Renamed.",
      offByOwner: "Only an admin can do that.",
      owner: {
        groups: [{ ...support, myRole: "owner", canManage: true }],
        canAdd: true,
        canCreate: false,
      },
      plain: {
        groups: [{ ...support, myRole: "member", canManage: false }],
        canAdd: false,
        canCreate: false,
      },
      outsider: { groups: [], canAdd: false, canCreate: false },
    });

    // The owner takes Pat out; Pat no longer sees the group.
    await act(owner, { intent: "remove", id: group.id, userId: plain.id });
    const after = await seen(plain);
    expect(after.groups).toStrictEqual([]);
  });

  it("deletes a distribution group and only turns a shared inbox off", async () => {
    const admin = await adminMailbox("grp-admin3");
    const list = await makeGroup(admin, "gone-list");
    const shared = await makeGroup(admin, "kept-shared", "shared");

    const deleted = await act(admin, { intent: "delete", id: list.id });
    const refused = await act(admin, { intent: "delete", id: shared.id });
    const off = await act(admin, { intent: "deactivate", id: shared.id });
    const { groups } = await groupsSettings(db, env, admin);

    expect({
      deleted: deleted.message,
      refused: refused.error,
      off: off.message,
      left: groups
        .filter(
          (g) => g.email.startsWith("gone-") || g.email.startsWith("kept-")
        )
        .map((g) => ({ email: g.email, active: g.active })),
      address: await resolveDelivery(db, `gone-list@${domain}`),
    }).toStrictEqual({
      deleted: "Group deleted.",
      refused: "A shared inbox keeps its mail: turn it off instead.",
      off: "Turned off: mail to it now bounces.",
      left: [{ email: `kept-shared@${domain}`, active: false }],
      address: null,
    });
  });
});

describe("a distribution group's mail", () => {
  it("files a copy in each active member's inbox, once for someone who also got it straight", async () => {
    const admin = await adminMailbox("dist-admin");
    const ann = await mailbox("dist-ann");
    const ben = await mailbox("dist-ben");
    const gone = await mailbox("dist-gone");
    const group = await makeGroup(admin, "dist-team");

    for (const person of [ann, ben, gone]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- members join in turn
      await act(admin, {
        intent: "add",
        id: group.id,
        email: person.email,
        role: "member",
      });
    }

    // A deactivated person keeps their mail but is never sent the group's.
    await setPersonActive(db, admin, gone.id, false);

    const m = mail({
      subject: "To the team",
      to: [{ email: group.email, name: null }],
    });

    const toGroup = await ingestInboundEmail(
      env,
      null,
      m,
      `dist-team+urgent@${domain}`
    );

    // Email Routing calls once per envelope recipient: Ann was on it by name too.
    const toAnn = await ingestInboundEmail(env, null, m, ann.email);

    expect({
      status: toGroup.status,
      filedFor:
        toGroup.status === "distributed"
          ? toGroup.deliveries.map((d) => [d.userId, d.result.status])
          : null,
      toAnn: toAnn.status,
      ann: await inboxOf(ann),
      ben: await inboxOf(ben),
      gone: await inboxOf(gone),
    }).toStrictEqual({
      status: "distributed",
      filedFor: [
        [ann.id, "stored"],
        [ben.id, "stored"],
      ],
      toAnn: "duplicate",
      ann: ["To the team"],
      ben: ["To the team"],
      gone: [],
    });
  });

  it("bounces mail to a group that is off or has nobody in it", async () => {
    const admin = await adminMailbox("bounce-admin");
    const person = await mailbox("bounce-person");
    const empty = await makeGroup(admin, "bounce-empty");
    const off = await makeGroup(admin, "bounce-off");
    await act(admin, {
      intent: "add",
      id: off.id,
      email: person.email,
      role: "member",
    });
    await act(admin, { intent: "deactivate", id: off.id });

    const bounced = await Promise.all(
      [empty.email, off.email].map(async (to) => {
        const { message, rejected } = forwardable(
          rawMail({ subject: "Anyone?", to }),
          "jane@acme.com",
          to
        );

        const result = await handleInboundEmail(message, env);

        return { status: result.status, rejected };
      })
    );

    expect(bounced).toStrictEqual([
      { status: "no-mailbox", rejected: ["No such mailbox"] },
      { status: "no-mailbox", rejected: ["No such mailbox"] },
    ]);
  });

  it("lets a member send as the group under its name, never signed with their own key, and nobody else", async () => {
    const admin = await adminMailbox("send-admin");
    const member = await mailbox("send-member", "Mia Member");
    const outsider = await mailbox("send-outsider");
    const group = await makeGroup(admin, "send-team");
    await act(admin, {
      intent: "add",
      id: group.id,
      email: member.email,
      role: "member",
    });

    const { sent, env: testEnv } = recordingEmail();

    const base = {
      from: group.email,
      to: [{ email: "jane@acme.com", name: "Jane" }],
      cc: [],
      bcc: [],
      subject: "From the team",
      text: "Hello from all of us.",
      files: [],
    };

    await sendMail(testEnv, db, member, base);

    const signed = await rejection(
      sendMail(testEnv, db, member, {
        ...base,
        pgp: { sign: true, encrypt: false },
      })
    );

    const outside = await rejection(sendMail(testEnv, db, outsider, base));

    expect({
      addresses: await sendableAddresses(db, member),
      from: sent.map((m) => m.from),
      signed: signed?.message,
      outside: outside?.message,
    }).toStrictEqual({
      addresses: [
        { email: member.email, name: "Mia Member" },
        { email: group.email, name: "Team send-team" },
      ],
      from: [{ email: group.email, name: "Team send-team" }],
      signed: `OpenPGP signs and encrypts only from your own addresses, not from the group address ${group.email}.`,
      outside: `You cannot send as ${group.email}.`,
    });
  });
});

describe("a group is no person", () => {
  it("is never listed among people or colleagues", async () => {
    const admin = await adminMailbox("kind-admin");
    const group = await makeGroup(admin, "kind-team");

    const [people, others] = await Promise.all([
      listPeople(db),
      colleagues(db, admin.id),
    ]);

    expect({
      people: people.some((p) => p.id === group.id),
      colleagues: others.some((p) => p.id === group.id),
    }).toStrictEqual({ people: false, colleagues: false });
  });
});

/** Which mailbox `box` opens for a person, or that it is refused. */
const opens = async (user: User, box: string | null) => {
  try {
    const opened = await mailboxFor(db, user, box);

    return opened.id;
  } catch (error) {
    return error instanceof MailboxError ? "refused" : "failed";
  }
};

describe("a shared group inbox", () => {
  it("files the mail once, in the group's own mailbox, never a member's", async () => {
    const admin = await adminMailbox("shared-admin");
    const sam = await mailbox("shared-sam");
    const group = await makeGroup(admin, "shared-help", "shared");
    await act(admin, {
      intent: "add",
      id: group.id,
      email: sam.email,
      role: "member",
    });

    const result = await ingestInboundEmail(
      env,
      null,
      mail({ subject: "Help please" }),
      `shared-help+web@${domain}`
    );

    const box = await mailboxFor(db, sam, group.id);

    expect({
      status: result.status,
      box: { id: box.id, kind: box.kind, email: box.email },
      group: await inboxOf(box),
      sam: await inboxOf(sam),
    }).toStrictEqual({
      status: "stored",
      box: { id: group.id, kind: "group", email: group.email },
      group: ["Help please"],
      sam: [],
    });
  });

  it("opens only for a member, only while it is on, and never for a distribution group", async () => {
    const admin = await adminMailbox("gate-admin");
    const member = await mailbox("gate-member");
    const outsider = await mailbox("gate-outsider");
    const shared = await makeGroup(admin, "gate-shared", "shared");
    const list = await makeGroup(admin, "gate-list");

    for (const id of [shared.id, list.id]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one group at a time
      await act(admin, {
        intent: "add",
        id,
        email: member.email,
        role: "member",
      });
    }

    const before = {
      own: await opens(member, null),
      shared: await opens(member, shared.id),
      outsider: await opens(outsider, shared.id),
      list: await opens(member, list.id),
      // Another person's mailbox is no group inbox, whoever asks.
      colleague: await opens(member, outsider.id),
    };

    await act(admin, { intent: "deactivate", id: shared.id });

    expect({ ...before, off: await opens(member, shared.id) }).toStrictEqual({
      own: member.id,
      shared: shared.id,
      outsider: "refused",
      list: "refused",
      colleague: "refused",
      off: "refused",
    });
  });

  it("sends as the group from its mailbox, files the copy in the group's Sent, and from no member's address", async () => {
    const admin = await adminMailbox("reply-admin");
    const rae = await mailbox("reply-rae");
    const group = await makeGroup(admin, "reply-desk", "shared");
    await act(admin, {
      intent: "add",
      id: group.id,
      email: rae.email,
      role: "member",
    });

    const box = await mailboxFor(db, rae, group.id);
    const { sent, env: testEnv } = recordingEmail();

    const base = {
      to: [{ email: "jane@acme.com", name: "Jane" }],
      cc: [],
      bcc: [],
      subject: "Your question",
      text: "Here is the answer.",
      files: [],
    };

    const reply = await sendMail(testEnv, db, box, {
      ...base,
      from: group.email,
      sentBy: rae.id,
    });

    const opened = defined(await loadThread(db, env, box.id, reply.threadId));

    const asMember = await rejection(
      sendMail(testEnv, db, box, { ...base, from: rae.email })
    );

    const sentRows = await listThreads(db, box.id, { folder: "sent" });
    const raeSent = await listThreads(db, rae.id, { folder: "sent" });
    const raeFroms = await sendableAddresses(db, rae);

    expect({
      from: sent.map((m) => m.from),
      groupSent: sentRows.map((t) => t.subject),
      // The others see which of them answered.
      sentBy: opened.messages.map((m) => m.sentBy),
      raeSent: raeSent.length,
      asMember: asMember?.message,
      // A shared inbox's address is the group's, never one its members send from their own mailbox.
      raeAddresses: raeFroms.map((a) => a.email),
    }).toStrictEqual({
      from: [{ email: group.email, name: "Team reply-desk" }],
      groupSent: ["Your question"],
      sentBy: ["reply-rae"],
      raeSent: 0,
      asMember: `You cannot send as ${rae.email}.`,
      raeAddresses: [rae.email],
    });
  });
});
