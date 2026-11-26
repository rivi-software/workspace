import { createServerFn } from "@tanstack/react-start";

import { formData, formPost } from "../forms";
import { field } from "../guards";
import { appContext } from "../request.server";
import { deleteConversation, undoStep } from "./chat.server";
import { draftMessage } from "./mail-ai.server";
import { assistantModel, assistantReady } from "./provider.server";
import { askZone } from "./time";

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

/** Undo what a step of an answer did to the person's mail (`undoStep`); a refusal comes back in words. */
export const undoStepAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }) => {
    const { db, env, user } = await appContext();

    return await undoStep(db, env, user.id, {
      conversationId: field(data, "conversationId"),
      messageId: field(data, "messageId"),
      toolCallId: field(data, "toolCallId"),
    });
  });

/**
 * A first version of a message for the composer (`draftMessage`): a reply in the conversation named, or a
 * new message, saying what the person asked for. Answers the text for the editor, or why there is none.
 */
export const draftWithAiAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }) => {
    const { db, env, user, request } = await appContext();

    if (!assistantReady(env)) {
      return {
        ok: false as const,
        error: "There is no AI model to write the draft.",
      };
    }

    return await draftMessage(
      env,
      db,
      user,
      await assistantModel(env),
      {
        threadId: field(data, "threadId") || null,
        instruction: field(data, "instruction"),
        to: field(data, "to"),
        cc: field(data, "cc"),
        subject: field(data, "subject"),
        timeZone: askZone(field(data, "timeZone")),
      },
      request.signal
    );
  });
