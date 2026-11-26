import { createFileRoute } from "@tanstack/react-router";
import { env, waitUntil } from "cloudflare:workers";

import { createDb } from "~/db";
import { AssistantError, answerChat } from "~/lib/assistant/chat.server";
import { assistantModel } from "~/lib/assistant/provider.server";
import { getSessionUser } from "~/lib/auth.server";
import { isJsonObject, stringOrNull } from "~/lib/guards";

const problem = (error: string, status = 400) =>
  Response.json({ ok: false, error }, { status });

/**
 * A question for the Assistant (`app/components/assistant/chat.tsx`): `POST /api/assistant/chat` with the
 * conversation (null for a new one) and the person's message, answered as a UI message stream (server-sent
 * events) the page renders as it comes. The session cookie is the gate (`SameSite=Lax` keeps another site's
 * form post out), and the answer is stored after the stream, which `waitUntil` keeps the Worker alive for. The
 * model is `AI_PROVIDER`'s (`assistantModel`); a Worker without its AI binding answers 500 rather than the mock.
 */
export const Route = createFileRoute("/api/assistant/chat")({
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

        const conversationId = isJsonObject(body)
          ? stringOrNull(body.conversationId)
          : null;

        const message = isJsonObject(body) ? body.message : undefined;

        const timeZone = isJsonObject(body)
          ? stringOrNull(body.timeZone)
          : null;

        const model = await assistantModel(env);

        try {
          const answer = await answerChat(
            env,
            db,
            user,
            model,
            { conversationId, message, timeZone },
            request.signal
          );

          waitUntil(answer.done);

          return answer.response;
        } catch (error) {
          if (error instanceof AssistantError) {
            return problem(error.message, error.status);
          }

          throw error;
        }
      },
    },
  },
});
