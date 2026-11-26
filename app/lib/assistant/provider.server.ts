import { createAnthropic } from "@ai-sdk/anthropic";
import type { AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import { createAI } from "agents/models/ai-sdk";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";

import { aiEnabled } from "~/lib/ai";

import type { ChatModel } from "./chat.server";

export type AssistantProvider = "mock" | "workers-ai" | "anthropic";

const PROVIDERS = [
  "mock",
  "workers-ai",
  "anthropic",
] as const satisfies readonly AssistantProvider[];

/** The Claude model when `AI_CHAT_MODEL` names none, and the Workers AI one when it names none of Workers AI's. */
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";

export const DEFAULT_WORKERS_AI_MODEL =
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * The Claude models whose refusal the API retries on a model Anthropic picks for the refusal's category
 * (`fallbacks: "default"`), so a question about a security report in the person's mail that trips a safety
 * classifier still gets an answer. Claude Haiku 5.5 has no server-side fallback.
 */
const SERVER_FALLBACK_MODELS = new Set([
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-fable-5-2",
]);

/**
 * What every call of a Claude model takes besides its prompt:
 *
 * - `effort`: `medium`, the level for several tool calls in a row while a person waits. The model always thinks
 *   before it answers, and this is what sets how long.
 * - `cacheControl`: the request's prefix (the tools, the system prompt, the conversation so far) is cached, so each
 *   further step of a turn and the next question read it at a tenth of the price.
 * - `fallbacks`: the refusal fallback above.
 */
export const claudeOptions = (modelId: string) =>
  ({
    effort: "medium",
    cacheControl: { type: "ephemeral" },
    ...(SERVER_FALLBACK_MODELS.has(modelId) && {
      fallbacks: "default" as const,
    }),
  }) satisfies AnthropicLanguageModelOptions;

/** `AI_PROVIDER`, or `workers-ai` when it is unset or names no provider: only `mock` itself picks the mock. */
export const assistantProvider = (
  env: Pick<Env, "AI_PROVIDER">
): AssistantProvider => {
  const wanted: string = env.AI_PROVIDER;

  return PROVIDERS.find((p) => p === wanted) ?? "workers-ai";
};

/**
 * Whether this Worker has a model to ask: AI is on (`AI_FEATURES`, `app/lib/ai.ts`), and there is the dev model or a
 * real provider with its AI binding. What offers AI beside the Assistant's own page (Mail's summary and draft) asks
 * this first, and offers nothing without one.
 */
export const assistantReady = (env: Env): boolean =>
  aiEnabled(env) && (assistantProvider(env) === "mock" || Boolean(env.AI));

/**
 * The model the Assistant writes with, from `AI_PROVIDER`. The routes resolve it once per request and hand it to
 * `answerChat`, which runs whatever model it is given (the tests script theirs).
 *
 * - anthropic:   `AI_CHAT_MODEL`, a Claude model, through AI Gateway's provider-native endpoint on the Anthropic key
 *                stored on the gateway (`AI_GATEWAY_ID`), with `claudeOptions`.
 * - workers-ai:  a Workers AI model through the AI binding and the same gateway: `AI_CHAT_MODEL` when it names one
 *                (`@cf/…`), else Llama 3.3 70B, so a switch between the two needs only `AI_PROVIDER`.
 * - mock:        the dev model (./mock-model.server), for `pnpm run dev` without `wrangler login` and the smoke. It is
 *                imported only here, so a Worker on a real provider never loads it.
 *
 * A real provider without the AI binding throws: the Worker is misconfigured, and the mock never stands in for it.
 * Every call keeps the gateway's log off: it would hold the person's mail and files.
 */
export const assistantModel = async (env: Env): Promise<ChatModel> => {
  const provider = assistantProvider(env);

  if (provider === "mock") {
    const { mockModel } = await import("./mock-model.server");

    return mockModel();
  }

  if (!env.AI) {
    throw new Error(
      `The Assistant has no AI binding: AI_PROVIDER is ${provider}, which runs through it.`
    );
  }

  const ai = createAI({
    binding: env.AI,
    id: env.AI_GATEWAY_ID || "default",
    metadata: { app: "workspace" },
    collectLog: false,
  });

  const wanted: string = env.AI_CHAT_MODEL || "";

  if (provider === "anthropic") {
    // The gateway sends its stored key in place of this one, which never leaves the Worker.
    const anthropic = createAnthropic({ apiKey: "cloudflare" });

    const modelId = wanted.startsWith("claude-")
      ? wanted
      : DEFAULT_CLAUDE_MODEL;

    // AI Gateway takes over the vendor model's requests, so the middleware wraps the gateway's model.
    return wrapLanguageModel({
      model: ai(anthropic(modelId)),
      middleware: defaultSettingsMiddleware({
        settings: { providerOptions: { anthropic: claudeOptions(modelId) } },
      }),
    });
  }

  return ai.languageModel(
    wanted.startsWith("@cf/") ? wanted : DEFAULT_WORKERS_AI_MODEL
  );
};
