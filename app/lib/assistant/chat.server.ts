import { captureServerException } from "@rivi-software/posthog-tanstack-start/server";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
} from "ai";
import type { UIMessage } from "ai";
import { and, desc, eq, sql } from "drizzle-orm";

import type { Database } from "~/db";
import { assistantConversations, assistantMessages } from "~/db/schema";
import type { User } from "~/db/schema";

import { isJsonObject, stringOrNull } from "../guards";
import { newId, nowIso } from "../ids";
import {
  HISTORY_MESSAGES,
  MAX_CONVERSATION_MESSAGES,
  MAX_QUESTION_CHARS,
  conversationTitle,
  toUIMessages,
} from "./assistant";
import type {
  AssistantMessage,
  ConversationRef,
  StoredMessage,
} from "./assistant";
import { assistantModel } from "./provider.server";
import type { AssistantProvider } from "./provider.server";
import { assistantTelemetry } from "./telemetry.server";
import { assistantTools } from "./tools.server";

export class AssistantError extends Error {
  override name = "AssistantError";
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ---------- conversations ---------- */

const refOf = (c: {
  id: string;
  title: string;
  updatedAt: string;
}): ConversationRef => ({
  id: c.id,
  title: c.title,
  updatedAt: c.updatedAt,
});

/** A person's conversations, newest first, for the sidebar. */
export const listConversations = async (
  db: Database,
  userId: string,
  limit = 50
): Promise<ConversationRef[]> => {
  const rows = await db.query.assistantConversations.findMany({
    where: eq(assistantConversations.userId, userId),
    orderBy: [desc(assistantConversations.updatedAt)],
    limit,
  });

  return rows.map(refOf);
};

const ownConversation = async (db: Database, userId: string, id: string) =>
  await db.query.assistantConversations.findFirst({
    where: and(
      eq(assistantConversations.id, id),
      eq(assistantConversations.userId, userId)
    ),
  });

const parseMessage = (row: {
  id: string;
  role: "user" | "assistant";
  partsJson: string;
}): StoredMessage => {
  let parts: StoredMessage["parts"] = [];

  try {
    const parsed: unknown = JSON.parse(row.partsJson);

    if (Array.isArray(parsed)) {
      // SAFETY: `partsJson` is only ever written as JSON.stringify of a UI message's parts (`answerChat`, `store`).
      parts = parsed as StoredMessage["parts"];
    }
  } catch {
    parts = [];
  }

  return { id: row.id, role: row.role, parts };
};

/** The last messages of a conversation, oldest first: what the page shows and what goes to the model. */
const recentMessages = async (
  db: Database,
  conversationId: string,
  limit: number
) => {
  const rows = await db.query.assistantMessages.findMany({
    where: eq(assistantMessages.conversationId, conversationId),
    orderBy: [desc(assistantMessages.createdAt), desc(sql`rowid`)],
    limit,
  });

  return rows.toReversed().map(parseMessage);
};

/** A conversation with its messages, oldest first; null when it is not the person's. */
export const getConversation = async (
  db: Database,
  userId: string,
  id: string
) => {
  const conversation = await ownConversation(db, userId, id);

  if (!conversation) {
    return null;
  }

  return {
    conversation: refOf(conversation),
    messages: await recentMessages(db, id, MAX_CONVERSATION_MESSAGES),
  };
};

/** Delete a conversation with its messages; false when it is not the person's. */
export const deleteConversation = async (
  db: Database,
  userId: string,
  id: string
): Promise<boolean> => {
  const conversation = await ownConversation(db, userId, id);

  if (!conversation) {
    return false;
  }

  await db
    .delete(assistantMessages)
    .where(eq(assistantMessages.conversationId, id));
  await db
    .delete(assistantConversations)
    .where(eq(assistantConversations.id, id));

  return true;
};

const countMessages = async (
  db: Database,
  conversationId: string
): Promise<number> => {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, conversationId));

  return Number(row?.n ?? 0);
};

/* ---------- a turn ---------- */

export interface ChatInput {
  /** The conversation the question continues; null starts one. */
  conversationId: string | null;
  /** The person's message as the page sent it: a UI message with text parts. */
  message: unknown;
}

export interface ChatAnswer {
  /** The answer as a UI message stream (server-sent events), for the page. */
  response: Response;
  conversationId: string;
  /** Settles once the answer is stored, after the stream ended: the route keeps the Worker alive for it. */
  done: Promise<void>;
}

interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** The person's question out of what the page posted, or an error for anything else. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the page posts whatever it likes: only a person's text parts are taken from it
const questionOf = (message: unknown): string => {
  if (
    !isJsonObject(message) ||
    message.role !== "user" ||
    !Array.isArray(message.parts)
  ) {
    throw new AssistantError("Expected a message from the person.");
  }

  const parts: unknown[] = message.parts;

  const text = parts
    .flatMap((p) =>
      isJsonObject(p) && p.type === "text" ? (stringOrNull(p.text) ?? []) : []
    )
    .join("\n")
    .trim();

  if (!text) {
    throw new AssistantError("Write a question first.");
  }

  if (text.length > MAX_QUESTION_CHARS) {
    throw new AssistantError(
      `A question is at most ${MAX_QUESTION_CHARS} characters.`
    );
  }

  return text;
};

