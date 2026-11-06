import { createServerFn } from "@tanstack/react-start";

import { field, formData, formPost } from "../forms";
import { appContext } from "../request.server";
import { deleteConversation } from "./chat.server";

/**
 * The server functions the Assistant's components call. A plain module, as `mail/actions.ts`: the components
 * import it, and only its handlers reach the `*.server.ts` modules.
 */

/** Delete a conversation with its messages, for good. */
export const deleteConversationAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }) => {
    const { db, user } = await appContext();
    const ok = await deleteConversation(db, user.id, field(data, "id"));

    if (!ok) {
      throw new Error("No such conversation.");
    }

    return { ok: true as const };
  });
