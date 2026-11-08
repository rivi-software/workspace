import { AsyncLocalStorage } from "node:async_hooks";

import type { ModelMessage, Telemetry } from "ai";
import { z } from "zod";

import {
  answerText,
  bounded,
  boundedJson,
  chatInput,
  chatOutput,
  latestQuestion,
} from "./text";
import type { AnswerPart, ChatMessage } from "./text";

/**
 * What a run passes so PostHog can group its events: `conversationId` becomes the AI session (`$ai_session_id`) and
 * names an anonymous run, `distinctId` the person when a signed-in person acts.
 */
export interface AiRunContext {
  conversationId?: string | null;
  distinctId?: string;
}

/** A property's value as PostHog takes it: JSON. */
export type AiValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly AiValue[]
  | { readonly [key: string]: AiValue };

/** An event's properties. */
export type AiProperties = Record<string, AiValue>;

/** One event for PostHog: on the person when `distinctId` is set, else anonymous under `anonymousId`. */
export interface AiEvent {
  event: string;
  properties: AiProperties;
  distinctId?: string;
  anonymousId: string;
}

export interface AiTelemetryOptions {
  /** Sends one event; it must not throw. */
  capture: (event: AiEvent) => void;
  /** Whether a run's events carry what was asked and answered, read when the run starts. */
  text: () => boolean;
}

/** What a non-SDK model call reports (`captureAiCall`), such as a decision on the AI binding. */
export interface AiCall {
  provider: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  startedAt: number;
  error?: unknown;
  /** What the call was asked, sent only where the text leaves. */
  input?: string;
  /** What it answered, sent only where the text leaves. */
  output?: string;
}

/** What a trace says of its work where the text leaves: the question and the answer. */
export interface AiTraceText<T> {
  input?: string;
  output?: (result: T) => string | undefined;
}

/** The trace a piece of work runs in, carried through its awaits. */
interface Scope {
  traceId: string;
  /** The name PostHog lists the trace by (`$ai_trace_name`): its root's, on every event of it. */
  traceName: string;
  /** The span new events hang under: the trace's root, a run's span or a tool's. */
  parentId: string;
  context: AiRunContext;
  text: boolean;
  /** How many events the scope's work sent: a scope that sent none leaves no root or span behind. */
  sent: { count: number };
}

const scopes = new AsyncLocalStorage<Scope>();

/** One AI SDK call (`generateText`, `streamText`, `embed`…), from its start to its end. */
interface Run {
  traceId: string;
  traceName: string;
  /** The run's own id: its trace's when it is the root, else its span's. */
  spanId: string;
  /** The span a nested run hangs under; none for a root. */
  parentId: string | undefined;
  name: string;
  startedAt: number;
  context: AiRunContext;
  text: boolean;
  sent: { count: number };
  /** The person's latest message, what the run's trace or span shows it was asked. */
  question?: string;
  /** The last generation's words, what it shows it answered. */
  answer?: string;
  /** The model call in flight, so a failure can still be reported as a generation. */
  call?: {
    spanId: string;
    startedAt: number;
    provider: string;
    model: string;
    tools: AiValue;
    input?: ChatMessage[];
  };
  /** The generation whose answer asked for the tools that run next. */
  lastGenerationId?: string;
  /** The tool calls in flight, by the model's tool call id. */
  tools: Map<string, { spanId: string; parentId: string }>;
}

const seconds = (ms: number) => ms / 1000;

/**
 * An error's name (`AI_APICallError`, `TimeoutError`), never its message: a provider's error can quote the prompt, and
 * an ordinary property outlives the 30 days PostHog keeps the text for.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the AI SDK hands over whatever was thrown; only its class name is read, never its content
const errorName = (error: unknown) =>
  error instanceof Error ? error.name : "UnknownError";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever was thrown goes to `errorName`, which reads its class name only
const failure = (error: unknown) => ({
  $ai_is_error: true,
  $ai_error: errorName(error),
});

/** The run context the app passed the call (`aiCallOptions`), as far as it holds one. */
const RunContext = z
  .object({
    conversationId: z.string().min(1).nullish().catch(undefined),
    distinctId: z.string().min(1).optional().catch(undefined),
  })
  .catch({});

/** A run context without its empty keys, so it never hides the one of the scope it runs in. */
const ownContext = ({
  conversationId,
  distinctId,
}: AiRunContext): AiRunContext => ({
  ...(conversationId ? { conversationId } : undefined),
  ...(distinctId ? { distinctId } : undefined),
});

/** What a run's trace or span says it was asked and answered, where its text leaves. */
const states = (text: boolean, question?: string, answer?: string) =>
  text
    ? {
        ...(question === undefined
          ? undefined
          : { $ai_input_state: bounded(question) }),
        ...(answer === undefined
          ? undefined
          : { $ai_output_state: bounded(answer) }),
      }
    : {};

