import type { UIMessage } from "ai";

import { driveHref } from "~/lib/drive/drive";
import { listHref } from "~/lib/mail/links";

/**
 * The Assistant's shared vocabulary: what the page, the sidebar and the server (`chat.server.ts`) agree on. A plain
 * module: route components read it.
 */

/** The tools the assistant may call (`tools.server.ts`); each step on the page is named after one. */
export const ASSISTANT_TOOLS = [
  "search_mail",
  "read_conversation",
  "search_drive",
  "read_file",
  "create_draft",
] as const;

export type AssistantToolName = (typeof ASSISTANT_TOOLS)[number];

/** A question is at most this long. */
export const MAX_QUESTION_CHARS = 8000;

/** How many earlier messages of a conversation go to the model with a question. */
export const HISTORY_MESSAGES = 40;

/** A conversation holds at most this many messages; after that the person starts a new one. */
export const MAX_CONVERSATION_MESSAGES = 200;

/** The title a conversation gets from its first question. */
export const MAX_TITLE_CHARS = 80;

/** What a conversation carries to the sidebar and the page header. */
export interface ConversationRef {
  id: string;
  title: string;
  updatedAt: string;
}

/** What the assistant's answer carries besides its parts: the conversation it belongs to, for a new one. */
export interface AssistantMetadata {
  conversationId?: string;
}

/** The message the page renders and the server keeps: the AI SDK's UI message, text and tool parts. */
export type AssistantMessage = UIMessage<AssistantMetadata>;

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/**
 * A message as the server stores it and a loader hands it over: the UI message's parts as the JSON they are, since
 * the SDK types a tool's input and output as `unknown`, which no loader may carry. The page reads them as
 * `AssistantMessage` (`toUIMessages`).
 */
export type StoredPart = { type: string } & Record<string, Json | undefined>;

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  parts: StoredPart[];
}

export const toUIMessages = (stored: StoredMessage[]): AssistantMessage[] =>
  // SAFETY: a stored message is a UI message's JSON; the SDK types a tool's input and output as `unknown`, which no loader may carry.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Json to unknown is the loader's side of that boundary
  stored as unknown as AssistantMessage[];

