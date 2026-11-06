import { APIError } from "@better-auth/core/error";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/db";
import { aliases, passkeys, users } from "~/db/schema";
import type { User } from "~/db/schema";

import {
  authFor,
  createPasswordAccount,
  generatePassword,
  revoke,
  sessionCookieName,
  setPassword,
} from "./auth.server";
import { newId } from "./ids";
import { canonicalAddress, isValidEmail } from "./mail/addresses";

export class PeopleError extends Error {
  override name = "PeopleError";
}

export const listPeople = async (db: Database) => {
  const people = await db.query.users.findMany({
    orderBy: (u, { asc }) => [asc(u.name)],
  });

  const aliasRows = await db.query.aliases.findMany();

  const recoveryRows = await db.query.recoveryAddresses.findMany({
    orderBy: (r, { asc }) => [asc(r.createdAt)],
  });

  const passkeyRows = await db
    .select({ userId: passkeys.userId })
    .from(passkeys);

  return people.map((p) => ({
    id: p.id,
    email: p.email,
    name: p.name,
    role: p.role,
    active: p.active,
    createdAt: p.createdAt,
    lastSignInAt: p.lastSignInAt,
    // Whether their password sign-in asks for an authenticator app's code, for an admin resetting a lost one.
    twoFactorEnabled: p.twoFactorEnabled,
    aliases: aliasRows.filter((a) => a.userId === p.id).map((a) => a.address),
    // Where their reset links go (Settings → Account), for an admin helping someone who is locked out.
    recoveryAddresses: recoveryRows
      .filter((r) => r.userId === p.id)
      .map((r) => ({
        id: r.id,
        address: r.address,
        confirmed: !!r.confirmedAt,
      })),
    // How many passkeys sign them in, for an admin removing them when the person lost theirs.
    passkeys: passkeyRows.filter((k) => k.userId === p.id).length,
  }));
};

/** An address on the workspace's mail domain, from the part a person typed before the @ (or a full address on it). */
export const mailboxAddress = (env: Env, typed: string): string => {
  const raw = typed.trim().toLowerCase();
  const address = raw.includes("@") ? raw : `${raw}@${env.MAIL_DOMAIN}`;

  if (!isValidEmail(address)) {
    throw new PeopleError(`"${typed}" is not a valid address.`);
  }

  if (!address.endsWith(`@${env.MAIL_DOMAIN}`)) {
    throw new PeopleError(
      `Addresses are on ${env.MAIL_DOMAIN}; "${address}" is not.`
    );
  }

  if (address !== canonicalAddress(address)) {
    throw new PeopleError(
      "An address cannot carry a +tag: tags reach the address without one."
    );
  }

  return address;
};

const addressTaken = async (
  db: Database,
  address: string
): Promise<boolean> => {
  const u = await db.query.users.findFirst({ where: eq(users.email, address) });

  if (u) {
    return true;
  }

  const a = await db.query.aliases.findFirst({
    where: eq(aliases.address, address),
  });

  return !!a;
};

/** Create a mailbox; the one-time password is returned once, for the admin to hand over. */
export const createPerson = async (
  db: Database,
  env: Env,
  input: { email: string; name: string; role: "admin" | "member" }
): Promise<{ id: string; email: string; password: string }> => {
  const email = mailboxAddress(env, input.email);
  const name = input.name.trim();

  if (!name) {
    throw new PeopleError("A name is needed.");
  }

  if (await addressTaken(db, email)) {
    throw new PeopleError(`${email} is already in use.`);
  }

  const password = generatePassword();
  const id = newId("usr");
  await db.insert(users).values({ id, email, name, role: input.role });
  await createPasswordAccount(db, id, password);

  return { id, email, password };
};

export const setPersonActive = async (
  db: Database,
  actor: User,
  id: string,
  active: boolean
) => {
  if (actor.id === id && !active) {
    throw new PeopleError("You cannot deactivate your own account.");
  }

  await db.update(users).set({ active }).where(eq(users.id, id));

  // A deactivated person's open sessions end at once, not at their next request.
  if (!active) {
    await revoke(db, id, "deactivation");
  }
};

export const setPersonRole = async (
  db: Database,
  actor: User,
  id: string,
  role: "admin" | "member"
) => {
  if (actor.id === id && role !== "admin") {
    throw new PeopleError(
      "You cannot take the admin role from your own account."
    );
  }

  await db.update(users).set({ role }).where(eq(users.id, id));
};

/** A new one-time password for someone who lost theirs; their sessions end with the old one. */
export const resetPassword = async (
  db: Database,
  id: string
): Promise<string> => {
  const password = generatePassword();
  await setPassword(db, id, password);

  return password;
};

export const addAlias = async (
  db: Database,
  env: Env,
  userId: string,
  typed: string
) => {
  const address = mailboxAddress(env, typed);

  if (await addressTaken(db, address)) {
    throw new PeopleError(`${address} is already in use.`);
  }

  await db.insert(aliases).values({ address, userId });

  return address;
};

export const removeAlias = async (
  db: Database,
  userId: string,
  address: string
) => {
  await db
    .delete(aliases)
    .where(and(eq(aliases.address, address), eq(aliases.userId, userId)));
};

export const updateProfile = async (
  db: Database,
  userId: string,
  input: { name: string }
) => {
  const name = input.name.trim();

  if (!name) {
    throw new PeopleError("A name is needed.");
  }

  await db.update(users).set({ name }).where(eq(users.id, userId));
};

/** What keeps a new password from being accepted, or null when it is fine. */
export const passwordProblem = (password: string): string | null =>
  password.length < 12 ? "A password has at least 12 characters." : null;

/** A new password the person chose, from a reset link; every session of theirs ends (`setPassword`). */
export const changePassword = async (
  db: Database,
  userId: string,
  password: string
) => {
  const problem = passwordProblem(password);

  if (problem) {
    throw new PeopleError(problem);
  }

  await setPassword(db, userId, password);
};

/**
 * Settings → Account: the person's own new password, with the current one, through Better Auth. Every other session
 * ends with the old password, and this browser goes on in a new session. Answers that session's `Set-Cookie` value,
 * or null when Better Auth kept the session as it was.
 */
export const changeOwnPassword = async (
  request: Request,
  env: Env,
  input: { current: string; password: string; confirm: string }
): Promise<string | null> => {
  if (input.password !== input.confirm) {
    throw new PeopleError("The new passwords do not match.");
  }

  const problem = passwordProblem(input.password);

  if (problem) {
    throw new PeopleError(problem);
  }

  try {
    const auth = await authFor(env);

    const { headers } = await auth.api.changePassword({
      body: {
        currentPassword: input.current,
        newPassword: input.password,
        revokeOtherSessions: true,
      },
      headers: request.headers,
      returnHeaders: true,
    });

    return (
      headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith(`${sessionCookieName(env)}=`)) ??
      null
    );
  } catch (error) {
    if (error instanceof APIError) {
      if (error.statusCode === 401) {
        throw new PeopleError("Your session has ended. Sign in again.");
      }

      if (error.body?.code === "INVALID_PASSWORD") {
        throw new PeopleError("The current password is not right.");
      }

      throw new PeopleError(error.message);
    }

    throw error;
  }
};
