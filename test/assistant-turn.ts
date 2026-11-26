import { env } from "cloudflare:workers";
import { expect } from "vitest";

import type { User } from "~/db/schema";
import { isToolPart } from "~/lib/assistant/assistant";
import type { Json, StoredPart } from "~/lib/assistant/assistant";
import { answerChat, getConversation } from "~/lib/assistant/chat.server";

import { db, defined } from "./fixtures";
import { scriptedModel } from "./scripted-model";
import type { ScriptedStep } from "./scripted-model";

/*
 * A turn of the Assistant as the tests take one: a question on a model that follows a script, the answer read to
 * its end, and what the turn stored and the model was given.
 */

/** The person's message as the page posts it. */
export const question = (text: string) => ({
  role: "user",
  parts: [{ type: "text", text }],
});

/**
 * A question to the assistant on a model that takes the steps given, its answer read to the end (the stream), and
 * the stored turn waited for. `env` lays bindings over the Worker's for the tools.
 */
export const ask = async (
  user: User,
  text: string,
  steps: readonly ScriptedStep[],
  options: { conversationId?: string; env?: Env; timeZone?: string } = {}
) => {
  const model = scriptedModel(steps);

  const answer = await answerChat(options.env ?? env, db, user, model, {
    conversationId: options.conversationId ?? null,
    message: question(text),
    timeZone: options.timeZone,
  });

  expect(answer.response.headers.get("content-type")).toContain(
    "text/event-stream"
  );
  const body = await answer.response.text();
  await answer.done;

  const stored = defined(
    await getConversation(db, user.id, answer.conversationId)
  );

  const last = defined(stored.messages.at(-1), "last message");

  return { body, conversationId: answer.conversationId, stored, last, model };
};

/** What the model was given on its `n`th call (from 1): the system prompt, the conversation and the tools' results. */
export const promptOf = (model: ReturnType<typeof scriptedModel>, n: number) =>
  JSON.stringify(defined(model.doStreamCalls[n - 1], `call ${n}`).prompt);

/** A stored part is parsed JSON, so an object in one holds JSON values. */
export const isObject = (value: unknown): value is { [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The stored part of the tool `name`, its input and output read as objects (empty when it has none). */
export const toolPart = (parts: StoredPart[], name: string) => {
  const part = parts.find((p) => p.type === `tool-${name}`);

  if (!part || !isToolPart(part)) {
    return null;
  }

  const { input, output } = part;

  return {
    ...part,
    input: isObject(input) ? input : {},
    output: isObject(output) ? output : {},
  };
};
