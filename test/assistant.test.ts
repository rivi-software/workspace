import { installPostHogForTests } from "@rivi-software/posthog-tanstack-start/server";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { assistantMessages, drafts } from "~/db/schema";
import type { User } from "~/db/schema";
import {
  conversationTitle,
  messageText,
  stepView,
} from "~/lib/assistant/assistant";
import type { Json } from "~/lib/assistant/assistant";
import {
  AssistantError,
  answerChat,
  deleteConversation,
  getConversation,
  listConversations,
} from "~/lib/assistant/chat.server";
import { parseMarkdown, safeHref } from "~/lib/assistant/markdown";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  assistantModel,
  claudeOptions,
} from "~/lib/assistant/provider.server";
import { finishUpload, startUpload } from "~/lib/drive/drive.server";
import { stringOrNull } from "~/lib/guards";
import { ingestInboundEmail } from "~/lib/mail/ingest.server";

import { ask, promptOf, question, toolPart } from "./assistant-turn";
import { db, defined, mail, mailbox, stringContaining } from "./fixtures";
import { renderMarkdown } from "./markdown";
import { scriptedModel } from "./scripted-model";

const stored = async (user: User, over: Parameters<typeof mail>[0] = {}) => {
  const r = await ingestInboundEmail(
    env,
    null,
    mail({ to: [{ email: user.email, name: null }], ...over }),
    user.email
  );

  if (r.status !== "stored") {
    throw new Error(r.status);
  }

  return r;
};

/** A small text file in Drive, sent whole, as the upload route does it. */
const putFile = async (userId: string, name: string, text: string) => {
  const bytes = new TextEncoder().encode(text);

  const { node } = await startUpload(db, env, userId, {
    parentId: null,
    name,
    size: bytes.byteLength,
    contentType: "text/plain",
    multipart: false,
  });

  await env.DRIVE.put(defined(node.r2Key), bytes, {
    httpMetadata: { contentType: node.contentType },
  });

  return finishUpload(env, db, userId, node.id);
};

/** The stream read on until `until` holds for what has arrived, or to its end. */
const readOn = async (
  reader: ReadableStreamDefaultReader<string>,
  until: (body: string) => boolean,
  body = ""
): Promise<string> => {
  if (until(body)) {
    return body;
  }

  const { value, done } = await reader.read();

  return done ? body : readOn(reader, until, body + value);
};

