/**
 * Settings → Mail → OpenPGP: the person's own key and the keys of the people they write to. What the Mail tab loads
 * of it (`pgpSettings`) and what its forms do (`pgpIntent`), apart from `pgpAction` so the tests call both; the keys
 * themselves are `keys.server.ts`'s.
 */
import type { Database } from "~/db";
import type { User } from "~/db/schema";
import { field } from "~/lib/guards";

import { parsePreferences } from "../preferences";
import { savePreferences } from "../preferences.server";
import {
  PgpError,
  exportOwnKey,
  generateOwnKey,
  importOwnKey,
  importPeerKeys,
  listPeerKeys,
  ownKeyRow,
  ownKeyView,
  removeOwnKey,
  removePeerKey,
} from "./keys.server";

/** The person's own key, the keys of the people they write to, and whether a new message is signed by default. */
export const pgpSettings = async (db: Database, env: Env, user: User) => {
  const [own, peers] = await Promise.all([
    ownKeyView(db, user.id),
    listPeerKeys(db, user.id),
  ]);

  return {
    own,
    peers,
    signByDefault: parsePreferences(user.preferencesJson).pgpSign,
    mailDomain: env.MAIL_DOMAIN,
  };
};

export type PgpResult =
  | {
      ok: true;
      message: string;
      /** An exported key, for the page to save as a file. */
      download?: { filename: string; text: string };
    }
  | { ok: false; error: string };

/**
 * One intent: `generate`, `import` (`privateKey`, `passphrase`), `remove`, `export` (`passphrase`, which locks the
 * file), `sign-default` (`on`), `import-peer` (`publicKey`) and `remove-peer` (`address`). A passphrase is read as
 * typed, spaces and all. An intent it does not know is refused.
 */
export const pgpIntent = async (
  db: Database,
  env: Env,
  user: User,
  form: FormData
): Promise<PgpResult> => {
  try {
    switch (field(form, "intent")) {
      case "generate": {
        await generateOwnKey(env, db, user);

        return {
          ok: true,
          message:
            "Your key is ready. Export a copy and keep it somewhere safe: it is the only way back if this one is lost.",
        };
      }

      case "import": {
        await importOwnKey(
          env,
          db,
          user,
          field(form, "privateKey"),
          field(form, "passphrase")
        );

        return { ok: true, message: "Your key is imported." };
      }

      case "remove": {
        await removeOwnKey(db, user.id);

        return {
          ok: true,
          message:
            "Your key is removed. Mail encrypted to it can no longer be opened here.",
        };
      }

      case "export": {
        const text = await exportOwnKey(
          env,
          db,
          user.id,
          field(form, "passphrase")
        );

        return {
          ok: true,
          message: "Exported, locked with your passphrase.",
          download: { filename: `${user.email}-private-key.asc`, text },
        };
      }

      case "sign-default": {
        const on = field(form, "on") === "on";

        if (on && !(await ownKeyRow(db, user.id))) {
          return { ok: false, error: "Make or import a key first." };
        }

        await savePreferences(db, user.id, { pgpSign: on });

        return { ok: true, message: "Saved." };
      }

      case "import-peer": {
        const kept = await importPeerKeys(
          db,
          user.id,
          field(form, "publicKey")
        );

        return { ok: true, message: `Kept for ${kept.join(", ")}.` };
      }

      case "remove-peer": {
        await removePeerKey(db, user.id, field(form, "address"));

        return { ok: true, message: "Removed." };
      }

      default: {
        return { ok: false, error: "Unknown action." };
      }
    }
  } catch (error) {
    if (error instanceof PgpError) {
      return { ok: false, error: error.message };
    }

    throw error;
  }
};
