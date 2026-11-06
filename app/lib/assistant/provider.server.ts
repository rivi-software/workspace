import { createAnthropic } from "@ai-sdk/anthropic";
import { createAI } from "agents/models/ai-sdk";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";

import { registerAssistantTelemetry } from "./telemetry.server";

export type AssistantProvider = "mock" | "workers-ai" | "anthropic";

export interface AssistantModel {
  provider: AssistantProvider;
  model: LanguageModel;
  /** A short name of the model, kept on each answer. */
  modelId: string;
}

const PROVIDERS = [
  "mock",
  "workers-ai",
  "anthropic",
] as const satisfies readonly AssistantProvider[];

/** `AI_PROVIDER`, or `mock` when it is unset or the AI binding is missing. */
export const assistantProvider = (env: Env): AssistantProvider => {
  const wanted = env.AI_PROVIDER || "mock";
  const provider = PROVIDERS.find((p) => p === wanted) ?? "workers-ai";

  return env.AI ? provider : "mock";
};

// ---------- the mock ----------

type Plan =
  | { tool: string; input: Record<string, string | string[]> }
  | { text: string };

interface PromptMessage {
  role: string;
  content: unknown;
}

let calls = 0;

/** The text parts of a user message's content. */
const textPartsSchema = z.array(
  z.object({ text: z.string().optional() }).loose()
);

const lastUserText = (msgs: readonly PromptMessage[]): string => {
  for (const m of msgs.toReversed()) {
    if (m.role !== "user") {
      continue;
    }

    const text = z.string().safeParse(m.content);

    if (text.success) {
      return text.data;
    }

    const parts = textPartsSchema.safeParse(m.content);

    if (parts.success) {
      return parts.data.map((c) => c.text ?? "").join(" ");
    }
  }

  return "";
};

/** One tool's answer in a tool step's content. */
const toolResultSchema = z.object({
  type: z.literal("tool-result"),
  toolName: z.string(),
  output: z
    .object({ type: z.string().optional(), value: z.unknown().optional() })
    .optional(),
});

/** What the tools answered in the last step, read back in a sentence, so a test sees the tool's output arrive. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the AI SDK types a tool step's content loosely; zod reads it here
const toolSummary = (content: unknown): string => {
  const parts = z.array(z.unknown()).catch([]).parse(content);

  const said = parts.flatMap((part) => {
    const result = toolResultSchema.safeParse(part);

    if (!result.success) {
      return [];
    }

    const { toolName, output } = result.data;

    const value =
      output?.type === "text"
        ? String(output.value)
        : JSON.stringify(output?.value ?? null);

    return [`${toolName} answered: ${value.slice(0, 1200)}`];
  });

  return `(mock) ${said.join("\n") || "The tool answered nothing."}`;
};

const trimEnd = (s: string) => s.trim().replace(/[.?!]+$/u, "");

/**
 * What the mock does with a prompt: after a tool step it tells what the tool answered; a question in one of a few
 * phrasings calls the matching tool; anything else is echoed.
 */
const plan = (msgs: readonly PromptMessage[]): Plan => {
  const last = msgs.at(-1);

  if (last?.role === "tool") {
    return { text: toolSummary(last.content) };
  }

  const user = lastUserText(msgs);
  let m: RegExpMatchArray | null;

  if ((m = user.match(/search (?:my )?mail for (?<query>.+)/iu))) {
    return { tool: "search_mail", input: { query: trimEnd(m[1]) } };
  }

  if (
    (m = user.match(
      /(?:find|search) (?:my )?(?:files?|drive) (?:for|named|called) (?<query>.+)/iu
    ))
  ) {
    return { tool: "search_drive", input: { query: trimEnd(m[1]) } };
  }

  if (
    (m = user.match(
      /read (?:the )?conversation (?<conversationId>th_[a-z0-9]+)/iu
    ))
  ) {
    return { tool: "read_conversation", input: { conversationId: m[1] } };
  }

  if ((m = user.match(/read (?:the )?file (?<fileId>dn_[a-z0-9]+)/iu))) {
    return { tool: "read_file", input: { fileId: m[1] } };
  }

  if (
    (m = user.match(
      /draft a reply to (?<replyTo>th_[a-z0-9]+) saying (?<body>.+)/iu
    ))
  ) {
    return {
      tool: "create_draft",
      input: { replyTo: m[1], body: m[2].trim() },
    };
  }

  if (
    (m = user.match(
      /draft (?:a message|an email|a mail|mail) to (?<to>\S+?) (?:about|saying) (?<text>.+)/iu
    ))
  ) {
    return {
      tool: "create_draft",
      input: {
        to: [m[1]],
        subject: trimEnd(m[2]).slice(0, 60),
        body: m[2].trim(),
      },
    };
  }

  return { text: `(mock) I received: ${user.slice(0, 200)}` };
};

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
  raw: undefined,
};

