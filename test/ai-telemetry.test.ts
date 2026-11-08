import { embed, generateText, stepCountIs, streamText, tool } from "ai";
import type { LanguageModel } from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { aiCallOptions, createAiTelemetry } from "~/lib/ai-telemetry/telemetry";
import type { AiEvent, AiProperties } from "~/lib/ai-telemetry/telemetry";
import { stringOrNull } from "~/lib/guards";

import { stringContaining } from "./fixtures";

// What a customer writes, and a credential pasted into it.
const PROBLEM = "invoice INV-77341 was charged twice";
const EMAIL = "marieke.jansen@example.nl";

// A fake key, put together here so no scanner reads a whole key in the source.
const API_KEY = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz0123"].join(
  "-"
);

const ANSWER = "The second charge of INV-77341 is refunded.";
const SEARCH = "double charge refund";

/** The properties PostHog keeps for 30 days; the only ones that may carry anyone's words. */
const LARGE = new Set([
  "$ai_input",
  "$ai_output",
  "$ai_output_choices",
  "$ai_input_state",
  "$ai_output_state",
  "$ai_tools",
]);

const sent: AiEvent[] = [];
let text = false;

const telemetry = createAiTelemetry({
  capture: (event) => {
    sent.push(event);
  },
  text: () => text,
});

/** A call's telemetry options, sent to this test's integration alone. */
const options = (name: string, conversationId = "cv_1") => {
  const call = aiCallOptions(name, { conversationId });

  return {
    ...call,
    telemetry: { ...call.telemetry, integrations: [telemetry.integration] },
  };
};

const usage = {
  inputTokens: {
    total: 12,
    noCache: 12,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 8, text: 8, reasoning: undefined },
  raw: undefined,
};

const answer = (words: string) => ({
  content: [{ type: "text" as const, text: words }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});

/** A model that calls `lookup` with the customer's words once, then answers. */
const toolCallingModel = (): LanguageModel => {
  let calls = 0;

  return new MockLanguageModelV4({
    doGenerate: () => {
      calls += 1;

      return Promise.resolve(
        calls === 1
          ? {
              content: [
                {
                  type: "tool-call" as const,
                  toolCallId: "call_1",
                  toolName: "lookup",
                  input: JSON.stringify({ query: `${PROBLEM} for ${EMAIL}` }),
                },
              ],
              finishReason: { unified: "tool-calls" as const, raw: undefined },
              usage,
              warnings: [],
            }
          : answer(ANSWER)
      );
    },
  });
};

const embeddingModel = new MockEmbeddingModelV4({
  doEmbed: { embeddings: [[0.1, 0.2]], usage: { tokens: 3 }, warnings: [] },
});

/** A tool that searches the help center, which embeds the query first, as Supsys's `search_help_center` does. */
const lookup = tool({
  description: "Look up an invoice.",
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) => {
    await embed({
      model: embeddingModel,
      value: SEARCH,
      telemetry: {
        functionId: "kb-search",
        integrations: [telemetry.integration],
      },
    });

    return { found: query };
  },
});

const byEvent = (name: string) =>
  sent.flatMap((e) => (e.event === name ? [e.properties] : []));

const only = (name: string): AiProperties => {
  const [first, ...rest] = byEvent(name);

  if (!first || rest.length) {
    throw new Error(
      `Expected one ${name}, got ${rest.length + (first ? 1 : 0)}`
    );
  }

  return first;
};

const toolSpan = () => {
  const span = byEvent("$ai_span").find((p) => p.$ai_span_type === "tool");

  if (!span) {
    throw new Error("Expected a tool span");
  }

  return span;
};

/** Where in the events a text appears: the names of the properties that hold it. */
const holding = (needle: string) =>
  sent.flatMap((e) =>
    Object.entries(e.properties).flatMap(([key, value]) =>
      JSON.stringify(value)?.includes(needle) ? [key] : []
    )
  );

/** A property's value as text: a string as it is, anything else as JSON. */
const textOf = (value: AiProperties[string] | undefined): string =>
  stringOrNull(value) ?? JSON.stringify(value ?? null);

/** The tree of the events: each one's kind, name and the event it hangs under, by its place in `sent`. */
const tree = () => {
  const ids = new Map<unknown, string>();

  for (const e of sent) {
    const id =
      e.event === "$ai_trace"
        ? e.properties.$ai_trace_id
        : e.properties.$ai_span_id;

    ids.set(id, `${e.event}:${textOf(e.properties.$ai_span_name)}`);
  }

  return sent.map((e) => [
    `${e.event}:${textOf(e.properties.$ai_span_name)}`,
    ids.get(e.properties.$ai_parent_id) ?? null,
  ]);
};

