import { sendMail } from "@rivi-software/workers-mail";
/**
 * A forgotten password, reset without an admin: a person keeps recovery addresses outside `MAIL_DOMAIN` (their own
 * mailbox is no help while they cannot sign in), confirms each from a link mailed to it, and `/forgot-password`
 * mails a reset link to the confirmed ones. Links are single use, kept as their SHA-256, and carry the token in
 * the fragment, which no request carries: Workers Logs keep each request's full URL. A reset changes the password
 * and ends every session; an authenticator app, when the person has one, still confirms the next sign-in.
 */
import { and, count, eq, gt, isNotNull, lt } from "drizzle-orm";

import type { Database } from "~/db";
import { recoveryAddresses, recoveryTokens, users } from "~/db/schema";
import type { User } from "~/db/schema";
import { randomToken, sha256Hex } from "~/lib/crypto";
import { errorMessage } from "~/lib/guards";

import { checkPassword, clearLoginFailures } from "./auth.server";
import { newId } from "./ids";
import { domainOf, isValidEmail } from "./mail/addresses";
import { textToHtml } from "./text";
import { changePassword, passwordProblem } from "./users.server";

export class RecoveryError extends Error {
  override name = "RecoveryError";
}

export const MAX_RECOVERY_ADDRESSES = 3;
export const CONFIRM_PATH = "/confirm-recovery";
export const RESET_PATH = "/reset-password";
const CONFIRM_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;

// Links of one kind a person can be sent in an hour, so neither form can flood a mailbox.
const LINKS_PER_HOUR = 5;

type Purpose = (typeof recoveryTokens.$inferSelect)["purpose"];

export const EXPIRED_LINK =
  "This link has expired or was already used. Ask for a new one and open the latest mail.";

export const listRecoveryAddresses = async (db: Database, userId: string) =>
  await db.query.recoveryAddresses.findMany({
    where: eq(recoveryAddresses.userId, userId),
    orderBy: (r, { asc }) => [asc(r.createdAt)],
  });

const link = (env: Env, path: string, token: string): string =>
  `${env.APP_URL.replace(/\/+$/u, "")}${path}#${token}`;

const issueToken = async (
  db: Database,
  input: {
    purpose: Purpose;
    userId: string;
    recoveryAddressId?: string;
    ttl: number;
  }
): Promise<string> => {
  const now = Date.now();
  // Links that expired a day ago go; younger ones still count towards `LINKS_PER_HOUR`.
  await db
    .delete(recoveryTokens)
    .where(
      lt(
        recoveryTokens.expiresAt,
        new Date(now - 24 * 60 * 60 * 1000).toISOString()
      )
    );
  const token = randomToken(32);
  await db.insert(recoveryTokens).values({
    tokenHash: await sha256Hex(token),
    purpose: input.purpose,
    userId: input.userId,
    recoveryAddressId: input.recoveryAddressId ?? null,
    expiresAt: new Date(now + input.ttl).toISOString(),
  });

  return token;
};

const linksInLastHour = async (
  db: Database,
  userId: string,
  purpose: Purpose
): Promise<number> => {
  const [row] = await db
    .select({ n: count() })
    .from(recoveryTokens)
    .where(
      and(
        eq(recoveryTokens.userId, userId),
        eq(recoveryTokens.purpose, purpose),
        gt(
          recoveryTokens.createdAt,
          new Date(Date.now() - 60 * 60 * 1000).toISOString()
        )
      )
    );

  return row?.n ?? 0;
};

/** From `no-reply@` on the mail domain, which SES and Email Service send as (the domain is onboarded in both). */
const sendRecoveryMail = async (
  env: Env,
  to: string,
  mail: { subject: string; text: string }
) => {
  await sendMail(env, {
    from: { email: `no-reply@${env.MAIL_DOMAIN}`, name: env.APP_NAME },
    to,
    subject: mail.subject,
    text: mail.text,
    html: textToHtml(mail.text),
  });
};

