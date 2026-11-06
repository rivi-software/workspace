import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";

import type { Database } from "~/db";
import type { User } from "~/db/schema";
import { reachFile } from "~/lib/drive/access.server";
import { fileKind, nodeHref } from "~/lib/drive/drive";
import type { DriveRow } from "~/lib/drive/drive";
import { listView } from "~/lib/drive/drive.server";
import { formatAddress } from "~/lib/mail/addresses";
import {
  findConversations,
  readConversation,
  writeDraft,
} from "~/lib/mail/mail.server";
import type { ConversationSummary } from "~/lib/mail/mail.server";
import { participantLabel } from "~/lib/mail/threading";
import { truncate } from "~/lib/text";

/** At most this many rows a search answers. */
const MAX_RESULTS = 20;

/** At most this many messages of a conversation, the newest. */
const MAX_MESSAGES = 20;

/** Each message's own words, cut at this length. */
const MAX_MESSAGE_CHARS = 4000;

/** A file read whole up to this size, and cut at this many characters. */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILE_CHARS = 20_000;

const threadSummary = (t: ConversationSummary) => ({
  id: t.id,
  subject: t.subject,
  people: participantLabel(t.people) || "me",
  snippet: t.snippet,
  lastMessageAt: t.lastMessageAt,
  messages: t.messageCount,
  unread: t.unreadCount,
  starred: t.starred,
  folder: t.folder,
  link: t.link,
});

const driveSummary = (row: DriveRow) => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  contentType: row.contentType,
  size: row.size,
  updatedAt: row.updatedAt,
  owner: row.owner.name,
  link: nodeHref(row),
});

/** Whether a file's contents read as text: what the file page shows as text or code, and the structured formats. */
const readsAsText = (contentType: string, name: string): boolean => {
  const kind = fileKind(contentType, name, "file");

  if (kind === "text" || kind === "code") {
    return true;
  }

  return /^(?:text\/|application\/(?:json|xml|yaml|x-yaml|csv|sql|javascript|typescript|x-sh))/iu.test(
    contentType
  );
};

/**
 * What the assistant can do for a person, each gated as the pages are: it reads only this person's mail and what
 * they may reach in Drive, and the one thing it writes is a draft the person sends themselves.
 */