/** What a run's start says it was asked: a text operation's prompt, or the value an embedding embeds. */
type Prompt = Partial<{ messages: ModelMessage[]; value: string | string[] }>;

/** The question a run's trace or span shows: what an embedding embeds, or the person's latest message. */
const questionOf = ({ messages, value }: Prompt): string | undefined => {
  if (value !== undefined) {
    return [value].flat().join("\n");
  }

  return messages ? latestQuestion(messages) : undefined;
};

/**
 * The AI SDK telemetry options of a call under its name, so its events carry the run's context:
 *
 *   generateText({ model, prompt, ...aiCallOptions("summary", { conversationId }) })
 */
export const aiCallOptions = (
  functionId: string,
  context: AiRunContext = {}
) => ({
  runtimeContext: { ...context },
  telemetry: {
    functionId,
    includeRuntimeContext: { conversationId: true, distinctId: true },
  },
});

/**
 * PostHog AI observability for the AI SDK: `$ai_trace`, `$ai_generation`, `$ai_span` and `$ai_embedding` events from
 * the SDK's lifecycle (`registerTelemetry(telemetry.integration)`), and the scopes that make them one trace.
 *
 * - A call outside any scope is a trace of its own: its generations under the root, each tool's span under the
 *   generation that asked for it, and the root (`$ai_trace`) when it ends.
 * - A call inside `withAiTrace`, or inside a tool's `execute` (`executeTool`), joins that trace as a span under where
 *   it ran, with its generations and tools under it. A help-center search inside an agent's tool is a child of that
 *   tool, and a triage before the agent a sibling of it in the request's trace.
 *
 * What leaves without the text: the provider and model, tokens, latency, the stop reason, the tools offered (code,
 * not anyone's words), the tools called, and an error's name. Where `text()` is true, a run also carries what it was
 * asked and answered, masked and bounded (`./text`), and only in the properties PostHog keeps for 30 days
 * (`$ai_input`, `$ai_output_choices`, `$ai_input_state`, `$ai_output_state`): a generation its prompt and answer, a
 * tool its arguments and result, a trace or span the person's question and the answer, an embedding its text.
 */