describe("the assistant", () => {
  let ann: User;
  let bo: User;
  beforeAll(async () => {
    ann = await mailbox("ann", "Ann");
    bo = await mailbox("bo", "Bo");
  });

  afterEach(() => installPostHogForTests(null));

  it("answers with the model it is given, keeps the conversation and continues it", async () => {
    const first = await ask(ann, "Hello there, what can you do?", [
      { text: "I look things up in your mail and files." },
    ]);

    const row = await db.query.assistantMessages.findFirst({
      where: eq(assistantMessages.id, first.last.id),
    });

    expect({
      body: first.body.includes("I look things up in your mail and files."),
      title: first.stored.conversation.title,
      roles: first.stored.messages.map((m) => m.role),
      question: messageText(first.stored.messages[0]),
      answer: messageText(first.last),
      // The answer keeps the model's own id and what the turn used.
      model: row?.model,
      tokens: [row?.inputTokens, row?.outputTokens],
    }).toStrictEqual({
      body: true,
      title: "Hello there, what can you do?",
      roles: ["user", "assistant"],
      question: "Hello there, what can you do?",
      answer: "I look things up in your mail and files.",
      model: "scripted",
      tokens: [10, 10],
    });
    const listed = await listConversations(db, ann.id);
    expect(listed.map((c) => c.id)).toContain(first.conversationId);

    const second = await ask(ann, "And again?", [{ text: "Mail and files." }], {
      conversationId: first.conversationId,
    });

    const seen = promptOf(second.model, 1);

    expect({
      conversationId: second.conversationId,
      roles: second.stored.messages.map((m) => m.role),
      value:
        second.stored.conversation.updatedAt >=
        first.stored.conversation.updatedAt,
      // The model reads the conversation so far and the one prompt every model gets.
      history: [
        seen.includes("Hello there, what can you do?"),
        seen.includes("I look things up in your mail and files."),
        seen.includes("And again?"),
      ],
      prompt: seen.includes("You are the Assistant in Workspace"),
      mock: seen.includes("mock"),
    }).toStrictEqual({
      conversationId: first.conversationId,
      roles: ["user", "assistant", "user", "assistant"],
      value: true,
      history: [true, true, true],
      prompt: true,
      mock: false,
    });
  });

  it("searches the person's mail through a tool, and only theirs", async () => {
    await stored(ann, {
      subject: "Quarterly plan",
      text: "The plan for the quarter is attached.",
    });
    await stored(bo, { subject: "Secret budget", text: "Bo's own budget." });

    const found = await ask(ann, "Anything about the quarter?", [
      { tool: "search_mail", input: { query: "quarterly" } },
      { text: "One conversation is about the quarter." },
    ]);

    const step = defined(toolPart(found.last.parts, "search_mail"));
    expect({
      state: step.state,
      query: step.input.query,
      count: step.output.count,
      // The page sees the search's result arrive, and the model's next step reads it.
      body: found.body.includes("Quarterly plan"),
      seen: promptOf(found.model, 2).includes("Quarterly plan"),
      answer: messageText(found.last),
    }).toStrictEqual({
      state: "output-available",
      query: "quarterly",
      count: 1,
      body: true,
      seen: true,
      answer: "One conversation is about the quarter.",
    });
    // The step reads as a line on the page.
    const view = stepView(step);
    expect({ label: view.label, detail: view.detail }).toStrictEqual({
      label: "Searched mail for “quarterly”",
      detail: "1 conversation",
    });

    const missed = await ask(ann, "And the budget?", [
      { tool: "search_mail", input: { query: "budget" } },
      { text: "Nothing about a budget." },
    ]);

    expect(
      defined(toolPart(missed.last.parts, "search_mail")).output.count
    ).toBe(0);
  });

  it("reads a conversation and prepares a reply draft the person sends", async () => {
    const r = await stored(ann, {
      subject: "Lunch on Friday",
      text: "Shall we have lunch on Friday?\n\n> an earlier line",
      from: { email: "jane@acme.com", name: "Jane Doe" },
    });

    const read = await ask(ann, "What does Jane ask?", [
      { tool: "read_conversation", input: { conversationId: r.threadId } },
      { text: "Jane asks about lunch on Friday." },
    ]);

    const step = defined(toolPart(read.last.parts, "read_conversation"));

    expect({
      subject: step.output.subject,
      messages: step.output.messages,
      view: stepView(step),
    }).toMatchObject({
      subject: "Lunch on Friday",
      messages: [
        {
          text: "Shall we have lunch on Friday?",
          from: stringContaining("jane@acme.com"),
        },
      ],
      view: {
        label: "Read “Lunch on Friday”",
        link: `/mail/t/${r.threadId}`,
      },
    });

    const drafted = await ask(ann, "Tell her Friday works.", [
      {
        tool: "create_draft",
        input: { replyTo: r.threadId, body: "Friday works, see you then." },
      },
      { text: "A reply waits in Drafts." },
    ]);

    const draftStep = defined(toolPart(drafted.last.parts, "create_draft"));

    expect(draftStep.output.link).toMatch(/^\/mail\/compose\?draft=dr_/u);

    const row = defined(
      await db.query.drafts.findFirst({
        where: eq(
          drafts.id,
          defined(stringOrNull(draftStep.output.draftId), "draft id")
        ),
      })
    );

    // What the draft holds is Mail's to say (test/mail.test.ts); the tool made it in Ann's mailbox.
    expect({
      subject: draftStep.output.subject,
      row,
      to: draftStep.output.to,
      label: stepView(draftStep).label,
    }).toMatchObject({
      subject: "Re: Lunch on Friday",
      row: {
        userId: ann.id,
        mode: "reply",
        threadId: r.threadId,
      },
      to: "Jane Doe <jane@acme.com>",
      label: "Prepared a draft: “Re: Lunch on Friday”",
    });

    // Bo's assistant knows nothing of Ann's conversation.
    const other = await ask(bo, "What does Jane ask?", [
      { tool: "read_conversation", input: { conversationId: r.threadId } },
      { text: "I cannot find that conversation." },
    ]);

    expect(
      defined(toolPart(other.last.parts, "read_conversation")).output.error
    ).toContain("No such conversation");
  });

  it("prepares a new message to the addresses given", async () => {
    const drafted = await ask(ann, "Write to Kim about the offsite agenda", [
      {
        tool: "create_draft",
        input: {
          to: ["kim@acme.com"],
          subject: "The offsite agenda",
          body: "Shall we settle the offsite agenda this week?",
        },
      },
      { text: "A message to Kim waits in Drafts." },
    ]);

    const step = defined(toolPart(drafted.last.parts, "create_draft"));
    expect(step.output.to).toBe("kim@acme.com");

    const row = defined(
      await db.query.drafts.findFirst({
        where: eq(
          drafts.id,
          defined(stringOrNull(step.output.draftId), "draft id")
        ),
      })
    );

    expect(row).toMatchObject({
      userId: ann.id,
      mode: "new",
      subject: "The offsite agenda",
    });
  });

  it("reads a text file in Drive, and not a stranger's", async () => {
    const file = await putFile(
      ann.id,
      "notes.txt",
      "the secret plan\nin two lines"
    );

    const readFile = [
      { tool: "read_file", input: { fileId: file.id } },
      { text: "The notes hold a plan." },
    ];

    const read = await ask(ann, "What do my notes say?", readFile);
    const step = defined(toolPart(read.last.parts, "read_file"));
    expect(step.output.text).toBe("the secret plan\nin two lines");
    expect(stepView(step)).toMatchObject({
      label: "Read “notes.txt”",
      link: `/drive/d/${file.id}`,
    });

    const other = await ask(bo, "What do Ann's notes say?", readFile);
    expect(
      defined(toolPart(other.last.parts, "read_file")).output.error
    ).toContain("No such file");

    const found = await ask(ann, "Where are my notes?", [
      { tool: "search_drive", input: { query: "notes" } },
      { text: "In notes.txt." },
    ]);

    expect(
      defined(toolPart(found.last.parts, "search_drive")).output.count
    ).toBe(1);
  });

  it("hands a model its thinking back within a turn, and keeps none of it in the conversation", async () => {
    const first = await ask(ann, "Anything about the thinking test?", [
      {
        tool: "search_mail",
        input: { query: "thinking test" },
        thinking: "I should search the mail first.",
      },
      { text: "Nothing in your mail.", thinking: "The search found nothing." },
    ]);

    const second = await ask(ann, "And in Drive?", [{ text: "Nor there." }], {
      conversationId: first.conversationId,
    });

    expect({
      // The second step of the turn reads what the first thought, with the provider's signature on it.
      withinTurn: promptOf(first.model, 2).includes(
        "signed I should search the mail first."
      ),
      // The page gets no thinking, so none is stored, and the next turn replays none. Nor is the provider's own
      // part kept, which the page does get.
      page: [first.body.includes("reasoning"), first.body.includes("msg_")],
      stored: first.last.parts.map((p) => p.type),
      nextTurn: [
        promptOf(second.model, 1).includes("I should search"),
        promptOf(second.model, 1).includes("msg_"),
      ],
      answer: messageText(first.last),
    }).toStrictEqual({
      withinTurn: true,
      page: [false, true],
      stored: ["step-start", "tool-search_mail", "step-start", "text"],
      nextTurn: [false, false],
      answer: "Nothing in your mail.",
    });
  });

  it("keeps the empty answer of a model that declines, and leaves it out of what the model reads next", async () => {
    const declined = await ask(ann, "Something it will not answer.", [
      { declined: true },
    ]);

    const next = await ask(ann, "And this?", [{ text: "This, yes." }], {
      conversationId: declined.conversationId,
    });

    const seen = next.model.doStreamCalls[0]?.prompt ?? [];

    expect({
      // The page shows an answer without words as "The assistant gave no answer", after a reload too.
      kept: declined.stored.messages.map((m) => [
        m.role,
        m.parts.map((p) => p.type),
      ]),
      // The model reads the two questions and no turn without content between them.
      roles: seen.map((m) => m.role),
      questions: [
        JSON.stringify(seen).includes("Something it will not answer."),
        JSON.stringify(seen).includes("And this?"),
      ],
      after: next.stored.messages.map((m) => m.role),
    }).toStrictEqual({
      kept: [
        ["user", ["text"]],
        ["assistant", ["step-start"]],
      ],
      roles: ["system", "user", "user"],
      questions: [true, true],
      after: ["user", "assistant", "user", "assistant"],
    });
  });

  it("stops a model that keeps calling tools after 8 steps", async () => {
    const searches = Array.from({ length: 12 }, (_, i) => ({
      tool: "search_mail",
      input: { query: `plan ${i}` },
    }));

    const turn = await ask(ann, "Keep looking", searches);

    expect({
      calls: turn.model.doStreamCalls.length,
      steps: turn.last.parts.filter((p) => p.type === "tool-search_mail")
        .length,
      role: turn.last.role,
    }).toStrictEqual({ calls: 8, steps: 8, role: "assistant" });
  });

  it("carries a tool that throws to the model, shows the page a failed step, and answers on", async () => {
    const file = await putFile(ann.id, "minutes.txt", "the minutes");

    const failingGet: Pick<R2Bucket, "get"> = {
      get: () => Promise.reject(new Error("The bucket is down.")),
    };

    // SAFETY: test-only: `read_file` reads the bucket through `get` alone, which fails here.
    const broken: Env = { ...env, DRIVE: failingGet as R2Bucket };

    const turn = await ask(
      ann,
      "What do the minutes say?",
      [
        { tool: "read_file", input: { fileId: file.id } },
        { text: "I could not read the minutes; try again later." },
      ],
      { env: broken }
    );

    const step = defined(toolPart(turn.last.parts, "read_file"));

    // The model reads what went wrong; the page gets the stream's own words, never the error's.
    expect({
      state: step.state,
      errorText: step.errorText,
      failed: stepView(step).failed,
      seen: promptOf(turn.model, 2).includes("The bucket is down."),
      leaked: turn.body.includes("The bucket is down."),
      answer: messageText(turn.last),
    }).toStrictEqual({
      state: "output-error",
      errorText: "The assistant could not answer. Try again in a moment.",
      failed: true,
      seen: true,
      leaked: false,
      answer: "I could not read the minutes; try again later.",
    });
  });

  it("tells the page when the model fails, reports it, and keeps the question alone", async () => {
    const reported: {
      error: unknown;
      handler: unknown;
      stage: unknown;
      model: unknown;
    }[] = [];

    installPostHogForTests({
      captureImmediate: () => Promise.resolve(),
      captureExceptionImmediate: (error, _distinctId, properties) => {
        reported.push({
          error,
          handler: properties?.handler,
          stage: properties?.stage,
          model: properties?.model,
        });

        return Promise.resolve();
      },
    });

    const turn = await ask(ann, "Is the model up?", [
      { error: new Error("The model is down.") },
    ]);

    expect({
      body: turn.body.includes(
        "The assistant could not answer. Try again in a moment."
      ),
      leaked: turn.body.includes("The model is down."),
      roles: turn.stored.messages.map((m) => m.role),
      reported: reported.map(({ error, ...where }) => ({
        message: error instanceof Error ? error.message : String(error),
        ...where,
      })),
    }).toStrictEqual({
      body: true,
      leaked: false,
      roles: ["user"],
      reported: [
        {
          message: "The model is down.",
          handler: "assistant",
          stage: "model",
          model: "scripted",
        },
      ],
    });
  });

  it("keeps the question alone when the model's stream breaks before a word, as when its call fails", async () => {
    const turn = await ask(ann, "Does the stream hold?", [
      { error: new Error("The stream broke."), midway: true },
    ]);

    expect({
      body: turn.body.includes(
        "The assistant could not answer. Try again in a moment."
      ),
      // No empty answer is kept for it: the page would say the assistant gave no answer, which is not what happened.
      kept: turn.stored.messages.map((m) => [
        m.role,
        m.parts.map((p) => p.type),
      ]),
    }).toStrictEqual({ body: true, kept: [["user", ["text"]]] });
  });

  it("ends the answer when the page goes away, keeping what was written", async () => {
    const page = new AbortController();

    const model = scriptedModel([
      { text: "The first half of a long answer", open: true },
    ]);

    const answer = await answerChat(
      env,
      db,
      ann,
      model,
      { conversationId: null, message: question("Tell me everything") },
      page.signal
    );

    const reader = defined(answer.response.body)
      .pipeThrough(new TextDecoderStream())
      .getReader();

    const before = await readOn(reader, (body) =>
      body.includes("The first half")
    );

    page.abort();
    const body = await readOn(reader, () => false, before);
    await answer.done;

    const kept = defined(
      await getConversation(db, ann.id, answer.conversationId)
    );

    expect({
      signal: model.doStreamCalls[0]?.abortSignal?.aborted,
      aborted: body.includes('"type":"abort"'),
      roles: kept.messages.map((m) => m.role),
      answer: messageText(defined(kept.messages.at(-1))),
    }).toStrictEqual({
      signal: true,
      aborted: true,
      roles: ["user", "assistant"],
      answer: "The first half of a long answer",
    });
  });

  it("refuses an empty question, one with parts it cannot read, and one not from the person", async () => {
    const unused = scriptedModel([]);

    await expect(
      answerChat(env, db, ann, unused, {
        conversationId: null,
        message: question("   "),
      })
    ).rejects.toThrow("Write a question first.");
    // Parts that are no object, or text that is no string, say the same, not a TypeError (a 500).
    await expect(
      answerChat(env, db, ann, unused, {
        conversationId: null,
        message: { role: "user", parts: [null, 7, { type: "text", text: 5 }] },
      })
    ).rejects.toThrow("Write a question first.");
    await expect(
      answerChat(env, db, ann, unused, {
        conversationId: null,
        message: { role: "assistant" },
      })
    ).rejects.toThrow(AssistantError);
    // A refused question never reaches the model.
    expect(unused.doStreamCalls).toHaveLength(0);
  });

  it("refuses another person's conversation, and deletes for the owner only", async () => {
    const mine = await ask(ann, "Mine alone", [{ text: "Yours alone." }]);
    const unused = scriptedModel([]);

    await expect(
      answerChat(env, db, bo, unused, {
        conversationId: mine.conversationId,
        message: question("Let me in"),
      })
    ).rejects.toThrow(AssistantError);

    const [boDelete, annConvBefore] = await Promise.all([
      deleteConversation(db, bo.id, mine.conversationId),
      getConversation(db, ann.id, mine.conversationId),
    ]);

    expect({
      // A refused question never reaches the model.
      calls: unused.doStreamCalls.length,
      boDelete,
      annHasConv: annConvBefore !== null,
    }).toStrictEqual({
      calls: 0,
      boDelete: false,
      annHasConv: true,
    });

    const annDelete = await deleteConversation(db, ann.id, mine.conversationId);
    const annConvAfter = await getConversation(db, ann.id, mine.conversationId);
    const conversations = await listConversations(db, ann.id);

    expect({
      annDelete,
      annConvAfter,
      stillListed: conversations.map((c) => c.id).includes(mine.conversationId),
    }).toStrictEqual({
      annDelete: true,
      annConvAfter: null,
      stillListed: false,
    });
  });
});

