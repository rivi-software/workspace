/**
 * Settings → People, an admin's: everyone with a mailbox, their roles, aliases and passwords, their sessions,
 * recovery addresses, passkeys and authenticator app. What the tab loads (`peopleSettings`) and what its forms do
 * (`peopleIntent`), apart from the route so the tests call both; the work is `users.server.ts`'s and the modules
 * beside it.
 */
import type { Database } from "~/db";
import type { User } from "~/db/schema";

import { removeAllPasskeys, resetTwoFactor, revoke } from "./auth.server";
import { field } from "./guards";
import { removeRecoveryAddress } from "./recovery.server";
import type { SettingsResult } from "./settings";
import {
  PeopleError,
  addAlias,
  changeAddress,
  createPerson,
  listPeople,
  removeAlias,
  removePerson,
  resetPassword,
  setPersonActive,
  setPersonRole,
} from "./users.server";

/** What the People tab shows an admin; it refuses anyone else, whom Settings never shows the tab (`openTab`). */
export const peopleSettings = async (db: Database, env: Env, user: User) => {
  if (user.role !== "admin") {
    throw new Error("Only an admin sees People.");
  }

  return { people: await listPeople(db), mailDomain: env.MAIL_DOMAIN };
};

/** A person's new primary address, with what the admin tells them about their OpenPGP key. */
const changeAddressIntent = async (
  db: Database,
  env: Env,
  id: string,
  form: FormData
): Promise<SettingsResult> => {
  const changed = await changeAddress(
    db,
    env,
    id,
    field(form, "address"),
    form.get("keepOld") === "on"
  );

  // WKD publishes a key only at an address the key names (`serveWkd`).
  return {
    message: changed.hasPgpKey
      ? `Their address is now ${changed.address}. Their OpenPGP key names the old one: they make a new key under Settings → Mail to be found at the new address.`
      : `Their address is now ${changed.address}.`,
  };
};

/** A deactivated person removed for good, at once or over the next minutes. */
const removePersonIntent = async (
  db: Database,
  env: Env,
  actor: User,
  id: string,
  form: FormData
): Promise<SettingsResult> => {
  const removed = await removePerson(
    db,
    env,
    actor,
    id,
    field(form, "confirm")
  );

  return {
    message: removed.gone
      ? `${removed.email} is removed, with everything that was theirs.`
      : `Removing ${removed.email}: mail to them bounces now, and what was theirs goes over the next minutes.`,
  };
};

/**
 * A People form, for an admin only: `create` (a mailbox with a one-time password), `deactivate` and `activate`,
 * `address` (a new primary address), `remove` (a deactivated person, for good), `admin` and `member`, `reset` (a new one-time password), `alias` and `unalias`, `signout`, `recovery-remove`,
 * `passkeys-remove` and `two-factor-reset`. `id` names the person. An intent it does not know answers nothing.
 */
export const peopleIntent = async (
  db: Database,
  env: Env,
  user: User,
  form: FormData
): Promise<SettingsResult> => {
  if (user.role !== "admin") {
    return { error: "Only an admin can manage people." };
  }

  const id = field(form, "id");

  try {
    switch (field(form, "intent")) {
      case "create": {
        const created = await createPerson(db, env, {
          email: field(form, "email"),
          name: field(form, "name"),
          role: field(form, "role") === "admin" ? "admin" : "member",
        });

        return {
          message: `${created.email} is ready. Their one-time password:`,
          password: created.password,
        };
      }

      case "deactivate": {
        await setPersonActive(db, user, id, false);

        return { message: "Deactivated." };
      }

      case "activate": {
        await setPersonActive(db, user, id, true);

        return { message: "Reactivated." };
      }

      case "address": {
        return await changeAddressIntent(db, env, id, form);
      }

      case "remove": {
        return await removePersonIntent(db, env, user, id, form);
      }

      case "admin": {
        await setPersonRole(db, user, id, "admin");

        return { message: "Now an admin." };
      }

      case "member": {
        await setPersonRole(db, user, id, "member");

        return { message: "Now a member." };
      }

      case "reset": {
        const password = await resetPassword(db, id);

        return {
          message: "Signed out everywhere. Their new one-time password:",
          password,
        };
      }

      case "alias": {
        const address = await addAlias(db, env, id, field(form, "alias"));

        return { message: `${address} now reaches this mailbox.` };
      }

      case "unalias": {
        await removeAlias(db, id, field(form, "alias"));

        return { message: "Alias removed." };
      }

      case "signout": {
        await revoke(db, id, "sign-out-everywhere");

        return {
          message:
            "Signed out everywhere: their next request asks them to sign in.",
        };
      }

      case "recovery-remove": {
        await removeRecoveryAddress(db, id, field(form, "recoveryId"));

        return { message: "Recovery address removed." };
      }

      case "passkeys-remove": {
        // A lost device: the person signs in with their password until they add another.
        const removed = await removeAllPasskeys(db, id);

        return {
          message:
            removed === 1 ? "Passkey removed." : `${removed} passkeys removed.`,
        };
      }

      case "two-factor-reset": {
        // A lost authenticator: its secret and backup codes go, and the password alone signs them in again.
        await resetTwoFactor(db, id);

        return {
          message:
            "Two-factor authentication reset: their next password sign-in needs no code until they set up an authenticator app again.",
        };
      }

      default: {
        return {};
      }
    }
  } catch (error) {
    if (error instanceof PeopleError) {
      return { error: error.message };
    }

    throw error;
  }
};
