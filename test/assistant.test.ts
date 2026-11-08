import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { drafts } from "~/db/schema";
import type { User } from "~/db/schema";
import {
  conversationTitle,
  isToolPart,
  messageText,
  stepView,
} from "~/lib/assistant/assistant";
import type { Json, StoredPart } from "~/lib/assistant/assistant";
import {
  AssistantError,
  answerChat,
  deleteConversation,
  getConversation,
  listConversations,
} from "~/lib/assistant/chat.server";
import { parseMarkdown, safeHref } from "~/lib/assistant/markdown";
import { finishUpload, startUpload } from "~/lib/drive/drive.server";
import { stringOrNull } from "~/lib/guards";
import { ingestInboundEmail } from "~/lib/mail/ingest.server";

import { db, defined, mail, mailbox, stringContaining } from "./fixtures";
import { renderMarkdown } from "./markdown";

/** A question to the assistant, its answer read to the end (the stream), and the stored turn waited for. */
const ask = async (
  user: User,
  text: string,
  conversationId: string | null = null
) => {
  const answer = await answerChat(env, db, user, {
    conversationId,
    message: { role: "user", parts: [{ type: "text", text }] },
  });

  expect(answer.response.headers.get("content-type")).toContain(
    "text/event-stream"
  );
  const body = await answer.response.text();
  await answer.done;

  const stored = defined(
    await getConversation(db, user.id, answer.conversationId)
  );

  const last = defined(stored.messages.at(-1), "last message");

  return { body, conversationId: answer.conversationId, stored, last };
};

/** A stored part is parsed JSON, so an object in one holds JSON values. */
const isObject = (value: unknown): value is { [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The stored part of the tool `name`, its input and output read as objects (empty when it has none). */
const toolPart = (parts: StoredPart[], name: string) => {
  const part = parts.find((p) => p.type === `tool-${name}`);

  if (!part || !isToolPart(part)) {
    return null;
  }

  const { input, output } = part;

  return {
    ...part,
    input: isObject(input) ? input : {},
    output: isObject(output) ? output : {},
  };
};

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

describe("the assistant", () => {
  let ann: User;
  let bo: User;
  beforeAll(async () => {
    ann = await mailbox("ann", "Ann");
    bo = await mailbox("bo", "Bo");
  });

  it("answers a question, keeps the conversation and continues it", async () => {
    const first = await ask(ann, "Hello there, what can you do?");
    expect({
      body: first.body.includes("(mock) I received: Hello there"),
      title: first.stored.conversation.title,
      messagesMap: first.stored.messages.map((m) => m.role),
      messageText: messageText(first.stored.messages[0]),
      messageText2: messageText(first.last).includes("(mock) I received"),
    }).toStrictEqual({
      body: true,
      title: "Hello there, what can you do?",
      messagesMap: ["user", "assistant"],
      messageText: "Hello there, what can you do?",
      messageText2: true,
    });
    const listed = await listConversations(db, ann.id);
    expect(listed.map((c) => c.id)).toContain(first.conversationId);

    const second = await ask(ann, "And again?", first.conversationId);
    expect({
      conversationId: second.conversationId,
      messagesMap: second.stored.messages.map((m) => m.role),
      value:
        second.stored.conversation.updatedAt >=
        first.stored.conversation.updatedAt,
    }).toStrictEqual({
      conversationId: first.conversationId,
      messagesMap: ["user", "assistant", "user", "assistant"],
      value: true,
    });
  });

  it("searches the person's mail through a tool, and only theirs", async () => {
    await stored(ann, {
      subject: "Quarterly plan",
      text: "The plan for the quarter is attached.",
    });
    await stored(bo, { subject: "Secret budget", text: "Bo's own budget." });

    const found = await ask(ann, "Search my mail for quarterly");
    const step = defined(toolPart(found.last.parts, "search_mail"));
    expect({
      state: step.state,
      query: step.input.query,
      count: step.output.count,
      body: found.body.includes("Quarterly plan"),
      messageText: messageText(found.last).includes("search_mail answered"),
    }).toStrictEqual({
      state: "output-available",
      query: "quarterly",
      count: 1,
      body: true,
      messageText: true,
    });
    // The step reads as a line on the page.
    const view = stepView(step);
    expect({ label: view.label, detail: view.detail }).toStrictEqual({
      label: "Searched mail for “quarterly”",
      detail: "1 conversation",
    });

    const missed = await ask(ann, "Search my mail for budget");
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

    const read = await ask(ann, `Read the conversation ${r.threadId}`);
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

    const drafted = await ask(
      ann,
      `Draft a reply to ${r.threadId} saying Friday works, see you then.`
    );

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
    const other = await ask(bo, `Read the conversation ${r.threadId}`);
    expect(
      defined(toolPart(other.last.parts, "read_conversation")).output.error
    ).toContain("No such conversation");
  });

  it("prepares a new message to the addresses given", async () => {
    const drafted = await ask(
      ann,
      "Draft an email to kim@acme.com about The offsite agenda"
    );

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

    const read = await ask(ann, `Read the file ${file.id}`);
    const step = defined(toolPart(read.last.parts, "read_file"));
    expect(step.output.text).toBe("the secret plan\nin two lines");
    expect(stepView(step)).toMatchObject({
      label: "Read “notes.txt”",
      link: `/drive/d/${file.id}`,
    });

    const other = await ask(bo, `Read the file ${file.id}`);
    expect(
      defined(toolPart(other.last.parts, "read_file")).output.error
    ).toContain("No such file");

    const found = await ask(ann, "Find files named notes");
    expect(
      defined(toolPart(found.last.parts, "search_drive")).output.count
    ).toBe(1);
  });

  it("refuses an empty question, one with parts it cannot read, and one not from the person", async () => {
    await expect(
      answerChat(env, db, ann, {
        conversationId: null,
        message: { role: "user", parts: [{ type: "text", text: "   " }] },
      })
    ).rejects.toThrow("Write a question first.");
    // Parts that are no object, or text that is no string, say the same, not a TypeError (a 500).
    await expect(
      answerChat(env, db, ann, {
        conversationId: null,
        message: { role: "user", parts: [null, 7, { type: "text", text: 5 }] },
      })
    ).rejects.toThrow("Write a question first.");
    await expect(
      answerChat(env, db, ann, {
        conversationId: null,
        message: { role: "assistant" },
      })
    ).rejects.toThrow(AssistantError);
  });

  it("refuses another person's conversation, and deletes for the owner only", async () => {
    const mine = await ask(ann, "Mine alone");
    await expect(
      answerChat(env, db, bo, {
        conversationId: mine.conversationId,
        message: { role: "user", parts: [{ type: "text", text: "Let me in" }] },
      })
    ).rejects.toThrow(AssistantError);

    const [boDelete, annConvBefore] = await Promise.all([
      deleteConversation(db, bo.id, mine.conversationId),
      getConversation(db, ann.id, mine.conversationId),
    ]);

    expect({ boDelete, annHasConv: annConvBefore !== null }).toStrictEqual({
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