/** A request's turn as Supsys's support agent takes it: Clef's triage, then the agent with its tool. */
const turn = () =>
  telemetry.withAiTrace(
    "agent_turn",
    { conversationId: "cv_4" },
    async () => {
      telemetry.captureAiCall(
        "triage",
        {},
        {
          provider: "workers-ai",
          model: "@cf/clef",
          startedAt: Date.now(),
          input: PROBLEM,
          output: "normal",
        }
      );

      const r = await generateText({
        model: toolCallingModel(),
        instructions: "You answer customers of RIVI.",
        prompt: `${EMAIL}: my ${PROBLEM}. My key is ${API_KEY}`,
        tools: { lookup },
        stopWhen: stepCountIs(2),
        ...options("agent", "cv_4"),
      });

      return r.text;
    },
    { input: PROBLEM, output: (r) => r }
  );

describe("PostHog AI telemetry", () => {
  beforeEach(() => {
    sent.length = 0;
    text = false;
  });

  describe("one call", () => {
    it("is a trace of its own, its tool under the generation that called it and the tool's search under the tool", async () => {
      await generateText({
        model: toolCallingModel(),
        prompt: `${EMAIL}: my ${PROBLEM}`,
        tools: { lookup },
        stopWhen: stepCountIs(2),
        ...options("agent"),
      });

      expect(tree()).toStrictEqual([
        ["$ai_generation:agent", "$ai_trace:agent"],
        ["$ai_embedding:kb-search", "$ai_span:lookup"],
        ["$ai_span:lookup", "$ai_generation:agent"],
        ["$ai_generation:agent", "$ai_trace:agent"],
        ["$ai_trace:agent", null],
      ]);
      expect(new Set(sent.map((e) => e.properties.$ai_trace_id)).size).toBe(1);
      expect(only("$ai_trace")).toMatchObject({ $ai_session_id: "cv_1" });
      // Anonymous under the conversation.
      expect(
        new Set(sent.map((e) => [e.distinctId, e.anonymousId].join(",")))
      ).toStrictEqual(new Set([",cv_1"]));
    });

    it("streams as one trace on the person, ended when the stream is", async () => {
      const model = new MockLanguageModelV4({
        doStream: () =>
          Promise.resolve({
            stream: new ReadableStream({
              start(controller) {
                for (const chunk of [
                  { type: "stream-start" as const, warnings: [] },
                  { type: "text-start" as const, id: "t" },
                  { type: "text-delta" as const, id: "t", delta: ANSWER },
                  { type: "text-end" as const, id: "t" },
                  {
                    type: "finish" as const,
                    finishReason: { unified: "stop" as const, raw: undefined },
                    usage,
                  },
                ]) {
                  controller.enqueue(chunk);
                }

                controller.close();
              },
            }),
          }),
      });

      text = true;

      const call = aiCallOptions("assistant", {
        conversationId: "ac_1",
        distinctId: "user_1",
      });

      const result = streamText({
        model,
        prompt: PROBLEM,
        ...call,
        telemetry: { ...call.telemetry, integrations: [telemetry.integration] },
      });

      await expect(result.text).resolves.toBe(ANSWER);
      await result.consumeStream();

      expect(tree()).toStrictEqual([
        ["$ai_generation:assistant", "$ai_trace:assistant"],
        ["$ai_trace:assistant", null],
      ]);
      expect(only("$ai_trace")).toMatchObject({
        $ai_session_id: "ac_1",
        $ai_input_state: PROBLEM,
        $ai_output_state: ANSWER,
      });
      expect(new Set(sent.map((e) => e.distinctId))).toStrictEqual(
        new Set(["user_1"])
      );
    });
  });

  describe("withAiTrace", () => {
    it("makes a request's calls one trace, each a span under its root", async () => {
      await expect(turn()).resolves.toBe(ANSWER);

      expect(tree()).toStrictEqual([
        ["$ai_generation:triage", "$ai_trace:agent_turn"],
        ["$ai_generation:agent", "$ai_span:agent"],
        ["$ai_embedding:kb-search", "$ai_span:lookup"],
        ["$ai_span:lookup", "$ai_generation:agent"],
        ["$ai_generation:agent", "$ai_span:agent"],
        ["$ai_span:agent", "$ai_trace:agent_turn"],
        ["$ai_trace:agent_turn", null],
      ]);
      expect(new Set(sent.map((e) => e.properties.$ai_trace_id)).size).toBe(1);
      // Every event names the request's trace, so an event read on its own names its trace too.
      expect(
        new Set(
          sent.map(
            (e) =>
              `${textOf(e.properties.$ai_session_id)},${textOf(e.properties.$ai_trace_name)}`
          )
        )
      ).toStrictEqual(new Set(["cv_4,agent_turn"]));
    });

    it("is a span inside another, and leaves nothing behind when no AI call ran", async () => {
      await telemetry.withAiTrace("ticket_change", {}, async () => {
        await telemetry.withAiTrace("nothing", {}, () => Promise.resolve());

        await telemetry.withAiTrace("brief", {}, () =>
          generateText({
            model: new MockLanguageModelV4({ doGenerate: answer("A brief.") }),
            prompt: PROBLEM,
            ...options("ticket_brief"),
          })
        );
      });

      expect(tree()).toStrictEqual([
        ["$ai_generation:ticket_brief", "$ai_span:ticket_brief"],
        ["$ai_span:ticket_brief", "$ai_span:brief"],
        ["$ai_span:brief", "$ai_trace:ticket_change"],
        ["$ai_trace:ticket_change", null],
      ]);
    });

    it("ends a failed request's trace with the error's name, and throws it again", async () => {
      await expect(
        telemetry.withAiTrace("agent_turn", {}, async () => {
          await generateText({
            model: new MockLanguageModelV4({ doGenerate: answer("en") }),
            prompt: PROBLEM,
            ...options("language"),
          });

          throw new TypeError(`No contact for ${EMAIL}`);
        })
      ).rejects.toThrow(EMAIL);

      expect(only("$ai_trace")).toMatchObject({
        $ai_is_error: true,
        $ai_error: "TypeError",
      });
      expect(holding(EMAIL)).toStrictEqual([]);
    });
  });

  describe("captureAiCall", () => {
    const call = {
      provider: "workers-ai",
      model: "@cf/clef",
      startedAt: Date.now(),
      input: PROBLEM,
      output: "urgent",
    };

    it("is a trace of its own outside any scope", () => {
      telemetry.captureAiCall("triage", { conversationId: "cv_3" }, call);

      expect(tree()).toStrictEqual([
        ["$ai_generation:triage", "$ai_trace:triage"],
        ["$ai_trace:triage", null],
      ]);
      expect(holding(PROBLEM)).toStrictEqual([]);
    });
  });

  describe("text", () => {
    it("leaves without a word of the conversation while the switch is off", async () => {
      await turn();

      const words = [PROBLEM, EMAIL, ANSWER, SEARCH, "RIVI", API_KEY];

      expect(words.flatMap(holding)).toStrictEqual([]);
      expect(
        sent.flatMap((e) =>
          Object.keys(e.properties).filter(
            (key) => LARGE.has(key) && key !== "$ai_tools"
          )
        )
      ).toStrictEqual([]);
    });

    it("carries the conversation where it is on, only in the properties PostHog keeps for 30 days", async () => {
      text = true;
      await turn();

      const words = [PROBLEM, EMAIL, ANSWER, SEARCH];

      expect(words.map((w) => holding(w).length > 0)).toStrictEqual(
        words.map(() => true)
      );
      expect(
        words.flatMap(holding).filter((key) => !LARGE.has(key))
      ).toStrictEqual([]);
      // Credentials are masked before anything leaves.
      expect(holding(API_KEY)).toStrictEqual([]);
      expect(holding("[redacted]")).not.toHaveLength(0);
    });

    it("shows each step's prompt and answer, the tool's arguments and result, and the request's question and answer", async () => {
      text = true;
      await turn();

      const [asked, answered] = byEvent("$ai_generation").filter(
        (p) => p.$ai_span_name === "agent"
      );

      expect([asked.$ai_input, asked.$ai_output_choices]).toMatchObject([
        [
          { role: "system", content: "You answer customers of RIVI." },
          { role: "user", content: stringContaining(PROBLEM) },
        ],
        [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "lookup" } },
            ],
          },
        ],
      ]);
      // The second step's prompt carries the tool's call and its result.
      expect([answered.$ai_input, answered.$ai_output_choices]).toMatchObject([
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            tool_call_id: "call_1",
            name: "lookup",
          }),
        ]),
        [{ role: "assistant", content: ANSWER }],
      ]);
      expect([
        toolSpan().$ai_input_state,
        toolSpan().$ai_output_state,
      ]).toStrictEqual([
        JSON.stringify({ query: `${PROBLEM} for ${EMAIL}` }),
        JSON.stringify({ found: `${PROBLEM} for ${EMAIL}` }),
      ]);
      expect(only("$ai_embedding").$ai_input).toBe(SEARCH);
      expect(only("$ai_trace")).toMatchObject({
        $ai_input_state: PROBLEM,
        $ai_output_state: ANSWER,
      });
    });

    it("names a failure without its message, whatever the switch says", async () => {
      text = true;

      await expect(
        generateText({
          model: new MockLanguageModelV4({
            doGenerate: () =>
              Promise.reject(new Error(`The model refused to read ${EMAIL}`)),
          }),
          prompt: "Hello",
          maxRetries: 0,
          ...options("suggest"),
        })
      ).rejects.toThrow(EMAIL);

      expect(sent.map((e) => [e.event, e.properties.$ai_error])).toStrictEqual([
        ["$ai_generation", "Error"],
        ["$ai_trace", "Error"],
      ]);
      expect(holding(EMAIL)).toStrictEqual([]);
    });
  });
});
