/**
 * Settings → Account, a person's own account and its security: the profile, the password, passkeys, the authenticator
 * app, recovery addresses and their sessions. What the tab loads (`accountSettings`) and what its forms do
 * (`accountIntent`), apart from the route so the tests call both; the work is the modules they call. Passkeys and the
 * authenticator app are enrolled through Better Auth's browser client, so no form here adds one. Mail's signatures
 * show on the same tab and are Mail's (`mail/signature-settings.server.ts`).
 */
import { redirect } from "@tanstack/react-router";
import { eq } from "drizzle-orm";

import type { Database } from "~/db";
import { passkeys } from "~/db/schema";
import type { User } from "~/db/schema";

import { endSession, listSessions, revoke } from "./auth.server";
import { field } from "./guards";
import {
  MAX_RECOVERY_ADDRESSES,
  RecoveryError,
  addRecoveryAddress,
  listRecoveryAddresses,
  removeRecoveryAddress,
  resendConfirmation,
} from "./recovery.server";
import type { SettingsResult } from "./settings";
import { PeopleError, changeOwnPassword, updateProfile } from "./users.server";

/** How many passkeys a person may add: a laptop, a phone, a key or two, with room to spare. */
export const MAX_PASSKEYS = 10;

/** What the Account tab shows of the person's security, beside who they are. `request` carries their session. */
export const accountSettings = async (
  db: Database,
  env: Env,
  user: User,
  request: Request
) => {
  const [passkeyRows, sessions, recoveryRows] = await Promise.all([
    db.query.passkeys.findMany({
      where: eq(passkeys.userId, user.id),
      orderBy: (p, { asc }) => [asc(p.createdAt)],
    }),
    listSessions(request, env, db, user.id),
    listRecoveryAddresses(db, user.id),
  ]);

  return {
    // Whether a password sign-in asks for an authenticator app's code (`<TwoFactor>`); a passkey sign-in never does.
    twoFactorEnabled: user.twoFactorEnabled,
    // What signs the person in without a password (`<Passkeys>`), oldest first.
    passkeys: passkeyRows.map((p) => ({
      id: p.id,
      name: p.name ?? "Passkey",
      createdAt: p.createdAt.toISOString(),
      backedUp: p.backedUp,
    })),
    maxPasskeys: MAX_PASSKEYS,
    // Every browser the person is signed in on, newest first, for signing one out from here.
    sessions,
    // Where a reset link goes when the person forgets their password (`app/lib/recovery.server.ts`).
    recoveryAddresses: recoveryRows.map(({ id, address, confirmedAt }) => ({
      id,
      address,
      confirmedAt,
    })),
    maxRecoveryAddresses: MAX_RECOVERY_ADDRESSES,
    mailDomain: env.MAIL_DOMAIN,
  };
};

/** What an Account form answers; a new password also the cookie of the browser's session, never for the page. */
export interface AccountResult extends SettingsResult {
  cookie?: string;
}

/**
 * An Account form: `profile` (the name), `password` (with the current one; `request` carries the session Better Auth
 * renews), `recovery-add`, `recovery-resend` and `recovery-remove`, `revoke-session` (one browser of the person's,
 * `id`), and `signout-all`, which ends every session of theirs and answers a redirect to the sign-in page. An intent
 * it does not know answers nothing.
 */
export const accountIntent = async (
  db: Database,
  env: Env,
  user: User,
  form: FormData,
  request: Request
): Promise<AccountResult> => {
  try {
    switch (field(form, "intent")) {
      case "profile": {
        await updateProfile(db, user.id, { name: field(form, "name") });

        return { message: "Saved." };
      }

      case "password": {
        // Every other session ended with the old password; this browser goes on, in the new session Better Auth
        // made for it when it made one.
        const cookie = await changeOwnPassword(request, env, {
          current: field(form, "current"),
          password: field(form, "password"),
          confirm: field(form, "confirm"),
        });

        const changed: AccountResult = {
          message:
            "Password changed. Every other browser and device is signed out.",
        };

        if (cookie) {
          changed.cookie = cookie;
        }

        return changed;
      }

      case "recovery-add": {
        const address = await addRecoveryAddress(env, db, user, {
          address: field(form, "address"),
          password: field(form, "current"),
        });

        return { message: `We sent a confirmation link to ${address}.` };
      }

      case "recovery-resend": {
        const address = await resendConfirmation(
          env,
          db,
          user,
          field(form, "id")
        );

        return { message: `Sent again to ${address}.` };
      }

      case "recovery-remove": {
        await removeRecoveryAddress(db, user.id, field(form, "id"));

        return { message: "Recovery address removed." };
      }

      case "revoke-session": {
        await endSession(db, user.id, field(form, "id"));

        return { message: "Signed out there." };
      }

      case "signout-all": {
        // Every session of the person is over, this one included: the sign-in page is next.
        await revoke(db, user.id, "sign-out-everywhere");
        throw redirect({ href: "/login" });
      }

      default: {
        return {};
      }
    }
  } catch (error) {
    if (error instanceof PeopleError || error instanceof RecoveryError) {
      return { error: error.message };
    }

    throw error;
  }
};