const systemPrompt = (user: User, provider: AssistantProvider): string => {
  const today = new Date().toISOString().slice(0, 10);

  return [
    `You are the Assistant in Workspace, the internal workspace of RIVI Software. You help ${user.name} (${user.email}) with their mail (Mail) and their files (Drive).`,
    `Today is ${today} (UTC).`,
    "",
    "Rules:",
    "- Look things up with the tools before answering about mail, people, dates or files; never make up a message, a person or a file. When a search finds nothing, say so and suggest another search.",
    "- Keep to what the tools answered. Name a conversation, a file or a draft with a Markdown link on the `link` the tool gave (a path on this site), with a short label such as its subject or name.",
    "- You cannot send mail or change anything in Mail or Drive. create_draft only prepares a message; tell the person it waits in Drafts and give the link, so they review and send it.",
    "- Answer in the language the person writes in. Be brief and concrete: short paragraphs, a list for several items, no headings unless the answer is long, no preamble.",
    "- A draft is written in the person's own voice, plain and polite, without a signature (one is added) and without quoting the original (it is added).",
    provider === "mock" ? "- You are the mock model: answer in one line." : "",
  ]
    .filter(Boolean)
    .join("\n");
};

/**
 * Answer a question: file it in its conversation (a new one when none is named), run the model over the recent
 * messages with the tools, stream the answer to the page as it comes and store it once it is whole.
 */
export const answerChat = async (
  env: Env,
  db: Database,
  user: User,
  input: ChatInput,
  signal?: AbortSignal
): Promise<ChatAnswer> => {
  const text = questionOf(input.message);
  const now = nowIso();
  let conversation: ConversationRef;

  if (input.conversationId) {
    const existing = await ownConversation(db, user.id, input.conversationId);

    if (!existing) {
      throw new AssistantError("No such conversation.", 404);
    }

    if ((await countMessages(db, existing.id)) >= MAX_CONVERSATION_MESSAGES) {
      throw new AssistantError(
        "This conversation is at its end; start a new one."
      );
    }

    conversation = refOf(existing);
  } else {
    const id = newId("ac");
    await db.insert(assistantConversations).values({
      id,
      userId: user.id,
      title: conversationTitle(text),
      createdAt: now,
      updatedAt: now,
    });
    conversation = { id, title: conversationTitle(text), updatedAt: now };
  }

  const history = toUIMessages(
    await recentMessages(db, conversation.id, HISTORY_MESSAGES)
  );

  const question: AssistantMessage = {
    id: newId("am"),
    role: "user",
    parts: [{ type: "text", text }],
  };

  await db.insert(assistantMessages).values({
    id: question.id,
    conversationId: conversation.id,
    userId: user.id,
    role: "user",
    partsJson: JSON.stringify(question.parts),
    createdAt: now,
  });
  await db
    .update(assistantConversations)
    .set({ updatedAt: now })
    .where(eq(assistantConversations.id, conversation.id));

  const { model, modelId, provider } = assistantModel(env);
  const originalMessages = [...history, question];
  let usage: TokenUsage = {};
  const tools = assistantTools(env, db, user);

  const result = streamText({
    model,
    instructions: systemPrompt(user, provider),
    messages: await convertToModelMessages(originalMessages),
    tools,
    stopWhen: stepCountIs(8),
    abortSignal: signal,
    // A trace per turn in PostHog AI observability, under the conversation and the person.
    ...assistantTelemetry({
      conversationId: conversation.id,
      distinctId: user.id,
    }),
    // Every step's tokens together, kept for the answer's row.
    onEnd: (end) => {
      usage = {
        inputTokens: end.usage.inputTokens,
        outputTokens: end.usage.outputTokens,
      };
    },
    onError: ({ error }) => {
      console.error("assistant.error", {
        conversation: conversation.id,
        error: String(error),
      });
      captureServerException(error, {
        distinctId: user.id,
        properties: { handler: "assistant", stage: "model", model: modelId },
      });
    },
  });

  // oxlint-disable-next-line typescript/no-invalid-void-type -- the promise carries no value: `done` is the `Promise<void>` of `ChatAnswer` and `settle()` takes no argument
  const { promise: done, resolve: settle } = Promise.withResolvers<void>();

  // A page that went away ends the stream without its finish; give the store a moment, then let the Worker go.
  signal?.addEventListener(
    "abort",
    () => {
      setTimeout(settle, 3000);
    },
    { once: true }
  );

  const store = async (message: UIMessage | undefined) => {
    if (!message?.parts.length) {
      return;
    }

    const at = nowIso();
    await db
      .insert(assistantMessages)
      .values({
        id: message.id || newId("am"),
        conversationId: conversation.id,
        userId: user.id,
        role: "assistant",
        partsJson: JSON.stringify(message.parts),
        model: modelId,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        createdAt: at,
      })
      .onConflictDoNothing();
    await db
      .update(assistantConversations)
      .set({ updatedAt: at })
      .where(eq(assistantConversations.id, conversation.id));
  };

  const stream = toUIMessageStream<typeof tools, AssistantMessage>({
    stream: result.stream,
    tools,
    originalMessages,
    generateMessageId: () => newId("am"),
    messageMetadata: ({ part }) =>
      part.type === "start" ? { conversationId: conversation.id } : undefined,
    // Awaited before the stream closes, so the answer is stored before the Worker may go (`done`).
    onEnd: async ({ responseMessage }) => {
      try {
        await store(responseMessage);
      } catch (error) {
        console.error("assistant.store", {
          conversation: conversation.id,
          error: String(error),
        });
        captureServerException(error, {
          distinctId: user.id,
          properties: { handler: "assistant", stage: "store" },
        });
      } finally {
        settle();
      }
    },
    onError: (error) => {
      console.error("assistant.stream", {
        conversation: conversation.id,
        error: String(error),
      });

      return "The assistant could not answer. Try again in a moment.";
    },
  });

  const response = createUIMessageStreamResponse({ stream });

  return { response, conversationId: conversation.id, done };
};
