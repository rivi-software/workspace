import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";

import type { Database } from "~/db";
import type { User } from "~/db/schema";
import { reachFile } from "~/lib/drive/access.server";
import { nodeHref } from "~/lib/drive/drive";
import type { DriveRow } from "~/lib/drive/drive";
import { listView } from "~/lib/drive/drive.server";
import { formatAddress } from "~/lib/mail/addresses";
import {
  conversationFile,
  findConversations,
  readConversation,
  writeDraft,
} from "~/lib/mail/mail.server";
import type { ConversationSummary } from "~/lib/mail/mail.server";
import { participantLabel } from "~/lib/mail/threading";
import { truncate } from "~/lib/text";

import { organizeTools } from "./organize-tools.server";
import { plannerTools } from "./planner-tools.server";
import { fileText } from "./reading.server";
import { filesByMeaning, mailByMeaning } from "./search.server";
import type { FilesByMeaning } from "./search.server";
import type { AskContext } from "./time";

/** At most this many rows a search answers. */
const MAX_RESULTS = 20;

/** At most this many messages of a conversation, the newest. */
const MAX_MESSAGES = 20;

/** Each message's own words, cut at this length. */
const MAX_MESSAGE_CHARS = 4000;

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

/** What a search of Drive by meaning says beside its results: that it fell back to names, or whose files it left out. */
const driveNote = (
  asked: boolean,
  meant: FilesByMeaning | null
): string | undefined => {
  if (!asked) {
    return;
  }

  if (!meant) {
    return "The search by meaning is not available here, so this searched the names.";
  }

  return meant.unsearched
    ? `Files shared by ${meant.unsearched} more ${meant.unsearched === 1 ? "colleague" : "colleagues"} were not searched by meaning: search those by name.`
    : undefined;
};

/**
 * What the assistant can do for a person, each gated as the pages are: it reads only this person's mail, what they
 * may reach in Drive and their own calendar and tasks, and what it writes is a draft the person sends themselves,
 * a to-do or an event of their own (`plannerTools`), and how their conversations are filed (`organizeTools`). `asked` is when and in which zone the question came.
 */