/** The Worker's env with the Assistant's vars and binding as given. */
const withAi = (vars: {
  AI_PROVIDER: string;
  AI_CHAT_MODEL?: string;
  AI?: Ai;
}): Env => {
  // SAFETY: test-only: the vars are typed as `wrangler.jsonc`'s literals, and the module reads them as any string.
  const laid = { ...env, ...vars } as Env;

  return laid;
};

describe("the assistant's model", () => {
  // SAFETY: test-only: making a model reaches nothing of its binding; only a call would, and no test makes one.
  const binding = {} as Ai;

  it("is the dev model only where AI_PROVIDER says mock, and it calls a tool on its phrasings", async () => {
    const ann = await mailbox("dev-ann", "Ann");
    await stored(ann, { subject: "Dev model lunch", text: "Lunch at noon." });

    const model = await assistantModel(withAi({ AI_PROVIDER: "mock" }));
    expect(model).toMatchObject({ modelId: "mock" });

    const answer = await answerChat(env, db, ann, model, {
      conversationId: null,
      message: question("Search my mail for dev model lunch"),
    });

    const body = await answer.response.text();
    await answer.done;

    // A phrasing of Calendar's and Tasks' tools, under the line that says when the question was asked.
    const adding = await answerChat(env, db, ann, model, {
      conversationId: null,
      message: question("Add a task Call the dev model due 2027-03-12."),
    });

    const added = await adding.response.text();
    await adding.done;

    expect({
      searched: body.includes('"toolName":"search_mail"'),
      found: body.includes("Dev model lunch"),
      readBack: body.includes("search_mail answered"),
      added: [
        '"toolName":"create_task"',
        '"title":"Call the dev model"',
        '"dueOn":"2027-03-12"',
      ].every((piece) => added.includes(piece)),
      addedBack: added.includes("create_task answered"),
    }).toStrictEqual({
      searched: true,
      found: true,
      readBack: true,
      added: true,
      addedBack: true,
    });
  });

  it("runs a real provider through the AI binding", async () => {
    const [workersAi, anthropic] = await Promise.all([
      assistantModel(
        withAi({
          AI_PROVIDER: "workers-ai",
          AI_CHAT_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          AI: binding,
        })
      ),
      assistantModel(
        withAi({
          AI_PROVIDER: "anthropic",
          AI_CHAT_MODEL: "claude-sonnet-5-5",
          AI: binding,
        })
      ),
    ]);

    expect([workersAi, anthropic]).toMatchObject([
      { modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
      { modelId: "claude-sonnet-5-5" },
    ]);
  });

  it("keeps each provider on a model of its own, whatever AI_CHAT_MODEL names", async () => {
    // Going back from Claude to Workers AI, or the other way, is a change of AI_PROVIDER alone.
    const [workersAi, anthropic] = await Promise.all([
      assistantModel(
        withAi({
          AI_PROVIDER: "workers-ai",
          AI_CHAT_MODEL: "claude-sonnet-5-5",
          AI: binding,
        })
      ),
      assistantModel(
        withAi({
          AI_PROVIDER: "anthropic",
          AI_CHAT_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          AI: binding,
        })
      ),
    ]);

    expect([workersAi, anthropic]).toMatchObject([
      { modelId: DEFAULT_WORKERS_AI_MODEL },
      { modelId: DEFAULT_CLAUDE_MODEL },
    ]);
  });

  it("asks a Claude model for a medium effort, a cached prefix and, where it has one, the refusal fallback", () => {
    expect([
      claudeOptions("claude-sonnet-5-5"),
      claudeOptions("claude-haiku-5-5"),
    ]).toStrictEqual([
      {
        effort: "medium",
        cacheControl: { type: "ephemeral" },
        fallbacks: "default",
      },
      { effort: "medium", cacheControl: { type: "ephemeral" } },
    ]);
  });

  // An unset or unknown AI_PROVIDER is Workers AI, as in production: only `mock` itself picks the mock.
  it.each(["workers-ai", "anthropic", "", "gpt"])(
    "refuses AI_PROVIDER '%s' without the AI binding rather than answer from the mock",
    async (provider) => {
      await expect(
        assistantModel(withAi({ AI_PROVIDER: provider, AI: undefined }))
      ).rejects.toThrow("no AI binding");
    }
  );
});

/** A done step of `tool` as the page shows it: its line, what came of it, where it leads and whether it failed. */
const stepLine = (
  tool: string,
  input: { [key: string]: Json },
  output: { [key: string]: Json }
) => {
  const view = stepView({
    type: `tool-${tool}`,
    toolCallId: tool,
    state: "output-available",
    input,
    output,
  });

  return [view.label, view.detail, view.link, view.failed];
};

describe("the assistant's vocabulary", () => {
  it("titles a conversation from its first words", () => {
    expect(conversationTitle("  What arrived\n today?  ")).toBe(
      "What arrived today?"
    );
    expect(conversationTitle("")).toBe("New conversation");
    const long = conversationTitle(`${"word ".repeat(30)}end`);
    expect(long.length).toBeLessThanOrEqual(81);
    expect(long.endsWith("…")).toBeTruthy();
    expect(long).not.toContain("wor…");
  });

  it("names a running, a done and a failed step", () => {
    expect(
      stepView({
        type: "tool-search_mail",
        toolCallId: "1",
        state: "input-streaming",
      })
    ).toMatchObject({ label: "Searching mail…", running: true, failed: false });
    expect(
      stepView({
        type: "tool-search_drive",
        toolCallId: "2",
        state: "output-available",
        input: { query: "budget" },
        output: { count: 3 },
      })
    ).toMatchObject({
      label: "Searched Drive for “budget”",
      detail: "3 items",
      running: false,
    });
    expect(
      stepView({
        type: "tool-read_file",
        toolCallId: "3",
        state: "output-available",
        output: { error: "too large", link: "/drive/d/dn_1" },
      })
    ).toMatchObject({
      label: "Could not read the file",
      detail: "too large",
      failed: true,
    });
    expect(
      stepView({
        type: "tool-read_file",
        toolCallId: "4",
        state: "output-error",
        errorText: "boom",
      })
    ).toMatchObject({ failed: true, detail: "boom" });
  });

  it("names the steps in Calendar and Tasks, each with where it leads", () => {
    expect([
      stepLine(
        "list_events",
        { from: "2027-03-09" },
        { count: 2, link: "/calendar?date=2027-03-09" }
      ),
      stepLine(
        "list_events",
        { from: "2027-03-09", to: "2027-03-12" },
        { count: 1 }
      ),
      stepLine("list_tasks", {}, { count: 3, link: "/tasks" }),
      stepLine(
        "list_tasks",
        { status: "done" },
        { count: 0, link: "/tasks?view=done" }
      ),
      stepLine(
        "create_task",
        { title: "Call Joris" },
        { title: "Call Joris", dueOn: "2027-03-12", link: "/tasks" }
      ),
      stepLine(
        "create_event",
        { title: "Call" },
        {
          title: "Call",
          start: "2027-03-12 14:00",
          link: "/calendar?date=2027-03-12",
        }
      ),
      stepLine(
        "create_event",
        { title: "Call" },
        { error: "The event ends before it starts." }
      ),
    ]).toStrictEqual([
      [
        "Read the calendar, 9 March",
        "2 events",
        "/calendar?date=2027-03-09",
        false,
      ],
      ["Read the calendar, 9 to 12 March", "1 event", "/calendar", false],
      ["Read the open tasks", "3 tasks", "/tasks", false],
      ["Read the tasks that are done", "0 tasks", "/tasks?view=done", false],
      ["Added a task: “Call Joris”", "due 12 March", "/tasks", false],
      [
        "Added an event: “Call”",
        "12 March, 14:00",
        "/calendar?date=2027-03-12",
        false,
      ],
      [
        "Could not add the event",
        "The event ends before it starts.",
        undefined,
        true,
      ],
    ]);
  });

  it("lets only web, mail and local links through", () => {
    expect({
      "https://rivi.software/": safeHref("https://rivi.software/"),
      "mailto:hello@rivi.software": safeHref("mailto:hello@rivi.software"),
      "/mail/t/th_1": safeHref("/mail/t/th_1"),
      script: safeHref(["javascript", "alert(1)"].join(":")),
      "//evil.example/": safeHref("//evil.example/"),
      "data:text/html,hi": safeHref("data:text/html,hi"),
    }).toStrictEqual({
      "https://rivi.software/": "https://rivi.software/",
      "mailto:hello@rivi.software": "mailto:hello@rivi.software",
      "/mail/t/th_1": "/mail/t/th_1",
      script: null,
      "//evil.example/": null,
      "data:text/html,hi": null,
    });
  });

  it("parses the shapes the models write", () => {
    const blocks = parseMarkdown(
      "## Today\n\nTwo things came in:\n\n- [Quarterly plan](/mail/t/th_1) from Jane\n- A `note`\n\n1. first\n2. second\n\n```sh\npnpm run dev\n```\n\n| Name | Size |\n|---|---|\n| notes.txt | 1 KB |\n\n> quoted\n\n---\nDone."
    );

    expect(blocks.map((b) => b.kind)).toStrictEqual([
      "h",
      "p",
      "ul",
      "ol",
      "code",
      "table",
      "quote",
      "hr",
      "p",
    ]);
    expect(blocks[2]).toMatchObject({
      items: ["[Quarterly plan](/mail/t/th_1) from Jane", "A `note`"],
    });
    expect(blocks[4]).toMatchObject({ lang: "sh", text: "pnpm run dev" });
    expect(blocks[5]).toMatchObject({
      rows: [
        ["Name", "Size"],
        ["notes.txt", "1 KB"],
      ],
    });
  });

  // Rendering emphasis or a link label once sent the inline parser back to the same match, forever (CORE-1295).
  it("renders emphasis, code and links, the labels inside them too", () => {
    expect(
      renderMarkdown(
        "A **bold** and *quiet* word, `code`, __strong__ and _soft_: see [the *plan*](/mail/t/th_1) or https://rivi.software/."
      )
    ).toBe(
      '<div><p>A <strong>bold</strong> and <em>quiet</em> word, <code>code</code>, <strong>strong</strong> and <em>soft</em>: see <a href="/mail/t/th_1">the <em>plan</em></a> or <a href="https://rivi.software/" target="_blank" rel="noopener noreferrer">https://rivi.software/</a>.</p></div>'
    );
    expect(
      renderMarkdown(
        "- **Jane** wrote [twice](/mail/t/th_2)\n\n| *File* |\n|---|\n| __a__ |"
      )
    ).toBe(
      '<div><ul><li><strong>Jane</strong> wrote <a href="/mail/t/th_2">twice</a></li></ul><div><table><tbody><tr><th><em>File</em></th></tr><tr><td><strong>a</strong></td></tr></tbody></table></div></div>'
    );
  });
});