/** A tool part as the page reads it: the AI SDK types it per tool, the page by the name in its `type`. */
export interface ToolPart {
  type: `tool-${string}`;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

export const isToolPart = (part: { type: string }): part is ToolPart =>
  part.type.startsWith("tool-");

/** What the empty page offers to ask first. */
export const SUGGESTIONS = [
  "What arrived in my inbox today?",
  "Summarize my unread conversations",
  "Which files did I work on last?",
  "Help me write an email",
] as const;

/** The opening words of a question, on one line, as the conversation's title. */
export const conversationTitle = (text: string): string => {
  const line = text.replaceAll(/\s+/gu, " ").trim();

  if (!line) {
    return "New conversation";
  }

  if (line.length <= MAX_TITLE_CHARS) {
    return line;
  }

  const cut = line.slice(0, MAX_TITLE_CHARS);
  const space = cut.lastIndexOf(" ");

  return `${space > MAX_TITLE_CHARS / 2 ? cut.slice(0, space) : cut}…`;
};

/** The text of a message: its text parts joined. */
export const messageText = (message: {
  parts: { type: string; text?: string }[];
}): string =>
  message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();

export interface StepView {
  /** What the step did, in plain words ("Searched mail for “the plan”"). */
  label: string;
  /** What it found ("3 conversations"), when it is done. */
  detail?: string;
  /** Where the step's subject is in the console, when it has a page. */
  link?: string;
  /** Whether the step is still running. */
  running: boolean;
  /** Whether it failed. */
  failed: boolean;
}

const quote = (value: string | undefined) => `“${(value ?? "").trim() || "…"}”`;

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- a tool's input and output reach the page as the JSON they are
const field = (o: unknown, key: string): unknown =>
  o instanceof Object
    ? Object.entries(o).find(([name]) => name === key)?.[1]
    : undefined;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- reads a field of a tool's JSON
const str = (o: unknown, key: string): string | undefined => {
  const v = field(o, key);

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the tool's JSON is not typed
  return typeof v === "string" ? v : undefined;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- reads a field of a tool's JSON
const num = (o: unknown, key: string): number | undefined => {
  const v = field(o, key);

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the tool's JSON is not typed
  return typeof v === "number" ? v : undefined;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What a step's line is built from: where the tool is, and what it was given and returned. */
interface StepState {
  running: boolean;
  failed: boolean;
  error: string | undefined;
  input: unknown;
  output: unknown;
}

/** A step's label while it runs, when it failed and when it is done. */
const phaseLabel = (
  { running, failed }: StepState,
  labels: { busy: string; failed: string; done: string }
) => {
  if (running) {
    return labels.busy;
  }

  return failed ? labels.failed : labels.done;
};

/** A search step: "Searched mail for “x”" with a query, "Listed mail" without. */
const searchLabel = (
  { running }: StepState,
  query: string | undefined,
  labels: { busy: string; searched: string; listed: string }
) => {
  if (running) {
    return labels.busy;
  }

  return query ? `${labels.searched} ${quote(query)}` : labels.listed;
};

/** What a search found ("3 conversations"), or why it failed. */
const countDetail = (state: StepState, unit: string) => {
  if (state.failed) {
    return state.error;
  }

  const n = num(state.output, "count");

  return n === undefined ? undefined : plural(n, unit);
};

const draftDetail = (state: StepState) => {
  if (state.failed) {
    return state.error;
  }

  const to = str(state.output, "to");

  return to ? `to ${to}` : undefined;
};

const toolStep = (name: string, state: StepState): StepView => {
  const { running, failed, input, output } = state;

  switch (name) {
    case "search_mail": {
      const q = str(input, "query");

      return {
        label: searchLabel(state, q, {
          busy: "Searching mail…",
          searched: "Searched mail for",
          listed: "Listed mail",
        }),
        detail: countDetail(state, "conversation"),
        link: listHref(q),
        running,
        failed,
      };
    }

    case "read_conversation": {
      return {
        label: phaseLabel(state, {
          busy: "Reading a conversation…",
          failed: "Could not read the conversation",
          done: `Read ${quote(str(output, "subject"))}`,
        }),
        detail: failed ? state.error : undefined,
        link: str(output, "link"),
        running,
        failed,
      };
    }

    case "search_drive": {
      const q = str(input, "query");

      return {
        label: searchLabel(state, q, {
          busy: "Searching Drive…",
          searched: "Searched Drive for",
          listed: "Listed recent files",
        }),
        detail: countDetail(state, "item"),
        link: driveHref(q, "recent"),
        running,
        failed,
      };
    }

    case "read_file": {
      return {
        label: phaseLabel(state, {
          busy: "Reading a file…",
          failed: "Could not read the file",
          done: `Read ${quote(str(output, "name"))}`,
        }),
        detail: failed ? state.error : undefined,
        link: str(output, "link"),
        running,
        failed,
      };
    }

    case "create_draft": {
      const subject = str(output, "subject");

      return {
        label: phaseLabel(state, {
          busy: "Preparing a draft…",
          failed: "Could not prepare the draft",
          done: `Prepared a draft${subject ? `: ${quote(subject)}` : ""}`,
        }),
        detail: draftDetail(state),
        link: str(output, "link"),
        running,
        failed,
      };
    }

    default: {
      return {
        label: running ? `Running ${name}…` : `Ran ${name}`,
        running,
        failed,
      };
    }
  }
};

/** A tool part as a line on the page: what the assistant did, and what came of it. */
export const stepView = (part: ToolPart): StepView => {
  const running =
    part.state === "input-streaming" || part.state === "input-available";

  const error =
    part.state === "output-error" ? part.errorText : str(part.output, "error");

  return toolStep(part.type.slice("tool-".length), {
    running,
    failed: !!error,
    error,
    input: part.input,
    output: part.output,
  });
};
