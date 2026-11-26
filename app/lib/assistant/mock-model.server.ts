import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

import { ASKED_PREFIX } from "./time";

/*
 * The dev model: what the Assistant answers with where `AI_PROVIDER` is `mock` (`pnpm run dev` from
 * `.dev.vars.example`, the smoke against the build), so it answers without `wrangler login`. `assistantModel`
 * (./provider.server) imports this module only then, so a Worker on a real provider never loads it or `ai/test`.
 * The tests script their own models (test/scripted-model.ts) and use this one only to test it.
 */

type Plan =
  | { tool: string; input: Record<string, string | string[] | undefined> }
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
      // Without the line that says when the question was asked, which is no part of what the person wrote.
      return parts.data
        .map((c) => c.text ?? "")
        .filter((part) => !part.startsWith(ASKED_PREFIX))
        .join(" ");
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

  if (
    (m = user.match(
      /what(?:'s| is) on (?:my calendar )?(?:on )?(?<from>\d{4}-\d{2}-\d{2})/iu
    ))
  ) {
    return { tool: "list_events", input: { from: m[1] } };
  }

  if (
    (m = user.match(
      /(?<action>archive|star|trash) (?:the conversation )?(?<id>th_[a-z0-9]+)/iu
    ))
  ) {
    return {
      tool: "organize_mail",
      input: { conversationIds: [m[2]], action: m[1].toLowerCase() },
    };
  }

  if ((m = user.match(/(?:list|show) my (?<done>done )?tasks/iu))) {
    return { tool: "list_tasks", input: { status: m[1] ? "done" : "open" } };
  }

  if (
    (m = user.match(
      /add a task (?<title>.+?)(?: due (?<dueOn>\d{4}-\d{2}-\d{2}))?[.!]?$/iu
    ))
  ) {
    return { tool: "create_task", input: { title: m[1].trim(), dueOn: m[2] } };
  }

  if (
    (m = user.match(
      /add an event (?<title>.+?) on (?<date>\d{4}-\d{2}-\d{2})(?: at (?<startTime>\d{2}:\d{2}))?/iu
    ))
  ) {
    return {
      tool: "create_event",
      input: { title: m[1].trim(), date: m[2], startTime: m[3] },
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

/**
 * A deterministic in-process model that calls the tools on a few well-known phrasings ("search my mail for …",
 * "find files named …", "read the conversation th_…", "read the file dn_…", "draft a reply to th_… saying …",
 * "draft an email to … about …", "what is on 2026-11-17", "list my tasks", "add a task … due 2026-11-20", "add an
 * event … on 2026-11-20 at 14:00", "archive th_…"), reads a tool's answer back after a tool step, and otherwise echoes the question.
 */
export const mockModel = (): MockLanguageModelV4 => {
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
