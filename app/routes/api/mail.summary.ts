import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { createDb } from "~/db";
import { summarizeConversation } from "~/lib/assistant/mail-ai.server";
import {
  assistantModel,
  assistantReady,
} from "~/lib/assistant/provider.server";
import { askZone } from "~/lib/assistant/time";
import { getSessionUser } from "~/lib/auth.server";
import { isJsonObject, stringOrNull } from "~/lib/guards";

const problem = (error: string, status = 400) =>
  Response.json({ error }, { status });

/**
 * The summary of a conversation the person has open in Mail: `POST /api/mail/summary` with the
 * conversation and the reader's time zone, answered as the text itself, streamed as the model writes it. The
 * session cookie is the gate, as for the Assistant's chat (`SameSite=Lax` keeps another site's post out), and the
 * conversation must be in the person's own mailbox. Nothing is stored.
 */
export const Route = createFileRoute("/api/mail/summary")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const db = createDb(env.DB);
        const user = await getSessionUser(request, env, db);

        if (!user) {
          return problem("Sign in first.", 401);
        }

        if (
          !/^application\/json\b/iu.test(
            request.headers.get("content-type") ?? ""
          )
        ) {
          return problem("Expected JSON.", 415);
        }

        let body: unknown;

        try {
          body = await request.json();
        } catch {
          return problem("Expected JSON.");
        }

        const threadId = isJsonObject(body)
          ? stringOrNull(body.threadId)
          : null;

        const timeZone = askZone(
          isJsonObject(body) ? stringOrNull(body.timeZone) : null
        );

        if (!threadId) {
          return problem("Name the conversation.");
        }

        // A Worker without a model to ask answers so, rather than failing to resolve one.
        if (!assistantReady(env)) {
          return problem("There is no AI model to write the summary.", 503);
        }

        const summary = await summarizeConversation(
          env,
          db,
          user,
          await assistantModel(env),
          { threadId, timeZone },
          request.signal
        );

        return summary ?? problem("No such conversation.", 404);
      },
    },
  },
});
