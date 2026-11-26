/**
 * Settings → Groups: group inboxes, made by an admin and kept by their owners. An admin makes a group (an address,
 * a name, and whether it distributes or is shared), renames it, turns it off and on, and deletes a distribution
 * group; an admin or one of the group's owners adds and removes its members and makes them owners. Everyone sees
 * the groups they are in. What the tab loads (`groupsSettings`) and what its forms do (`groupsIntent`), apart from
 * the route so the tests call both; how Mail delivers to a group and opens a shared one is `mail/groups.server.ts`.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database } from "~/db";
import { groupMembers, groups, users } from "~/db/schema";
import type { Group, User } from "~/db/schema";

import { field } from "./guards";
import { newId } from "./ids";
import type { SettingsResult } from "./settings";
import { addressTaken, mailboxAddress, PeopleError } from "./users.server";

export class GroupError extends Error {
  override name = "GroupError";
}

export type GroupMode = Group["mode"];

export type GroupRole = "owner" | "member";

export interface GroupView {
  id: string;
  email: string;
  name: string;
  mode: GroupMode;
  /** A group that is off refuses its mail and leaves Mail's send-as list and sidebar. */
  active: boolean;
  /** The person's own place in it; null for an admin who is not in it. */
  myRole: GroupRole | null;
  /** Whether the person adds and removes members: an admin, or an owner of the group. */
  canManage: boolean;
  members: {
    id: string;
    name: string;
    email: string;
    role: GroupRole;
    active: boolean;
  }[];
}

const isAdmin = (user: User) => user.role === "admin";

/** The group row and its mailbox, or a GroupError. */
const groupOf = async (
  db: Database,
  id: string
): Promise<{ group: Group; mailbox: User }> => {
  const [row] = await db
    .select({ group: groups, mailbox: users })
    .from(groups)
    .innerJoin(users, eq(users.id, groups.id))
    .where(eq(groups.id, id))
    .limit(1);

  if (!row) {
    throw new GroupError("That group no longer exists.");
  }

  return row;
};

/** An admin, or an owner of this group; anyone else is refused. */
const mustManage = async (db: Database, actor: User, groupId: string) => {
  if (isAdmin(actor)) {
    return;
  }

  const own = await db.query.groupMembers.findFirst({
    where: and(
      eq(groupMembers.groupId, groupId),
      eq(groupMembers.userId, actor.id),
      eq(groupMembers.role, "owner")
    ),
  });

  if (!own) {
    throw new GroupError(
      "Only an admin or an owner of the group can change its members."
    );
  }
};

const mustBeAdmin = (actor: User) => {
  if (!isAdmin(actor)) {
    throw new GroupError("Only an admin can do that.");
  }
};

/** The groups a person sees: every one for an admin, else the ones they are in; each with its members. */
export const listGroups = async (
  db: Database,
  user: User
): Promise<GroupView[]> => {
  const mine = await db
    .select({ groupId: groupMembers.groupId, role: groupMembers.role })
    .from(groupMembers)
    .where(eq(groupMembers.userId, user.id));

  const myRole = new Map(mine.map((m) => [m.groupId, m.role]));

  if (!isAdmin(user) && !mine.length) {
    return [];
  }

  const rows = await db
    .select({ group: groups, mailbox: users })
    .from(groups)
    .innerJoin(users, eq(users.id, groups.id))
    .where(
      isAdmin(user)
        ? undefined
        : inArray(groups.id, [...myRole.keys()].slice(0, 90))
    )
    .orderBy(asc(users.name));

  if (!rows.length) {
    return [];
  }

  const members = await db
    .select({
      groupId: groupMembers.groupId,
      role: groupMembers.role,
      id: users.id,
      name: users.name,
      email: users.email,
      active: users.active,
    })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(
      inArray(
        groupMembers.groupId,
        rows.slice(0, 90).map((r) => r.group.id)
      )
    )
    .orderBy(asc(users.name));

  return rows.map(({ group, mailbox }) => {
    const role = myRole.get(group.id) ?? null;

    return {
      id: group.id,
      email: mailbox.email,
      name: mailbox.name,
      mode: group.mode,
      active: mailbox.active,
      myRole: role,
      canManage: isAdmin(user) || role === "owner",
      members: members
        .filter((m) => m.groupId === group.id)
        .map(({ groupId: _, ...m }) => m),
    };
  });
};

/** What the Groups tab shows: the groups, and the people a manager can add. */
export const groupsSettings = async (db: Database, env: Env, user: User) => {
  const list = await listGroups(db, user);
  const manages = list.some((g) => g.canManage);

  const people = manages
    ? await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(and(eq(users.kind, "person"), eq(users.active, true)))
        .orderBy(asc(users.name))
    : [];

  return {
    groups: list,
    people,
    canCreate: isAdmin(user),
    mailDomain: env.MAIL_DOMAIN,
  };
};

/** A new group with no members yet: its address on the mail domain, unique among people, aliases and groups. */
export const createGroup = async (
  db: Database,
  env: Env,
  actor: User,
  input: { email: string; name: string; mode: GroupMode }
): Promise<{ id: string; email: string }> => {
  mustBeAdmin(actor);

  const email = mailboxAddress(env, input.email);
  const name = input.name.trim();

  if (!name) {
    throw new GroupError("A group needs a name: its mail goes out under it.");
  }

  if (await addressTaken(db, email)) {
    throw new GroupError(`${email} is already in use.`);
  }

  const id = newId("grp");

  // One batch: a group row never stands without its mailbox, nor a mailbox of kind group without its row.
  await db.batch([
    db.insert(users).values({ id, email, name, kind: "group", role: "member" }),
    db.insert(groups).values({ id, mode: input.mode }),
  ]);

  return { id, email };
};