export const assistantTools = (
  env: Env,
  db: Database,
  user: User,
  asked: AskContext
): ToolSet => ({
  ...plannerTools(env, db, user, asked),
  ...organizeTools(env, db, user, asked),

  search_mail: tool({
    description:
      "Search the person's mail, or list a folder newest first with an empty query. Two ways to search, which go together: `query` is the search box's language (words and quoted phrases that the mail must hold, from:, to:, subject:, has:attachment, is:unread, is:starred, is:read, label:, before:YYYY-MM-DD, after:YYYY-MM-DD, any of them negated with a minus), and `about` finds conversations by what they are about, in the person's own words, when the exact words in the mail are not known (“the dispute over the transmitter invoice”). Answers conversations with their id, subject, people, a snippet, the last message's time and a link; `foundBy` says whether one was found by its meaning or its words.",
    inputSchema: z.object({
      query: z
        .string()
        .max(200)
        .default("")
        .describe("The search; empty lists the folder."),
      about: z
        .string()
        .max(300)
        .optional()
        .describe(
          "What the mail is about, in plain words: found by meaning. All mail outside Spam and the trash."
        ),
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
    execute: async ({ query, about, folder, limit }) => {
      const byMeaning = about?.trim()
        ? await mailByMeaning(env, db, user.id, about, limit)
        : null;

      // The words are searched too when there are any, and in place of the meaning where this Worker has no index.
      // A question by meaning alone that found nothing answers nothing: an empty search would list the folder.
      const words = query.trim() || (byMeaning ? "" : (about ?? "").trim());

      const byWords =
        words || !about?.trim()
          ? await findConversations(db, user.id, { folder, q: words, limit })
          : [];

      const seen = new Set(byMeaning?.map((t) => t.id));

      const rows = [
        ...(byMeaning ?? []).map((t) => ({ t, foundBy: "meaning" })),
        ...byWords
          .filter((t) => !seen.has(t.id))
          .map((t) => ({ t, foundBy: "words" })),
      ].slice(0, limit);

      return {
        count: rows.length,
        // Said when the person asked by meaning and this Worker has no index to ask.
        note:
          about && byMeaning === null
            ? "The search by meaning is not available here, so this searched the words."
            : undefined,
        conversations: rows.map(({ t, foundBy }) => ({
          ...threadSummary(t),
          foundBy: about ? foundBy : undefined,
        })),
      };
    },
  }),

  read_conversation: tool({
    description:
      "Read the messages of one conversation (a thread id from search_mail, th_…): who wrote what and when, each message's own words without the quoted earlier mail or the signature, and the names of its files, which read_attachment reads. Read a conversation before summarising it or answering it.",
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
      "Find folders and files in the person's Drive and in what is shared with them. `query` finds by the words in their names; `about` finds files by what they are about, name and contents, in the person's own words (“the contract with the transmitter supplier”); an empty search lists the files they worked on last. Answers each item's id, kind, name, type, size, time, owner and link; `foundBy` says whether one was found by its meaning or its name.",
    inputSchema: z.object({
      query: z
        .string()
        .max(200)
        .default("")
        .describe("Words of the name; empty for the recent files."),
      about: z
        .string()
        .max(300)
        .optional()
        .describe("What the file is about, in plain words: found by meaning."),
      limit: z.number().int().min(1).max(MAX_RESULTS).default(10),
    }),
    execute: async ({ query, about, limit }) => {
      const q = query.trim();

      const meant = about?.trim()
        ? await filesByMeaning(env, db, user.id, about, limit)
        : null;

      const byMeaning = meant?.rows ?? null;

      // The names are searched too when there are words for them, and in place of the meaning where this Worker has
      // no index. A question by meaning alone that found nothing answers nothing, not the recent files.
      const words = q || (byMeaning ? "" : (about ?? "").trim());

      const byName =
        words || !about?.trim()
          ? await listView(db, user.id, words ? { search: words } : "recent", {
              sort: "updated",
              dir: "desc",
            })
          : [];

      const seen = new Set(byMeaning?.map((row) => row.id));

      const rows = [
        ...(byMeaning ?? []).map((row) => ({ row, foundBy: "meaning" })),
        ...byName
          .filter((row) => !seen.has(row.id))
          .map((row) => ({ row, foundBy: "name" })),
      ].slice(0, limit);

      return {
        count: rows.length,
        note: driveNote(Boolean(about), meant),
        items: rows.map(({ row, foundBy }) => ({
          ...driveSummary(row),
          foundBy: about ? foundBy : undefined,
        })),
      };
    },
  }),

  read_file: tool({
    description:
      "Read a file in Drive (a file id from search_drive, dn_…): a text file (plain text, Markdown, CSV, JSON, code), a PDF, a Word or OpenDocument text, or a spreadsheet (Excel, OpenDocument, Numbers). Images, presentations and other kinds cannot be read: say so and give the link. A long file is cut off, and `truncated` says so.",
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

      const read = await fileText(env, node, async () => {
        const object = await env.DRIVE.get(file.key);

        return object ? await object.arrayBuffer() : null;
      });

      if ("error" in read) {
        return { error: read.error, name: node.name, link };
      }

      return {
        id: node.id,
        name: node.name,
        contentType: node.contentType,
        size: node.size,
        link,
        ...read,
      };
    },
  }),

  read_attachment: tool({
    description:
      "Read a file attached to a message in the person's mail: the conversation's id (th_…) and the file's name as read_conversation lists it under `files`. Reads what read_file reads: text files, PDFs, Word and OpenDocument texts and spreadsheets. When several messages of the conversation carry a file of that name, it is the newest.",
    inputSchema: z.object({
      conversationId: z.string().describe("The conversation's id (th_…)."),
      name: z.string().min(1).max(300).describe("The file's name."),
    }),
    execute: async ({ conversationId, name }) => {
      const file = await conversationFile(
        env,
        db,
        user.id,
        conversationId,
        name
      );

      if (!file) {
        return {
          error: "No such file in that conversation of this mailbox.",
        };
      }

      const read = await fileText(env, file, file.load);

      if ("error" in read) {
        return { error: read.error, name: file.name, link: file.link };
      }

      return {
        name: file.name,
        contentType: file.contentType,
        size: file.size,
        link: file.link,
        ...read,
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
