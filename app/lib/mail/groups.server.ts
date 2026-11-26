/**
 * Group inboxes as Mail sees them: where mail to an address goes (a person, a shared group's own mailbox, or each
 * member of a distribution group), the group addresses a person sends from, and the gate to a shared mailbox. It
 * reads the schema alone, so `threads.server.ts` and `ingest.server.ts` import it without a cycle; making and
 * changing groups is `app/lib/groups.server.ts`'s.
 */
import { and, asc, eq } from "drizzle-orm";

import type { Database } from "~/db";
import { aliases, groupMembers, groups, users } from "~/db/schema";
import type { Group, User } from "~/db/schema";

import { canonicalAddress } from "./addresses";

/** Where mail to one address is filed: each mailbox once, and the group it reached them through, if any. */
export interface Delivery {
  mailboxes: User[];
  /** The distribution group that fanned it out; null for a person, an alias or a shared group. */
  distributedBy: (Group & { email: string }) | null;
}

/**
 * The mailboxes an address is delivered to, `+tags` ignored: a person's own address or alias, a shared group's
 * mailbox, or every active member of a distribution group. Null when it is none of these, a group that is off or a
 * distribution group with nobody active in it, so Email Routing refuses it and the sender gets a bounce. A deactivated person keeps receiving their own mail,
 * but a distribution group skips them: they cannot read it. A person an admin removed (`removing_since`) is nobody's
 * mailbox, so the sender gets a bounce rather than mail filed into what is being deleted.
 */
export const resolveDelivery = async (
  db: Database,
  address: string
): Promise<Delivery | null> => {
  const canonical = canonicalAddress(address);

  const direct =
    (await db.query.users.findFirst({ where: eq(users.email, canonical) })) ??
    (await aliasOwner(db, canonical));

  if (!direct) {
    return null;
  }

  if (direct.kind === "person") {
    return direct.removingSince
      ? null
      : { mailboxes: [direct], distributedBy: null };
  }

  const group = direct.active
    ? await db.query.groups.findFirst({ where: eq(groups.id, direct.id) })
    : null;

  if (!group) {
    return null;
  }

  if (group.mode === "shared") {
    return { mailboxes: [direct], distributedBy: null };
  }

  const members = await db
    .select({ user: users })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(
      and(
        eq(groupMembers.groupId, group.id),
        eq(users.active, true),
        eq(users.kind, "person")
      )
    )
    .orderBy(asc(users.email));

  // Nobody to give it to: the sender learns, rather than the mail going nowhere.
  if (!members.length) {
    return null;
  }

  return {
    mailboxes: members.map((m) => m.user),
    distributedBy: { ...group, email: direct.email },
  };
};

const aliasOwner = async (
  db: Database,
  address: string
): Promise<User | null> => {
  const alias = await db.query.aliases.findFirst({
    where: eq(aliases.address, address),
  });

  return alias
    ? ((await db.query.users.findFirst({
        where: eq(users.id, alias.userId),
      })) ?? null)
    : null;
};

/** A group a person is in, with the group's mailbox row (its address and name) and their role in it. */
export interface Membership {
  group: User;
  mode: Group["mode"];
  role: "owner" | "member";
}

/** The active groups a person is in, by name; `mode` narrows them to one kind. */
export const membershipsOf = async (
  db: Database,
  userId: string,
  mode?: Group["mode"]
): Promise<Membership[]> => {
  const rows = await db
    .select({ group: users, mode: groups.mode, role: groupMembers.role })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(users, eq(users.id, groups.id))
    .where(
      and(
        eq(groupMembers.userId, userId),
        eq(users.active, true),
        mode ? eq(groups.mode, mode) : undefined
      )
    )
    .orderBy(asc(users.name));

  return rows;
};

/**
 * The distribution groups' addresses a person answers: mail to them lands in the person's own mailbox, so they
 * count as the person's own addresses (`ownAddresses`) and the person sends from them under the group's name.
 */
export const distributionAddresses = async (
  db: Database,
  userId: string
): Promise<{ email: string; name: string }[]> => {
  const groupsIn = await membershipsOf(db, userId, "distribute");

  return groupsIn.map((m) => ({ email: m.group.email, name: m.group.name }));
};

/** The shared mailboxes a person opens in Mail, by name. */
export const sharedMailboxes = async (
  db: Database,
  userId: string
): Promise<User[]> => {
  const groupsIn = await membershipsOf(db, userId, "shared");

  return groupsIn.map((m) => m.group);
};

export class MailboxError extends Error {
  override name = "MailboxError";
}

/**
 * The mailbox Mail acts in for a person: their own without `box`, else the shared group `box` names, when it is on
 * and they are in it. Every read and write of a shared mailbox comes through here; what it answers is then the
 * owner every Mail function already scopes by, so nothing below it knows a group from a person.
 */
export const mailboxFor = async (
  db: Database,
  user: User,
  box: string | null | undefined
): Promise<User> => {
  if (!box || box === user.id) {
    return user;
  }

  const [row] = await db
    .select({ group: users })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(users, eq(users.id, groups.id))
    .where(
      and(
        eq(groupMembers.groupId, box),
        eq(groupMembers.userId, user.id),
        eq(groups.mode, "shared"),
        eq(users.active, true)
      )
    )
    .limit(1);

  if (!row) {
    throw new MailboxError("You are not in that group inbox.");
  }

  return row.group;
};
