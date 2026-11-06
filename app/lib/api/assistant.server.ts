/** The Assistant section of the Workspace API (docs/API.md): the conversations, and a question answered as the UI message stream the console's page reads. */
import { waitUntil } from "cloudflare:workers";

import { SUGGESTIONS } from "~/lib/assistant/assistant";
import {
  answerChat,
  deleteConversation,
  getConversation,
  listConversations,
} from "~/lib/assistant/chat.server";

import { fieldOrNull, readBody } from "./body.server";
import { ApiRequestError, json } from "./routing.server";
import type { ApiContext, ApiRoute } from "./routing.server";

const list = async (context: ApiContext): Promise<Response> => {
  const { db, user } = context;

  return json({
    conversations: await listConversations(db, user.id),
    suggestions: [...SUGGESTIONS],
  });
};

const one = async (context: ApiContext): Promise<Response> => {
  const { db, user, params } = context;
  const conversation = await getConversation(db, user.id, params.id ?? "");

  if (!conversation) {
    throw new ApiRequestError("No such conversation.", 404);
  }

  return json(conversation);
};

const remove = async (context: ApiContext): Promise<Response> => {
  const { db, user, params } = context;

  if (!(await deleteConversation(db, user.id, params.id ?? ""))) {
    throw new ApiRequestError("No such conversation.", 404);
  }

  return json({ ok: true });
};

/** A question, answered as server-sent events; the answer is stored after the stream, which `waitUntil` keeps the Worker alive for. */
const chat = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, request } = context;
  const body = await readBody(request);

  const answer = await answerChat(
    env,
    db,
    user,
    {
      conversationId: fieldOrNull(body, "conversationId"),
      message: body.message,
    },
    request.signal
  );

  waitUntil(answer.done);

  const response = new Response(answer.response.body, answer.response);
  response.headers.set("Cache-Control", "no-store");

  return response;
};

export const assistantRoutes: ApiRoute[] = [
  { method: "GET", path: "/assistant/conversations", handler: list },
  { method: "GET", path: "/assistant/conversations/:id", handler: one },
  {
    method: "DELETE",
    path: "/assistant/conversations/:id",
    writes: true,
    handler: remove,
  },
  { method: "POST", path: "/assistant/chat", writes: true, handler: chat },
];