export const createAiTelemetry = (options: AiTelemetryOptions) => {
  const runs = new Map<string, Run>();

  const send = (
    at: Pick<Scope, "traceId" | "traceName" | "context" | "sent">,
    event: string,
    properties: AiProperties
  ) => {
    at.sent.count += 1;
    options.capture({
      event,
      distinctId: at.context.distinctId,
      // Without a person the events are anonymous, under the conversation, which points at nothing once it is erased.
      anonymousId: at.context.conversationId ?? at.traceId,
      properties: {
        $ai_trace_id: at.traceId,
        // PostHog lists a trace by the name its events carry, which the root, sent last, may not win on its own.
        $ai_trace_name: at.traceName,
        $ai_session_id: at.context.conversationId ?? null,
        ...properties,
      },
    });
  };

  /** Ends a run or a scope: the root of its trace, or its span in the trace it joined. */
  const close = (
    at: Pick<Scope, "traceId" | "traceName" | "context" | "sent">,
    end: {
      spanId: string;
      parentId: string | undefined;
      name: string;
      startedAt: number;
      extra: AiProperties;
    }
  ) => {
    if (end.parentId === undefined) {
      send(at, "$ai_trace", {
        $ai_span_name: end.name,
        $ai_latency: seconds(Date.now() - end.startedAt),
        ...end.extra,
      });

      return;
    }

    send(at, "$ai_span", {
      $ai_span_id: end.spanId,
      $ai_parent_id: end.parentId,
      $ai_span_name: end.name,
      $ai_latency: seconds(Date.now() - end.startedAt),
      ...end.extra,
    });
  };

  const closeRun = (run: Run, extra: AiProperties = {}) =>
    close(run, {
      spanId: run.spanId,
      parentId: run.parentId,
      name: run.name,
      startedAt: run.startedAt,
      extra: { ...states(run.text, run.question, run.answer), ...extra },
    });

  const generation = (
    run: Run,
    call: NonNullable<Run["call"]>,
    properties: AiProperties
  ) =>
    send(run, "$ai_generation", {
      $ai_span_id: call.spanId,
      $ai_parent_id: run.spanId,
      $ai_span_name: run.name,
      $ai_provider: call.provider,
      $ai_model: call.model,
      // The tool definitions are code (names, descriptions, input schemas), not anyone's words.
      ...(call.tools === undefined ? undefined : { $ai_tools: call.tools }),
      ...(call.input ? { $ai_input: call.input } : undefined),
      ...properties,
    });

  const integration: Telemetry = {
    onStart(event) {
      const scope = scopes.getStore();
      const embedding = event.operationId.startsWith("ai.embed");

      const own =
        "runtimeContext" in event
          ? ownContext(RunContext.parse(event.runtimeContext ?? {}))
          : {};

      const traceId = scope?.traceId ?? crypto.randomUUID();
      const text = scope?.text ?? options.text();

      // SAFETY: a text operation's start event carries the standardized prompt, an embedding's the value it embeds.
      const prompt = event as Prompt;

      const name =
        event.functionId ?? (embedding ? "embed" : event.operationId);

      runs.set(event.callId, {
        traceId,
        traceName: scope?.traceName ?? name,
        spanId: scope ? crypto.randomUUID() : traceId,
        parentId: scope?.parentId,
        name,
        startedAt: Date.now(),
        context: { ...scope?.context, ...own },
        text,
        sent: scope?.sent ?? { count: 0 },
        question: text ? questionOf(prompt) : undefined,
        tools: new Map(),
      });
    },

    onLanguageModelCallStart(event) {
      const run = runs.get(event.callId);

      if (!run) {
        return;
      }

      run.call = {
        spanId: crypto.randomUUID(),
        startedAt: Date.now(),
        provider: event.provider,
        model: event.modelId,
        // SAFETY: the tool definitions the AI SDK hands over are JSON: names, descriptions and JSON schemas.
        tools: event.tools as AiValue,
        input: run.text
          ? chatInput(event.instructions, event.messages)
          : undefined,
      };
    },

    onLanguageModelCallEnd(event) {
      const run = runs.get(event.callId);

      if (!run?.call) {
        return;
      }

      const { usage, performance } = event;
      // SAFETY: the content of a model call's end is the AI SDK's content parts, which `AnswerPart` covers loosely.
      const content = event.content as readonly AnswerPart[];
      const words = answerText(content);

      generation(run, run.call, {
        $ai_input_tokens: usage.inputTokens,
        $ai_output_tokens: usage.outputTokens,
        $ai_cache_read_input_tokens: usage.inputTokenDetails.cacheReadTokens,
        $ai_cache_creation_input_tokens:
          usage.inputTokenDetails.cacheWriteTokens,
        $ai_reasoning_tokens: usage.outputTokenDetails.reasoningTokens,
        $ai_latency: seconds(performance.responseTimeMs),
        ...(performance.timeToFirstOutputMs === undefined
          ? undefined
          : {
              $ai_time_to_first_token: seconds(performance.timeToFirstOutputMs),
            }),
        $ai_stop_reason: event.finishReason,
        ...(run.text ? { $ai_output_choices: chatOutput(content) } : undefined),
      });

      run.lastGenerationId = run.call.spanId;

      if (words) {
        run.answer = words;
      }

      run.call = undefined;
    },

    onToolExecutionStart(event) {
      const run = runs.get(event.callId);

      run?.tools.set(event.toolCall.toolCallId, {
        spanId: crypto.randomUUID(),
        // Under the generation whose answer asked for the call.
        parentId: run.lastGenerationId ?? run.spanId,
      });
    },

    // A call the tool makes (a search's embedding, a model call) runs in the tool's scope, so it joins the trace
    // under the tool's span.
    executeTool({ callId, toolCallId, execute }) {
      const run = runs.get(callId);
      const tool = run?.tools.get(toolCallId);

      if (!run || !tool) {
        return execute();
      }

      return scopes.run(
        {
          traceId: run.traceId,
          traceName: run.traceName,
          parentId: tool.spanId,
          context: run.context,
          text: run.text,
          sent: run.sent,
        },
        execute
      );
    },

    onToolExecutionEnd(event) {
      const run = runs.get(event.callId);
      const tool = run?.tools.get(event.toolCall.toolCallId);

      if (!run || !tool) {
        return;
      }

      run.tools.delete(event.toolCall.toolCallId);

      const failed = event.toolOutput.type === "tool-error";

      send(run, "$ai_span", {
        $ai_span_id: tool.spanId,
        $ai_parent_id: tool.parentId,
        $ai_span_name: event.toolCall.toolName,
        $ai_span_type: "tool",
        $ai_latency: seconds(event.toolExecutionMs),
        ...(run.text
          ? {
              $ai_input_state: boundedJson(event.toolCall.input),
              ...(event.toolOutput.type === "tool-result"
                ? { $ai_output_state: boundedJson(event.toolOutput.output) }
                : undefined),
            }
          : undefined),
        ...(failed
          ? failure(
              event.toolOutput.type === "tool-error"
                ? event.toolOutput.error
                : undefined
            )
          : undefined),
      });
    },

    onEnd(event) {
      const run = runs.get(event.callId);

      if (!run) {
        return;
      }

      runs.delete(event.callId);

      if ("embedding" in event) {
        send(run, "$ai_embedding", {
          $ai_span_id:
            run.parentId === undefined ? crypto.randomUUID() : run.spanId,
          ...(run.parentId === undefined
            ? undefined
            : { $ai_parent_id: run.parentId }),
          $ai_span_name: run.name,
          $ai_provider: event.provider,
          $ai_model: event.modelId,
          $ai_input_tokens: event.usage.tokens,
          $ai_latency: seconds(Date.now() - run.startedAt),
          ...(run.text && run.question !== undefined
            ? { $ai_input: bounded(run.question) }
            : undefined),
        });

        return;
      }

      closeRun(run);
    },

    onError(event) {
      // SAFETY: the AI SDK's error event carries these optional fields.
      const { callId, error } = event as { callId?: string; error?: unknown };
      const run = callId ? runs.get(callId) : undefined;

      if (!run || !callId) {
        return;
      }

      runs.delete(callId);

      if (run.call) {
        generation(run, run.call, {
          $ai_latency: seconds(Date.now() - run.call.startedAt),
          ...failure(error),
        });
      }

      closeRun(run, failure(error));
    },

    onAbort(event) {
      const run = runs.get(event.callId);

      if (!run) {
        return;
      }

      runs.delete(event.callId);
      // A page that went away ends the stream: the trace ends there, without an error of its own.
      closeRun(run, { aborted: true });
    },
  };

  /**
   * Runs `work` as one trace (or, inside another, as a span of it): every AI call it makes, its tools and their calls
   * join it, and its root says how long the whole took, whether it failed and, where the text leaves, the question
   * and the answer. Work that made no AI call leaves nothing behind.
   */
  const withAiTrace = async <T>(
    name: string,
    context: AiRunContext,
    work: () => Promise<T>,
    describe: AiTraceText<T> = {}
  ): Promise<T> => {
    const outer = scopes.getStore();
    const traceId = outer?.traceId ?? crypto.randomUUID();
    const spanId = outer ? crypto.randomUUID() : traceId;
    const text = outer?.text ?? options.text();

    const scope: Scope = {
      traceId,
      traceName: outer?.traceName ?? name,
      parentId: spanId,
      context: { ...outer?.context, ...context },
      text,
      sent: { count: 0 },
    };

    const startedAt = Date.now();

    const end = (extra: AiProperties) => {
      if (scope.sent.count === 0) {
        return;
      }

      close(
        { ...scope, sent: outer?.sent ?? scope.sent },
        { spanId, parentId: outer?.parentId, name, startedAt, extra }
      );
    };

    let result: T;

    try {
      result = await scopes.run(scope, work);
    } catch (error) {
      end({ ...states(text, describe.input), ...failure(error) });
      throw error;
    }

    end(states(text, describe.input, describe.output?.(result)));

    return result;
  };

  /**
   * Reports a model call made outside the AI SDK (a decision on the AI binding) the way the SDK's calls are reported:
   * a generation in the trace it ran in, or a trace of its own with that one generation.
   */
  const captureAiCall = (name: string, context: AiRunContext, call: AiCall) => {
    const scope = scopes.getStore();
    const text = scope?.text ?? options.text();
    const traceId = scope?.traceId ?? crypto.randomUUID();

    const at = {
      traceId,
      traceName: scope?.traceName ?? name,
      context: { ...scope?.context, ...context },
      sent: scope?.sent ?? { count: 0 },
    };

    const error = call.error === undefined ? undefined : failure(call.error);

    send(at, "$ai_generation", {
      $ai_span_id: crypto.randomUUID(),
      $ai_parent_id: scope?.parentId ?? traceId,
      $ai_span_name: name,
      $ai_provider: call.provider,
      $ai_model: call.model,
      $ai_input_tokens: call.usage?.inputTokens,
      $ai_output_tokens: call.usage?.outputTokens,
      $ai_latency: seconds(Date.now() - call.startedAt),
      ...(text && call.input !== undefined
        ? { $ai_input: [{ role: "user", content: bounded(call.input) }] }
        : undefined),
      ...(text && call.output !== undefined
        ? {
            $ai_output_choices: [
              { role: "assistant", content: bounded(call.output) },
            ],
          }
        : undefined),
      ...error,
    });

    if (!scope) {
      close(at, {
        spanId: traceId,
        parentId: undefined,
        name,
        startedAt: call.startedAt,
        extra: { ...states(text, call.input, call.output), ...error },
      });
    }
  };

  return { integration, withAiTrace, captureAiCall };
};

export type AiTelemetry = ReturnType<typeof createAiTelemetry>;