const sendConfirmation = async (
  env: Env,
  db: Database,
  user: User,
  row: { id: string; address: string }
) => {
  if (
    (await linksInLastHour(db, user.id, "confirm-address")) >= LINKS_PER_HOUR
  ) {
    throw new RecoveryError(
      "Too many confirmation mails in the last hour. Wait a while, then send it again."
    );
  }

  const token = await issueToken(db, {
    purpose: "confirm-address",
    userId: user.id,
    recoveryAddressId: row.id,
    ttl: CONFIRM_TTL_MS,
  });

  try {
    await sendRecoveryMail(env, row.address, {
      subject: `Confirm your recovery address for ${env.APP_NAME}`,
      text: [
        `${user.name} added this address to their ${env.APP_NAME} account (${user.email}) as a recovery address: if they forget their password, a link to reset it can be sent here.`,
        `Confirm the address:\n${link(env, CONFIRM_PATH, token)}`,
        "The link works for 24 hours. If you did not expect this mail, ignore it: the address is not used until it is confirmed.",
      ].join("\n\n"),
    });
  } catch (error) {
    // SAFETY: `sendRecoveryMail` fails with an Error from the mail client (MailError), whose optional `code` is a string; only `code` and `message` are read.
    const e = error as Error & { code?: string | number };
    throw new RecoveryError(
      `${row.address} is on your list, but the confirmation mail was not sent: ${[e.code, e.message].filter(Boolean).join(" ")}. Send it again.`
    );
  }
};

/**
 * Add a recovery address and mail it a confirmation link. The current password is asked for, because a recovery
 * address can reset it: a session left open somewhere must not be enough to add one.
 */
export const addRecoveryAddress = async (
  env: Env,
  db: Database,
  user: User,
  input: { address: string; password: string }
): Promise<string> => {
  if (!(await checkPassword(db, user.id, input.password))) {
    throw new RecoveryError("The current password is not right.");
  }

  const address = input.address.trim().toLowerCase();

  if (!isValidEmail(address)) {
    throw new RecoveryError(`"${input.address}" is not a valid address.`);
  }

  if (domainOf(address) === env.MAIL_DOMAIN.toLowerCase()) {
    throw new RecoveryError(
      `Choose an address outside ${env.MAIL_DOMAIN}: you cannot read mail here while you cannot sign in.`
    );
  }

  const existing = await listRecoveryAddresses(db, user.id);

  if (existing.some((r) => r.address === address)) {
    throw new RecoveryError(
      `${address} is already one of your recovery addresses.`
    );
  }

  if (existing.length >= MAX_RECOVERY_ADDRESSES) {
    throw new RecoveryError(
      `You can keep ${MAX_RECOVERY_ADDRESSES} recovery addresses. Remove one to add another.`
    );
  }

  const id = newId("rec");
  await db.insert(recoveryAddresses).values({ id, userId: user.id, address });
  await sendConfirmation(env, db, user, { id, address });

  return address;
};

/** Mail a pending address its confirmation link again; earlier links keep working until they expire. */
export const resendConfirmation = async (
  env: Env,
  db: Database,
  user: User,
  id: string
): Promise<string> => {
  const row = await db.query.recoveryAddresses.findFirst({
    where: and(
      eq(recoveryAddresses.id, id),
      eq(recoveryAddresses.userId, user.id)
    ),
  });

  if (!row) {
    throw new RecoveryError("That recovery address is no longer on your list.");
  }

  if (row.confirmedAt) {
    throw new RecoveryError(`${row.address} is already confirmed.`);
  }

  await sendConfirmation(env, db, user, row);

  return row.address;
};

/** Removing an address also voids the confirmation links sent to it (`ON DELETE CASCADE`). */
export const removeRecoveryAddress = async (
  db: Database,
  userId: string,
  id: string
) => {
  await db
    .delete(recoveryAddresses)
    .where(
      and(eq(recoveryAddresses.id, id), eq(recoveryAddresses.userId, userId))
    );
};

/** Deleting the row is what makes a link single use: of two requests with it, one gets the row. */
const spendToken = async (db: Database, purpose: Purpose, token: string) => {
  if (!token) {
    return null;
  }

  const [row] = await db
    .delete(recoveryTokens)
    .where(
      and(
        eq(recoveryTokens.tokenHash, await sha256Hex(token)),
        eq(recoveryTokens.purpose, purpose),
        gt(recoveryTokens.expiresAt, new Date().toISOString())
      )
    )
    .returning();

  return row ?? null;
};