const mockModel = (): LanguageModel => {
  const model = new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock",
    doGenerate: (options) => {
      const p = plan(options.prompt);
      calls += 1;
      const id = `call_${calls}`;

      // SAFETY: the mock's result is shaped as the AI SDK reads it, which its loose mock typings cannot express
      return Promise.resolve({
        content:
          "tool" in p
            ? [
                {
                  type: "tool-call",
                  toolCallId: id,
                  toolName: p.tool,
                  input: JSON.stringify(p.input),
                },
              ]
            : [{ type: "text", text: p.text }],
        finishReason: {
          unified: "tool" in p ? "tool-calls" : "stop",
          raw: undefined,
        },
        usage,
        warnings: [],
      } as never);
    },
    doStream: (options) => {
      const p = plan(options.prompt);
      calls += 1;
      const id = `call_${calls}`;

      const chunks =
        "tool" in p
          ? [
              { type: "stream-start", warnings: [] },
              { type: "tool-input-start", id, toolName: p.tool },
              { type: "tool-input-delta", id, delta: JSON.stringify(p.input) },
              { type: "tool-input-end", id },
              {
                type: "tool-call",
                toolCallId: id,
                toolName: p.tool,
                input: JSON.stringify(p.input),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage,
              },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id },
              { type: "text-delta", id, delta: p.text },
              { type: "text-end", id },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                usage,
              },
            ];

      // SAFETY: the mock's stream is shaped as the AI SDK reads it, which its loose mock typings cannot express
      return Promise.resolve({
        stream: simulateReadableStream({ chunks }),
      } as never);
    },
  });

  return model;
};

/**
 * The model the Assistant writes with, from `AI_PROVIDER`:
 *
 * - mock:        a deterministic in-process model (the tests, local dev without `wrangler login`) that calls the
 *                tools on a few well-known phrasings and otherwise echoes the question.
 * - workers-ai:  `AI_CHAT_MODEL` on Workers AI through the AI binding and AI Gateway (`AI_GATEWAY_ID`).
 * - anthropic:   a Claude model through the gateway's provider-native endpoint; the gateway holds the key.
 *
 * Every call keeps the gateway's log off: it would hold the person's mail and files. Every call is reported to PostHog
 * AI observability (./telemetry.server), with its prompt and answer where `AI_TEXT_ANALYTICS` is `on`.
 */
export const assistantModel = (env: Env): AssistantModel => {
  registerAssistantTelemetry(env);
  const provider = assistantProvider(env);

  if (provider === "mock") {
    return { provider, model: mockModel(), modelId: "mock" };
  }

  const ai = createAI({
    binding: env.AI,
    id: env.AI_GATEWAY_ID || "default",
    metadata: { app: "workspace" },
    collectLog: false,
  });

  const wanted = env.AI_CHAT_MODEL || "";

  if (provider === "anthropic") {
    const anthropic = createAnthropic({ apiKey: "cloudflare" });
    const modelId = wanted.startsWith("claude") ? wanted : "claude-sonnet-5-5";

    return {
      provider,
      model: ai(anthropic(modelId)),
      modelId,
    };
  }

  const modelId = wanted || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

  return {
    provider,
    model: ai.languageModel(modelId),
    modelId,
  };
};
