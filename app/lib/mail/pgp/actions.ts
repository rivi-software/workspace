/**
 * The server functions OpenPGP's pieces of the console call: the person's key and the keys of others under Settings →
 * Mail, the composer's check for recipients without a key, and "Check again" on a message. A plain module, as the
 * other `actions.ts`: the components import it, and only its handlers reach the `*.server.ts` modules.
 */
import { createServerFn } from "@tanstack/react-start";

import { formData, formPost } from "~/lib/forms";
import { appContext } from "~/lib/request.server";

import { parseAddressList } from "../addresses";
import { PgpError } from "./keys.server";
import { recipientKeys } from "./lookup.server";
import type { PgpStatus } from "./pgp";
import { recheckPgpMessage } from "./recheck.server";
import { pgpIntent } from "./settings.server";
import type { PgpResult } from "./settings.server";

export type { PgpResult } from "./settings.server";

/** Settings → Mail → OpenPGP's forms, which `pgpIntent` does. */
export const pgpAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<PgpResult> => {
    const { db, env, user } = await appContext();

    return pgpIntent(db, env, user, data);
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
