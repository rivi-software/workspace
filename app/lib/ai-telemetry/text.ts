import type { ModelMessage } from "ai";

/**
 * What an AI event may say of what was asked and answered: credentials masked, every string cut at `TEXT_LIMIT`,
 * a prompt at `INPUT_LIMIT` as a whole. Only `telemetry.ts` calls these, and only for a run whose text leaves.
 */

/** What a masked credential reads as. */
export const REDACTED = "[redacted]";

/** The longest string of a prompt, an answer or a tool's arguments or result that leaves; the rest of it is cut. */
export const TEXT_LIMIT = 30_000;

/** The size of a whole prompt as it leaves: its oldest messages give way first, its instructions stay. */
export const INPUT_LIMIT = 400_000;

const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gu;

// `https://user:secret@host`: the user and the password go, the scheme and the host stay. The lookbehind starts a
// scheme only where a run of its characters starts, so a long word is read once rather than once per letter.
const URL_USERINFO =
  /(?<![a-z0-9+.-])(?<scheme>[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/giu;

const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/gu;

// The prefixes of the keys and tokens the RIVI apps and their providers issue.
const KNOWN_TOKEN =
  /\b(?:sk-(?:ant-)?[\w-]{16,}|[rs]k_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9+/]{24,}={0,2}|gh[opsru]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|ph[cx]_[A-Za-z0-9]{20,}|sup_[A-Za-z0-9_-]{16,}|ws[ar]_[A-Za-z0-9_-]{16,})/gu;

const BEARER = /\b(?<scheme>Bearer|Basic)\s+[\w.~+/=-]{8,}/giu;

// `password: hunter2`, `api_key=abc…`, `"token": "abc…"`: the name stays, the value goes.
const ASSIGNMENT =
  /\b(?<name>(?:password|passwd|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|token)["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/giu;

/** Replaces the credentials in free text. Running it again changes nothing. */
export const maskCredentials = (text: string): string =>
  text
    .replaceAll(PEM_BLOCK, REDACTED)
    .replaceAll(URL_USERINFO, `$<scheme>${REDACTED}@`)
    .replaceAll(JWT, REDACTED)
    .replaceAll(KNOWN_TOKEN, REDACTED)
    .replaceAll(BEARER, `$<scheme> ${REDACTED}`)
    .replaceAll(ASSIGNMENT, `$<name>${REDACTED}`);

/** A string as it may leave: credentials masked, then cut at `TEXT_LIMIT`. */
export const bounded = (text: string): string => {
  const masked = maskCredentials(text);

  return masked.length > TEXT_LIMIT
    ? `${masked.slice(0, TEXT_LIMIT)}… [${masked.length - TEXT_LIMIT} more characters]`
    : masked;
};

/** Any value as JSON, then `bounded`: a tool's arguments or result, a decision's answers. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a tool's arguments and result are whatever the tool takes and answers; they are only serialized, masked and cut here
export const boundedJson = (value: unknown): string =>
  bounded(JSON.stringify(value) ?? "null");

/** A tool call as PostHog shows it, in the Chat Completions shape. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the arguments are the model's own, typed `unknown` by the AI SDK; they are only serialized
const toolCall = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: boundedJson(args) },
});

type ToolCall = ReturnType<typeof toolCall>;

/** A message as PostHog's trace view shows it. */
export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: string | null; tool_calls: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

/** A part the trace shows by its kind alone: an image, a file, an approval. */
const placeholder = (part: { type: string; mediaType?: string }) =>
  part.mediaType ? `[${part.type} ${part.mediaType}]` : `[${part.type}]`;

type ToolResultOutput = Extract<
  Extract<ModelMessage, { role: "tool" }>["content"][number],
  { type: "tool-result" }
>["output"];

/** A tool's answer as it went back to the model: its words as they are, anything else as JSON. */
const toolOutput = (output: ToolResultOutput): string => {
  switch (output.type) {
    case "text":
    case "error-text": {
      return bounded(output.value);
    }

    case "execution-denied": {
      return output.reason ? `[denied] ${bounded(output.reason)}` : "[denied]";
    }

    case "json":
    case "error-json":
    case "content": {
      return boundedJson(output.value);
    }

    default: {
      // A kind a later AI SDK adds is shown as it came: telemetry never fails a turn.
      return boundedJson(output);
    }
  }
};

type UserContent = Extract<ModelMessage, { role: "user" }>["content"];

const userContent = (content: UserContent): string => {
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part.type === "text" ? bounded(part.text) : placeholder(part)
      )
      .join("\n");
  }

  return bounded(content);
};

type AssistantContent = Extract<ModelMessage, { role: "assistant" }>["content"];

const assistantMessages = (content: AssistantContent): ChatMessage[] => {
  if (!Array.isArray(content)) {
    return [{ role: "assistant", content: bounded(content) }];
  }

  const words: string[] = [];
  const calls: ToolCall[] = [];
  const results: ChatMessage[] = [];

  for (const part of content) {
    if (part.type === "text") {
      words.push(bounded(part.text));
    } else if (part.type === "tool-call") {
      calls.push(toolCall(part.toolCallId, part.toolName, part.input));
    } else if (part.type === "tool-result") {
      // A provider-executed tool's result sits in the assistant's own message.
      results.push({
        role: "tool",
        tool_call_id: part.toolCallId,
        name: part.toolName,
        content: toolOutput(part.output),
      });
    } else if (part.type !== "reasoning" && part.type !== "reasoning-file") {
      // No thinking text leaves: the apps never read it, and it is the model's, not the conversation's.
      words.push(placeholder(part));
    }
  }

  const text = words.join("\n");

  return [
    calls.length
      ? { role: "assistant", content: text || null, tool_calls: calls }
      : { role: "assistant", content: text },
    ...results,
  ];
};

const messagesOf = (message: ModelMessage): ChatMessage[] => {
  switch (message.role) {
    case "system": {
      return [{ role: "system", content: bounded(message.content) }];
    }

    case "user": {
      return [{ role: "user", content: userContent(message.content) }];
    }

    case "assistant": {
      return assistantMessages(message.content);
    }

    case "tool": {
      return message.content.flatMap((part): ChatMessage[] =>
        part.type === "tool-result"
          ? [
              {
                role: "tool",
                tool_call_id: part.toolCallId,
                name: part.toolName,
                content: toolOutput(part.output),
              },
            ]
          : []
      );
    }

    default: {
      return [];
    }
  }
};

/** A call's instructions as the AI SDK hands them over: a string, a system message or several. */
export type Instructions =
  | string
  | { role: "system"; content: string }
  | readonly { role: "system"; content: string }[]
  | undefined;

/** One instruction's words: a string as it is, a system message's content. */
const instructionText = (item: string | { content: string }): string =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the AI SDK hands instructions over as a string or as system messages; this tells the two apart
  typeof item === "string" ? item : item.content;

const instructionMessages = (instructions: Instructions): ChatMessage[] => {
  if (!instructions) {
    return [];
  }

  // SAFETY: what is left of `Instructions` once it is not an array is a string or one system message.
  const one = [instructions as string | { content: string }];

  const list: readonly (string | { content: string })[] = Array.isArray(
    instructions
  )
    ? instructions
    : one;

  return list.map((item) => ({
    role: "system" as const,
    content: bounded(instructionText(item)),
  }));
};

/**
 * A prompt as PostHog shows it (`$ai_input`): the instructions as system messages, then the messages. Past
 * `INPUT_LIMIT` the oldest messages give way to one line that counts them, so the instructions and the latest
 * question stay.
 */
export const chatInput = (
  instructions: Instructions,
  messages: readonly ModelMessage[]
): ChatMessage[] => {
  const head = instructionMessages(instructions);
  const body = messages.flatMap(messagesOf);
  // Room for the line that counts what gave way.
  let size = JSON.stringify(head).length + 80;
  let first = body.length;

  while (first > 0) {
    const next = JSON.stringify(body[first - 1]).length + 1;

    if (size + next > INPUT_LIMIT) {
      break;
    }

    size += next;
    first -= 1;
  }

  const left: ChatMessage[] = first
    ? [{ role: "system", content: `[${first} earlier messages left out]` }]
    : [];

  return [...head, ...left, ...body.slice(first)];
};

/** One part of a model's answer, as the AI SDK reports it (`content` of a model call's end). */
export type AnswerPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: string };

/** The words of an answer, without its tool calls and thinking. */
export const answerText = (content: readonly AnswerPart[]): string =>
  content
    .flatMap((part) =>
      part.type === "text" && "text" in part ? [part.text] : []
    )
    .join("");

/** An answer as PostHog shows it (`$ai_output_choices`): its words and the tool calls it made. */
export const chatOutput = (content: readonly AnswerPart[]): ChatMessage[] => {
  const text = answerText(content);

  const calls = content.flatMap((part) =>
    part.type === "tool-call" && "toolCallId" in part
      ? [toolCall(part.toolCallId, part.toolName, part.input)]
      : []
  );

  return [
    calls.length
      ? {
          role: "assistant",
          content: text ? bounded(text) : null,
          tool_calls: calls,
        }
      : { role: "assistant", content: bounded(text) },
  ];
};

/** The latest thing the person said in a prompt: what a trace shows as its question. */
export const latestQuestion = (
  messages: readonly ModelMessage[]
): string | undefined => {
  const message = messages.findLast((m) => m.role === "user");

  return message?.role === "user" ? userContent(message.content) : undefined;
};
