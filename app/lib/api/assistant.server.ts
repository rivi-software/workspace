/** The Assistant section of the Workspace API (docs/API.md): the conversations, and a question answered as the UI message stream the console's page reads. */
import { waitUntil } from "cloudflare:workers";

import { AI_OFF, aiEnabled } from "~/lib/ai";
import { SUGGESTIONS } from "~/lib/assistant/assistant";
import {
  answerChat,
  deleteConversation,
  getConversation,
  listConversations,
} from "~/lib/assistant/chat.server";
import { assistantModel } from "~/lib/assistant/provider.server";

import { fieldOrNull, readBody } from "./body.server";
import { ApiRequestError, json } from "./routing.server";
import type { ApiContext, ApiHandler, ApiRoute } from "./routing.server";

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

/**
 * A question, answered as server-sent events on `AI_PROVIDER`'s model (`assistantModel`, a `500` without its AI
 * binding); the answer is stored after the stream, which `waitUntil` keeps the Worker alive for.
 */
const chat = async (context: ApiContext): Promise<Response> => {
  const { db, env, user, request } = context;
  const body = await readBody(request);

  const answer = await answerChat(
    env,
    db,
    user,
    await assistantModel(env),
    {
      conversationId: fieldOrNull(body, "conversationId"),
      message: body.message,
      timeZone: fieldOrNull(body, "timeZone"),
    },
    request.signal
  );

  waitUntil(answer.done);

  const response = new Response(answer.response.body, answer.response);
  response.headers.set("Cache-Control", "no-store");

  return response;
};

/** While `AI_FEATURES` is off the whole section answers 404, as if it were not there. */
const whileOn =
  (handler: ApiHandler): ApiHandler =>
  async (context) => {
    if (!aiEnabled(context.env)) {
      throw new ApiRequestError(AI_OFF, 404);
    }

    return await handler(context);
  };

export const assistantRoutes: ApiRoute[] = [
  { method: "GET", path: "/assistant/conversations", handler: whileOn(list) },
  {
    method: "GET",
    path: "/assistant/conversations/:id",
    handler: whileOn(one),
  },
  {
    method: "DELETE",
    path: "/assistant/conversations/:id",
    writes: true,
    handler: whileOn(remove),
  },
  {
    method: "POST",
    path: "/assistant/chat",
    writes: true,
    handler: whileOn(chat),
  },
];