export const assistantTools = (
  env: Env,
  db: Database,
  user: User
): ToolSet => ({
  search_mail: tool({
    description:
      "Search the person's mail, or list a folder newest first with an empty query. The query is the search box's language: words and quoted phrases, from:, to:, subject:, has:attachment, is:unread, is:starred, is:read, label:, before:YYYY-MM-DD, after:YYYY-MM-DD, any of them negated with a minus. Answers conversations with their id, subject, people, a snippet, the last message's time and a link.",
    inputSchema: z.object({
      query: z
        .string()
        .max(200)
        .default("")
        .describe("The search; empty lists the folder."),
      folder: z
        .enum([
          "inbox",
          "starred",
          "snoozed",
          "sent",
          "archive",
          "spam",
          "trash",
        ])
        .default("archive")
        .describe(
          "Where to look. archive is All mail (everything but spam and trash; the default), inbox what sits in the inbox now, sent what the person sent."
        ),
      limit: z.number().int().min(1).max(MAX_RESULTS).default(10),
    }),
    execute: async ({ query, folder, limit }) => {
      const rows = await findConversations(db, user.id, {
        folder,
        q: query,
        limit,
      });

      return { count: rows.length, conversations: rows.map(threadSummary) };
    },
  }),

  read_conversation: tool({
    description:
      "Read the messages of one conversation (a thread id from search_mail, th_…): who wrote what and when, each message's own words without the quoted earlier mail or the signature, and the names of its files. Read a conversation before summarising it or answering it.",
    inputSchema: z.object({
      conversationId: z.string().describe("The conversation's id (th_…)."),
    }),
    execute: async ({ conversationId }) => {
      const thread = await readConversation(db, user.id, conversationId);

      if (!thread) {
        return { error: "No such conversation in this mailbox." };
      }

      const shown = thread.messages.slice(-MAX_MESSAGES);

      return {
        id: thread.id,
        subject: thread.subject,
        folder: thread.folder,
        labels: thread.labels,
        link: thread.link,
        omitted: thread.messages.length - shown.length,
        messages: shown.map((m) => ({
          id: m.id,
          direction: m.direction,
          from: formatAddress(m.from),
          to: m.to.map(formatAddress),
          cc: m.cc.map(formatAddress),
          date: m.date,
          text: truncate(m.text, MAX_MESSAGE_CHARS),
          files: m.files,
        })),
      };
    },
  }),

  search_drive: tool({
    description:
      "Find folders and files in the person's Drive and in what is shared with them, by the words in their names; an empty query lists the files they worked on last. Answers each item's id, kind, name, type, size, time, owner and link.",
    inputSchema: z.object({
      query: z
        .string()
        .max(200)
        .default("")
        .describe("Words of the name; empty for the recent files."),
      limit: z.number().int().min(1).max(MAX_RESULTS).default(10),
    }),
    execute: async ({ query, limit }) => {
      const q = query.trim();

      const rows = await listView(db, user.id, q ? { search: q } : "recent", {
        sort: "updated",
        dir: "desc",
      });

      return {
        count: rows.length,
        items: rows.slice(0, limit).map(driveSummary),
      };
    },
  }),

  read_file: tool({
    description:
      "Read a text file in Drive (a file id from search_drive, dn_…): plain text, Markdown, CSV, JSON, code. Other kinds (images, PDFs, Office documents) cannot be read; say so and give the link.",
    inputSchema: z.object({
      fileId: z.string().describe("The file's id (dn_…)."),
    }),
    execute: async ({ fileId }) => {
      // Out of the trash: the Assistant reads what the person's pages list.
      const file = await reachFile(db, user.id, fileId, "outside");

      if (!file) {
        return { error: "No such file, or it is out of reach." };
      }

      const { node } = file;
      const link = nodeHref(node);

      if (!readsAsText(node.contentType, node.name)) {
        return {
          error: `“${node.name}” is ${node.contentType}, which cannot be read as text.`,
          name: node.name,
          link,
        };
      }

      if (node.size > MAX_FILE_BYTES) {
        return {
          error: `“${node.name}” is too large to read (${Math.round(node.size / 1024)} KB).`,
          name: node.name,
          link,
        };
      }

      const object = await env.DRIVE.get(file.key);

      if (!object) {
        return {
          error: "The file's contents are missing.",
          name: node.name,
          link,
        };
      }

      const text = await object.text();

      return {
        id: node.id,
        name: node.name,
        contentType: node.contentType,
        size: node.size,
        link,
        truncated: text.length > MAX_FILE_CHARS,
        text: text.slice(0, MAX_FILE_CHARS),
      };
    },
  }),

  create_draft: tool({
    description:
      "Prepare a message in the person's Drafts for them to review and send from the composer; nothing is sent. Either a reply to a conversation (its last message from someone else is answered, with the original quoted) or a new message to the recipients given. The body is plain text in the person's voice, paragraphs separated by blank lines, without a greeting line to be filled in later, a signature or a quoted original: the signature and the quote are added.",
    inputSchema: z.object({
      replyTo: z
        .string()
        .optional()
        .describe(
          "The id of the conversation to reply to (th_…); leave out for a new message."
        ),
      to: z
        .array(z.string())
        .optional()
        .describe(
          "A new message's recipients, as addresses or “Name <address>”."
        ),
      cc: z.array(z.string()).optional(),
      subject: z
        .string()
        .max(200)
        .optional()
        .describe("A new message's subject."),
      body: z.string().min(1).max(20_000),
    }),
    execute: async ({ replyTo, to, cc, subject, body }) => {
      const draft = await writeDraft(
        db,
        user,
        replyTo ? { reply: replyTo, body } : { to: to ?? [], cc, subject, body }
      );

      if (!draft.ok) {
        return { error: draft.error };
      }

      return {
        draftId: draft.draftId,
        to: draft.to,
        subject: draft.subject,
        link: draft.link,
        note: "The draft is in Drafts; the person opens the link to review and send it.",
      };
    },
  }),
});
