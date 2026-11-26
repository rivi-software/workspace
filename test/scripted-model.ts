import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import type { Json } from "~/lib/assistant/assistant";

/** What a model's `doStream` answers, and the parts its stream carries (the provider's types, through the mock's). */
type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;

type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/**
 * One step of a scripted model:
 *
 * - `text`: it writes the text and stops. With `open`, its stream stays open after the text until the call is
 *   aborted, as a provider's response is cut off when the request goes away.
 * - `tool`: it calls the tool with the input and waits for the result, which the next step's prompt carries.
 * - `error`: the call fails, as a provider that answers with an error. With `midway`, its stream opens first and
 *   then breaks, as a provider's does when it fails after its response began, having written `text` first if given.
 * - `declined`: it ends the turn without a word, as a model whose safety classifier declines the question.
 *
 * A text or tool step with `thinking` thinks that first, as a Claude model does: a part of the provider's own (as
 * Anthropic notes each response's id and usage), then a reasoning part with the provider's signature on it, which the
 * model must get back between the steps of a turn.
 */
export type ScriptedStep =
  | { text: string; open?: true; thinking?: string }
  | { tool: string; input: { [key: string]: Json }; thinking?: string }
  | { error: Error; midway?: true; text?: string }
  | { declined: true };

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

/** A step's thinking as a provider streams it, signed as Anthropic signs a thinking block. */
const thinkingParts = (
  id: string,
  thinking: string | undefined
): StreamPart[] =>
  thinking
    ? [
        {
          type: "custom",
          kind: "test.message_start",
          providerMetadata: { test: { id: `msg_${id}` } },
        },
        { type: "reasoning-start", id: `${id}_thinking` },
        { type: "reasoning-delta", id: `${id}_thinking`, delta: thinking },
        {
          type: "reasoning-end",
          id: `${id}_thinking`,
          providerMetadata: { test: { signature: `signed ${thinking}` } },
        },
      ]
    : [];

const textParts = (
  id: string,
  text: string,
  thinking?: string
): StreamPart[] => [
  { type: "stream-start", warnings: [] },
  ...thinkingParts(id, thinking),
  { type: "text-start", id },
  { type: "text-delta", id, delta: text },
  { type: "text-end", id },
];

const finish = (
  unified: "stop" | "tool-calls" | "content-filter"
): StreamPart => ({
  type: "finish",
  finishReason: { unified, raw: undefined },
  usage,
});

/** A stream that writes `parts` and then waits for the call's abort, which errors it as a cut-off response does. */
const openStream = (parts: StreamPart[], signal: AbortSignal | undefined) =>
  new ReadableStream<StreamPart>({
    start: (controller) => {
      for (const part of parts) {
        controller.enqueue(part);
      }

      signal?.addEventListener("abort", () => controller.error(signal.reason), {
        once: true,
      });
    },
  });

/**
 * A model that answers its calls with the steps given, one per call, in order, so a test says what the model does
 * rather than phrasing a question for the dev model. A call past the last step fails the test's turn. Its
 * `doStreamCalls` hold every call's options: the prompt each step saw, the abort signal.
 */
export const scriptedModel = (
  steps: readonly ScriptedStep[],
  modelId = "scripted"
) => {
  let calls = 0;

  return new MockLanguageModelV4({
    provider: "test",
    modelId,
    doStream: (options) => {
      const step = steps[calls];
      calls += 1;
      const id = `call_${calls}`;

      if (!step) {
        return Promise.reject(
          new Error(`The script has no step ${calls} (${steps.length} given).`)
        );
      }

      if ("error" in step) {
        return step.midway
          ? Promise.resolve({
              stream: simulateReadableStream<StreamPart>({
                chunks: [
                  { type: "stream-start", warnings: [] },
                  ...(step.text
                    ? [
                        { type: "text-start", id } as const,
                        { type: "text-delta", id, delta: step.text } as const,
                      ]
                    : []),
                  { type: "error", error: step.error },
                ],
              }),
            })
          : Promise.reject(step.error);
      }

      if ("declined" in step) {
        return Promise.resolve({
          stream: simulateReadableStream<StreamPart>({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "custom",
                kind: "test.message_start",
                providerMetadata: { test: { id: `msg_${id}` } },
              },
              finish("content-filter"),
            ],
          }),
        });
      }

      if ("tool" in step) {
        const input = JSON.stringify(step.input);

        return Promise.resolve({
          stream: simulateReadableStream<StreamPart>({
            chunks: [
              { type: "stream-start", warnings: [] },
              ...thinkingParts(id, step.thinking),
              { type: "tool-input-start", id, toolName: step.tool },
              { type: "tool-input-delta", id, delta: input },
              { type: "tool-input-end", id },
              { type: "tool-call", toolCallId: id, toolName: step.tool, input },
              finish("tool-calls"),
            ],
          }),
        });
      }

      if (step.open) {
        return Promise.resolve({
          stream: openStream(textParts(id, step.text), options.abortSignal),
        });
      }

      return Promise.resolve({
        stream: simulateReadableStream<StreamPart>({
          chunks: [...textParts(id, step.text, step.thinking), finish("stop")],
        }),
      });
    },
  });
};
