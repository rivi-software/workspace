/**
 * The mailbox a Mail server function acts in, for `actions.ts`'s handlers: server-only, since it reads the request.
 */
import { appContext } from "~/lib/request.server";

import { mailboxFor } from "./groups.server";

/**
 * The person and the mailbox they act in: their own, or the shared group inbox `box` names, once `mailboxFor` has
 * found them in it. `user` is the mailbox, the owner every Mail function scopes by; `person` is who is signed in.
 */
export const mailContext = async (box: string | null) => {
  const ctx = await appContext();
  const mailbox = await mailboxFor(ctx.db, ctx.user, box);

  return { ...ctx, person: ctx.user, user: mailbox };
};
