/**
 * The server functions OpenPGP's pieces of the console call: the person's key and the keys of others under Settings →
 * Mail, the composer's check for recipients without a key, and "Check again" on a message. A plain module, as the
 * other `actions.ts`: the components import it, and only its handlers reach the `*.server.ts` modules.
 */
import { createServerFn } from "@tanstack/react-start";

import { formData, formPost } from "~/lib/forms";
import { field } from "~/lib/guards";
import { appContext } from "~/lib/request.server";

import { parseAddressList } from "../addresses";
import { savePreferences } from "../preferences.server";
import {
  PgpError,
  exportOwnKey,
  generateOwnKey,
  importOwnKey,
  importPeerKeys,
  ownKeyRow,
  removeOwnKey,
  removePeerKey,
} from "./keys.server";
import { recipientKeys } from "./lookup.server";
import type { PgpStatus } from "./pgp";
import { recheckPgpMessage } from "./recheck.server";

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
 * typed, spaces and all.
 */
export const pgpAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<PgpResult> => {
    const { db, env, user } = await appContext();
    const intent = field(data, "intent");

    try {
      switch (intent) {
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
            field(data, "privateKey"),
            field(data, "passphrase")
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
            field(data, "passphrase")
          );

          return {
            ok: true,
            message: "Exported, locked with your passphrase.",
            download: { filename: `${user.email}-private-key.asc`, text },
          };
        }

        case "sign-default": {
          const on = field(data, "on") === "on";

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
            field(data, "publicKey")
          );

          return { ok: true, message: `Kept for ${kept.join(", ")}.` };
        }

        case "remove-peer": {
          await removePeerKey(db, user.id, field(data, "address"));

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
  });

/**
 * The composer's recipients (`to`, `cc`, `bcc` as typed) that no key can be found for, so Encrypt can say whom it
 * cannot reach before Send refuses. Asks their domains over WKD for what is not kept.
 */
export const pgpRecipientsAction = createServerFn({ method: "POST" })
  .validator((d: { to: string; cc: string; bcc: string }) => ({
    to: String(d?.to ?? ""),
    cc: String(d?.cc ?? ""),
    bcc: String(d?.bcc ?? ""),
  }))
  .handler(async ({ data }): Promise<{ missing: string[] }> => {
    const { db, env, user } = await appContext();

    const addresses = [data.to, data.cc, data.bcc].flatMap((list) =>
      parseAddressList(list).addresses.map((a) => a.email)
    );

    const { missing } = await recipientKeys(env, db, user, addresses);

    return { missing };
  });

/** "Check again": the message opened anew with the keys at hand now. */
export const recheckPgpAction = createServerFn({ method: "POST" })
  .validator((d: { messageId: string }) => ({
    messageId: String(d?.messageId ?? ""),
  }))
  .handler(async ({ data }): Promise<{ pgp: PgpStatus | null }> => {
    const { db, env, user } = await appContext();

    try {
      return { pgp: await recheckPgpMessage(env, db, user, data.messageId) };
    } catch (error) {
      if (error instanceof PgpError) {
        return { pgp: null };
      }

      throw error;
    }
  });