/** Open a confirmation link: its address can receive reset links from now on. Null when the link is no good. */
export const confirmRecoveryAddress = async (
  db: Database,
  token: string
): Promise<{ address: string } | null> => {
  const spent = await spendToken(db, "confirm-address", token);

  if (!spent?.recoveryAddressId) {
    return null;
  }

  const row = await db.query.recoveryAddresses.findFirst({
    where: eq(recoveryAddresses.id, spent.recoveryAddressId),
  });

  if (!row) {
    return null;
  }

  if (!row.confirmedAt) {
    await db
      .update(recoveryAddresses)
      .set({ confirmedAt: new Date().toISOString() })
      .where(eq(recoveryAddresses.id, row.id));
  }

  return { address: row.address };
};

/**
 * The form of `/forgot-password`: a reset link to every confirmed recovery address of the active person with this
 * address. It answers nothing, so the form cannot tell who has an account; the route runs it after its response,
 * so the time it takes cannot tell either. Beyond `LINKS_PER_HOUR` links an hour, nothing more is sent.
 */
export const requestPasswordReset = async (
  env: Env,
  db: Database,
  typed: string
): Promise<void> => {
  const email = typed.trim().toLowerCase();

  if (!isValidEmail(email)) {
    return;
  }

  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (!user?.active) {
    return;
  }

  const addresses = await db.query.recoveryAddresses.findMany({
    where: and(
      eq(recoveryAddresses.userId, user.id),
      isNotNull(recoveryAddresses.confirmedAt)
    ),
  });

  if (!addresses.length) {
    return;
  }

  if (
    (await linksInLastHour(db, user.id, "reset-password")) >= LINKS_PER_HOUR
  ) {
    console.warn(
      JSON.stringify({ event: "recovery.throttled", userId: user.id })
    );

    return;
  }

  const token = await issueToken(db, {
    purpose: "reset-password",
    userId: user.id,
    ttl: RESET_TTL_MS,
  });

  const text = [
    `Someone asked to reset the password of ${user.email} on ${env.APP_NAME}, which has this address for recovery.`,
    `Choose a new password:\n${link(env, RESET_PATH, token)}`,
    "The link works once, for 30 minutes. If you did not ask for it, ignore this mail: the password stays as it is.",
  ].join("\n\n");

  for (const a of addresses) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one mail at a time per address
      await sendRecoveryMail(env, a.address, {
        subject: `Reset your ${env.APP_NAME} password`,
        text,
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "recovery.mail-failed",
          userId: user.id,
          error: errorMessage(error),
        })
      );
    }
  }
};

/**
 * The form of `/reset-password`: a new password for the person the link was sent for. The link is only spent once
 * the password passes, so a rejected one can be retried; then every reset link of the person is void, every
 * session over, and the sign-in throttle of this client lifted.
 */
export const resetPassword = async (
  env: Env,
  db: Database,
  input: { token: string; password: string; confirm: string },
  ip: string | null = null
): Promise<void> => {
  if (input.password !== input.confirm) {
    throw new RecoveryError("The new passwords do not match.");
  }

  const problem = passwordProblem(input.password);

  if (problem) {
    throw new RecoveryError(problem);
  }

  const spent = await spendToken(db, "reset-password", input.token);

  if (!spent) {
    throw new RecoveryError(EXPIRED_LINK);
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, spent.userId),
  });

  if (!user?.active) {
    throw new RecoveryError(
      "This account has been deactivated. Ask an admin to reactivate it."
    );
  }

  // A new password ends every session of the person (`setPassword`).
  await changePassword(db, user.id, input.password);
  await db
    .delete(recoveryTokens)
    .where(
      and(
        eq(recoveryTokens.userId, user.id),
        eq(recoveryTokens.purpose, "reset-password")
      )
    );
  await clearLoginFailures(env.KV, ip, user.email);
};

// ---------- links ----------