export const renameGroup = async (
  db: Database,
  actor: User,
  id: string,
  typed: string
) => {
  await mustManage(db, actor, id);
  await groupOf(db, id);

  const name = typed.trim();

  if (!name) {
    throw new GroupError("A group needs a name: its mail goes out under it.");
  }

  await db
    .update(users)
    .set({ name })
    .where(and(eq(users.id, id), eq(users.kind, "group")));
};

/** Off, a group refuses its mail (the sender gets a bounce) and leaves Mail; its shared mail stays for when it is on. */
export const setGroupActive = async (
  db: Database,
  actor: User,
  id: string,
  active: boolean
) => {
  mustBeAdmin(actor);
  await groupOf(db, id);
  await db
    .update(users)
    .set({ active })
    .where(and(eq(users.id, id), eq(users.kind, "group")));
};

/**
 * Delete a distribution group for good: it holds no mail of its own, so its members' copies stay with them. A shared
 * group keeps its conversations, so it is only ever turned off.
 */
export const deleteGroup = async (db: Database, actor: User, id: string) => {
  mustBeAdmin(actor);

  const { group } = await groupOf(db, id);

  if (group.mode !== "distribute") {
    throw new GroupError("A shared inbox keeps its mail: turn it off instead.");
  }

  await db.batch([
    db.delete(groupMembers).where(eq(groupMembers.groupId, id)),
    db.delete(groups).where(eq(groups.id, id)),
    db.delete(users).where(and(eq(users.id, id), eq(users.kind, "group"))),
  ]);
};

/** Add an active person, by their address, as a member or an owner; someone already in it takes the new role. */
export const addMember = async (
  db: Database,
  actor: User,
  groupId: string,
  typed: string,
  role: GroupRole
): Promise<User> => {
  await mustManage(db, actor, groupId);
  await groupOf(db, groupId);

  const email = typed.trim().toLowerCase();

  const person = await db.query.users.findFirst({
    where: and(eq(users.email, email), eq(users.kind, "person")),
  });

  if (!person?.active) {
    throw new GroupError(
      `Nobody active in the workspace has the address "${typed.trim()}".`
    );
  }

  await db
    .insert(groupMembers)
    .values({ groupId, userId: person.id, role })
    .onConflictDoUpdate({
      target: [groupMembers.groupId, groupMembers.userId],
      set: { role },
    });

  return person;
};

export const removeMember = async (
  db: Database,
  actor: User,
  groupId: string,
  userId: string
) => {
  await mustManage(db, actor, groupId);
  await db
    .delete(groupMembers)
    .where(
      and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId))
    );
};

export const setMemberRole = async (
  db: Database,
  actor: User,
  groupId: string,
  userId: string,
  role: GroupRole
) => {
  await mustManage(db, actor, groupId);

  const done = await db
    .update(groupMembers)
    .set({ role })
    .where(
      and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId))
    )
    .returning({ userId: groupMembers.userId });

  if (!done.length) {
    throw new GroupError("They are no longer in the group.");
  }
};

/**
 * A Groups form: `create`, `rename`, `activate` and `deactivate`, `delete` (an admin's), and `add`, `remove`,
 * `owner` and `member` (an admin's or a group owner's). `id` names the group, `userId` the member.
 */
export const groupsIntent = async (
  db: Database,
  env: Env,
  user: User,
  form: FormData
): Promise<SettingsResult> => {
  const id = field(form, "id");
  const userId = field(form, "userId");

  try {
    switch (field(form, "intent")) {
      case "create": {
        const created = await createGroup(db, env, user, {
          email: field(form, "email"),
          name: field(form, "name"),
          mode: field(form, "mode") === "shared" ? "shared" : "distribute",
        });

        return { message: `${created.email} is ready. Add its members below.` };
      }

      case "rename": {
        await renameGroup(db, user, id, field(form, "name"));

        return { message: "Renamed." };
      }

      case "deactivate": {
        await setGroupActive(db, user, id, false);

        return { message: "Turned off: mail to it now bounces." };
      }

      case "activate": {
        await setGroupActive(db, user, id, true);

        return { message: "Turned on." };
      }

      case "delete": {
        await deleteGroup(db, user, id);

        return { message: "Group deleted." };
      }

      case "add": {
        const person = await addMember(
          db,
          user,
          id,
          field(form, "email"),
          field(form, "role") === "owner" ? "owner" : "member"
        );

        return { message: `${person.name} is in the group.` };
      }

      case "remove": {
        await removeMember(db, user, id, userId);

        return { message: "Removed from the group." };
      }

      case "owner": {
        await setMemberRole(db, user, id, userId, "owner");

        return { message: "Now an owner of the group." };
      }

      case "member": {
        await setMemberRole(db, user, id, userId, "member");

        return { message: "Now a member of the group." };
      }

      default: {
        return {};
      }
    }
  } catch (error) {
    if (error instanceof GroupError || error instanceof PeopleError) {
      return { error: error.message };
    }

    throw error;
  }
};
