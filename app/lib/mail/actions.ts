/**
 * The server functions the mail components call: actions on threads (one or many, with their undo), the folder-wide
 * ones, drafts and their files, sending, contact suggestions, a quick new label, and unsubscribing. Routes import
 * these rather than defining their own, so the list, the thread page and the composer all speak the same way.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/db";
import { messages } from "~/db/schema";
import type { Address } from "~/db/schema";
import { formData, formPost } from "~/lib/forms";
import { field } from "~/lib/guards";
import { appContext } from "~/lib/request.server";

import { parseAddressList } from "./addresses";
import type { AddressList } from "./addresses";
import { composeData, ComposeNotFound } from "./compose.server";
import type { ComposeData, DraftFileView } from "./compose.server";
import { searchContacts } from "./contacts.server";
import {
  FilterError,
  deleteFilter,
  moveFilter,
  saveFilter,
} from "./filters.server";
import { isFolder } from "./folders";
import type { Folder } from "./folders";
import {
  ImageSenderError,
  addImageSender,
  removeImageSender,
} from "./images.server";
import { cancelImport } from "./import/import.server";
import {
  LabelError,
  createLabel,
  deleteLabel,
  updateLabel,
} from "./labels.server";
import { emptyFolder } from "./mailbox.server";
import { parsePreferences } from "./preferences";
import type { MailPreferences } from "./preferences";
import {
  PreferencesError,
  savePreferences,
  saveVacation,
} from "./preferences.server";
import {
  ScheduleError,
  scheduleComposed,
  unscheduleDraft,
} from "./schedule.server";
import {
  SendError,
  addDraftFiles,
  deleteDraft,
  listDraftFiles,
  removeDraftFile,
  saveDraft,
  sendComposed,
  sendMail,
} from "./send.server";
import type { OutgoingFile } from "./send.server";
import { describeSender, senderRuleOf } from "./spam";
import { SpamError, removeSenderRule, setSenderRule } from "./spam.server";
import {
  ThreadActionError,
  applyThreadAction,
  blockConversation,
  markAllRead,
  undoThreadAction,
} from "./threads.server";
import { mailtoParts, parseJsonUnsubscribe } from "./unsubscribe";
import { isThreadIntent } from "./views";

/** The thread ids a form names: `ids` as a JSON array, or `id` once. */
const readIds = (data: FormData): string[] => {
  const raw = field(data, "ids");

  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);

      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      // not JSON: one id per line, below
    }

    return raw.split(/[\s,]+/u).filter(Boolean);
  }

  const one = field(data, "id");

  return one ? [one] : [];
};

export type ThreadsResult =
  /** `undo` puts back what the action changed (`undoAction`); null when there is nothing to put back. */
  | { ok: true; intent: string; count: number; undo: string | null }
  | { ok: false; error: string };

/** One intent on the threads a form names: star, archive, trash, spam, inbox, read, unread, delete, mute, snooze, label. */
export const threadsAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<ThreadsResult> => {
    const { db, env, user } = await appContext();
    const intent = field(data, "intent");

    if (!isThreadIntent(intent)) {
      return { ok: false, error: "Unknown action." };
    }

    try {
      const { undo, count } = await applyThreadAction(
        db,
        env,
        user.id,
        readIds(data),
        {
          intent,
          until: field(data, "until") || null,
          labelId: field(data, "labelId") || null,
        }
      );

      return { ok: true, intent, count, undo };
    } catch (error) {
      if (error instanceof ThreadActionError) {
        return { ok: false, error: error.message };
      }

      throw error;
    }
  });

/** Put back what an earlier action changed, as its sealed `undo` recorded it. */
export const undoAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const { db, env, user } = await appContext();
    const undo = field(data, "undo");

    return { ok: !!undo && (await undoThreadAction(db, env, user.id, undo)) };
  });

/** Everything a view shows read, or the trash or spam folder emptied. */
export const folderAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<{ ok: boolean; count: number }> => {
    const { db, env, user } = await appContext();
    const intent = field(data, "intent");
    const folderValue = field(data, "folder", "inbox");
    const folder: Folder = isFolder(folderValue) ? folderValue : "inbox";

    if (intent === "empty" && (folder === "trash" || folder === "spam")) {
      return { ok: true, count: await emptyFolder(db, env, user.id, folder) };
    }

    if (intent === "read-all") {
      return {
        ok: true,
        count: await markAllRead(db, user.id, {
          folder,
          q: field(data, "q") || undefined,
          label: field(data, "label") || null,
        }),
      };
    }

    return { ok: false, count: 0 };
  });

/** The people whose name or address matches what was typed, for the recipient fields. */
export const suggestContacts = createServerFn({ method: "POST" })
  .validator((d: { q: string }) => ({ q: String(d?.q ?? "").slice(0, 80) }))
  .handler(async ({ data }): Promise<Address[]> => {
    const { db, user } = await appContext();

    return searchContacts(db, user.id, data.q);
  });

/** A label made from the label menu, without leaving the list. */
export const quickLabel = createServerFn({ method: "POST" })
  .validator((d: { name: string; color?: string }) => ({
    name: String(d?.name ?? ""),
    color: d?.color ? String(d.color) : undefined,
  }))
  .handler(async ({ data }) => {
    const { db, user } = await appContext();

    try {
      return { ok: true as const, label: await createLabel(db, user.id, data) };
    } catch (error) {
      if (error instanceof LabelError) {
        return { ok: false as const, error: error.message };
      }

      throw error;
    }
  });

/** What the composer starts from for a reply or forward of a message, or a draft, loaded when the reply box opens. */
export const composePrefill = createServerFn({ method: "POST" })
  .validator(
    (d: {
      draft?: string;
      reply?: string;
      mode?: "reply" | "all" | "forward";
    }) => d
  )
  .handler(async ({ data }): Promise<ComposeData | null> => {
    const { db, user } = await appContext();

    try {
      return await composeData(db, user, data);
    } catch (error) {
      if (error instanceof ComposeNotFound) {
        return null;
      }

      throw error;
    }
  });

interface ComposeFields {
  threadId: string | null;
  inReplyToId: string | null;
  mode: "new" | "reply" | "forward";
  from: string;
  to: AddressList;
  cc: AddressList;
  bcc: AddressList;
  subject: string;
  text: string;
  html: string | null;
  signatureId: string | null;
  /** The composer's Sign and Encrypt switches. */
  pgp: { sign: boolean; encrypt: boolean };
}

const composeFields = (data: FormData, fallbackFrom: string): ComposeFields => {
  const mode = field(data, "mode", "new");

  return {
    threadId: field(data, "threadId") || null,
    inReplyToId: field(data, "inReplyToId") || null,
    mode: mode === "reply" || mode === "forward" ? mode : "new",
    from: field(data, "from", fallbackFrom).toLowerCase(),
    to: parseAddressList(field(data, "to")),
    cc: parseAddressList(field(data, "cc")),
    bcc: parseAddressList(field(data, "bcc")),
    subject: field(data, "subject"),
    text: field(data, "text"),
    html: field(data, "html") || null,
    signatureId: field(data, "signatureId") || null,
    pgp: {
      sign: field(data, "pgpSign") === "on",
      encrypt: field(data, "pgpEncrypt") === "on",
    },
  };
};

const uploadedFiles = async (data: FormData): Promise<OutgoingFile[]> => {
  const files: OutgoingFile[] = [];

  for (const f of data.getAll("files")) {
    if (!(f instanceof File) || !f.size) {
      continue;
    }

    files.push({
      filename: f.name,
      contentType: f.type || "application/octet-stream",
      // oxlint-disable-next-line eslint/no-await-in-loop -- files are read one at a time, so one is in memory at once
      content: await f.arrayBuffer(),
    });
  }

  return files;
};

const fileView = (f: {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}) => ({
  id: f.id,
  filename: f.filename,
  contentType: f.contentType,
  size: f.size,
});

export type DraftResult =
  | {
      ok: true;
      draftId: string | null;
      savedAt: string;
      files: DraftFileView[];
    }
  | { ok: false; error: string };

/** The files kept on a draft, as the composer shows them. */
const draftFileViews = async (
  db: Database,
  userId: string,
  draftId: string
): Promise<DraftFileView[]> => {
  const files = await listDraftFiles(db, userId, draftId);

  return files.map(fileView);
};

/**
 * The draft behind a composer: `save` writes what it holds (the autosave and "Save draft"), `files` keeps files on
 * it (making the draft first when there is none), `remove-file` drops one, `discard` deletes it.
 */
export const draftAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<DraftResult> => {
    const { db, env, user } = await appContext();
    const intent = field(data, "intent", "save");
    let draftId = field(data, "draftId") || null;
    const savedAt = new Date().toISOString();

    try {
      if (intent === "discard") {
        if (draftId) {
          await deleteDraft(db, env, user.id, draftId);
        }

        return { ok: true, draftId: null, savedAt, files: [] };
      }

      if (intent === "remove-file") {
        await removeDraftFile(db, env, user.id, field(data, "fileId"));

        return {
          ok: true,
          draftId,
          savedAt,
          files: draftId ? await draftFileViews(db, user.id, draftId) : [],
        };
      }

      const f = composeFields(data, user.email);
      draftId = await saveDraft(db, user.id, {
        id: draftId,
        threadId: f.threadId,
        inReplyToId: f.inReplyToId,
        mode: f.mode,
        from: f.from,
        to: f.to.addresses,
        cc: f.cc.addresses,
        bcc: f.bcc.addresses,
        subject: f.subject,
        text: f.text,
        html: f.html,
        signatureId: f.signatureId,
        pgp: f.pgp,
      });

      if (intent === "files") {
        await addDraftFiles(
          db,
          env,
          user.id,
          draftId,
          await uploadedFiles(data)
        );
      }

      return {
        ok: true,
        draftId,
        savedAt,
        files: await draftFileViews(db, user.id, draftId),
      };
    } catch (error) {
      if (error instanceof SendError) {
        return { ok: false, error: error.message };
      }

      throw error;
    }
  });

export type SendResult =
  | { ok: true; threadId: string }
  | { ok: false; error: string };

/** Send what the composer holds: the draft's files and any uploaded with the form go with it; the draft is then gone. */
export const sendAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<SendResult> => {
    const { db, env, user } = await appContext();

    try {
      const sent = await sendComposed(env, db, user, {
        ...composeFields(data, user.email),
        draftId: field(data, "draftId") || null,
        files: await uploadedFiles(data),
      });

      return { ok: true, threadId: sent.threadId };
    } catch (error) {
      if (error instanceof SendError) {
        return { ok: false, error: error.message };
      }

      throw error;
    }
  });

export type ScheduleResult =
  | { ok: true; draftId: string; scheduledAt: string }
  | { ok: false; error: string };

/**
 * "Send later": what the composer holds, checked as its send will be, saved as its draft and scheduled for `sendAt`
 * (`scheduleComposed`); the cron sends it then.
 */
export const scheduleAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<ScheduleResult> => {
    const { db, env, user } = await appContext();

    try {
      const { draftId, scheduledAt } = await scheduleComposed(env, db, user, {
        ...composeFields(data, user.email),
        draftId: field(data, "draftId") || null,
        sendAt: field(data, "sendAt"),
      });

      return { ok: true, draftId, scheduledAt };
    } catch (error) {
      if (error instanceof ScheduleError || error instanceof SendError) {
        return { ok: false, error: error.message };
      }

      throw error;
    }
  });

/** "Cancel send": a scheduled message becomes a draft again, to be opened in the composer. */
export const unscheduleAction = createServerFn({ method: "POST" })
  .validator((d: { draftId: string }) => ({
    draftId: String(d?.draftId ?? ""),
  }))
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const { db, user } = await appContext();

    return { ok: await unscheduleDraft(db, user.id, data.draftId) };
  });

export type UnsubscribeResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/**
 * Leave the mailing a message came from, the way its sender offered: the one-click POST to its link, else a mail to
 * its address. A plain web link is opened by the browser, not here.
 */
export const unsubscribeAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<UnsubscribeResult> => {
    const { db, env, user } = await appContext();

    const m = await db.query.messages.findFirst({
      where: and(
        eq(messages.id, field(data, "messageId")),
        eq(messages.userId, user.id)
      ),
    });

    const ways = parseJsonUnsubscribe(m?.listUnsubscribe);

    if (!m || !ways) {
      return { ok: false, error: "This message offers no way to unsubscribe." };
    }

    if (ways.oneClick && ways.http && /^https:\/\//iu.test(ways.http)) {
      try {
        const res = await fetch(ways.http, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
          redirect: "manual",
        });

        if (res.ok || (res.status >= 300 && res.status < 400)) {
          return {
            ok: true,
            message: "Unsubscribed. The sender was told to stop.",
          };
        }
      } catch {
        // fall through to the mail, when there is one
      }
    }

    if (ways.mailto) {
      const parts = mailtoParts(ways.mailto);

      if (parts) {
        try {
          await sendMail(env, db, user, {
            from: user.email,
            to: [{ email: parts.to, name: null }],
            cc: [],
            bcc: [],
            subject: parts.subject,
            text: parts.body || "Unsubscribe",
            files: [],
          });

          return {
            ok: true,
            message: `Unsubscribe request sent to ${parts.to}.`,
          };
        } catch (error) {
          if (error instanceof SendError) {
            return { ok: false, error: error.message };
          }

          throw error;
        }
      }
    }

    return {
      ok: false,
      error: "The sender's unsubscribe link has to be opened in the browser.",
    };
  });

export type SenderResult =
  | { ok: true; message: string; moved: boolean }
  | { ok: false; error: string };

/**
 * Block a message's sender from its menu, or unblock them: their mail goes to Spam from now on, and so does the
 * conversation (`threadId`) when everything others sent in it is theirs. Or, from "Load images", always load the
 * images of their mail.
 */
export const senderAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<SenderResult> => {
    const { db, user } = await appContext();
    const intent = field(data, "intent");

    try {
      if (intent === "unblock") {
        const sender =
          senderRuleOf(field(data, "sender")) ?? field(data, "sender");

        await removeSenderRule(db, user.id, sender);

        return {
          ok: true,
          message: `Unblocked ${describeSender(sender)}.`,
          moved: false,
        };
      }

      if (intent === "block") {
        const sender = await setSenderRule(
          db,
          user.id,
          field(data, "sender"),
          "block"
        );

        const threadId = field(data, "threadId");

        const moved = threadId
          ? await blockConversation(db, user.id, threadId, sender)
          : false;

        return {
          ok: true,
          message: `Blocked ${describeSender(sender)}: their mail goes to Spam from now on.`,
          moved,
        };
      }

      if (intent === "images") {
        const sender = await addImageSender(db, user.id, field(data, "sender"));

        return {
          ok: true,
          message: `Images from ${describeSender(sender)} load from now on.`,
          moved: false,
        };
      }

      return { ok: false, error: "Unknown action." };
    } catch (error) {
      if (error instanceof SpamError || error instanceof ImageSenderError) {
        return { ok: false, error: error.message };
      }

      throw error;
    }
  });

export type SettingsResult =
  | { ok: true; message?: string }
  | { ok: false; error: string };

interface SettingsCall {
  db: Database;
  userId: string;
  data: FormData;
}

/** The label intents of Settings → Mail; null for any other intent. */
const labelIntent = async (
  intent: string,
  { db, userId, data }: SettingsCall
): Promise<SettingsResult | null> => {
  switch (intent) {
    case "label-create": {
      await createLabel(db, userId, {
        name: field(data, "name"),
        color: field(data, "color"),
      });

      return { ok: true };
    }

    case "label-update": {
      await updateLabel(db, userId, field(data, "id"), {
        name: data.has("name") ? field(data, "name") : undefined,
        color: data.has("color") ? field(data, "color") : undefined,
      });

      return { ok: true };
    }

    case "label-delete": {
      await deleteLabel(db, userId, field(data, "id"));

      return { ok: true };
    }

    default: {
      return null;
    }
  }
};

/** The filter intents of Settings → Mail; null for any other intent. */
const filterIntent = async (
  intent: string,
  { db, userId, data }: SettingsCall
): Promise<SettingsResult | null> => {
  const on = (name: string) => field(data, name) === "on";

  switch (intent) {
    case "filter-save": {
      await saveFilter(db, userId, {
        id: field(data, "id") || null,
        conditions: {
          from: field(data, "from"),
          to: field(data, "to"),
          subject: field(data, "subject"),
          words: field(data, "words"),
          hasAttachment: on("hasAttachment"),
        },
        actions: {
          skipInbox: on("skipInbox"),
          markRead: on("markRead"),
          star: on("star"),
          labelId: field(data, "labelId") || null,
          trash: on("trash"),
          spam: on("spam"),
          neverSpam: on("neverSpam"),
        },
      });

      return { ok: true };
    }

    case "filter-delete": {
      await deleteFilter(db, userId, field(data, "id"));

      return { ok: true };
    }

    case "filter-move": {
      await moveFilter(
        db,
        userId,
        field(data, "id"),
        field(data, "direction") === "up" ? "up" : "down"
      );

      return { ok: true };
    }

    default: {
      return null;
    }
  }
};

/** The sender intents (blocked, allowed, images) of Settings → Mail; null for any other intent. */
const senderIntent = async (
  intent: string,
  { db, userId, data }: SettingsCall
): Promise<SettingsResult | null> => {
  switch (intent) {
    case "sender-block":
    case "sender-allow": {
      const verdict = intent === "sender-block" ? "block" : "allow";

      const sender = await setSenderRule(
        db,
        userId,
        field(data, "sender"),
        verdict
      );

      return {
        ok: true,
        message:
          verdict === "block"
            ? `Blocked ${describeSender(sender)}.`
            : `Mail from ${describeSender(sender)} never goes to Spam.`,
      };
    }

    case "sender-remove": {
      await removeSenderRule(db, userId, field(data, "sender"));

      return { ok: true };
    }

    case "image-sender-add": {
      const sender = await addImageSender(db, userId, field(data, "sender"));

      return {
        ok: true,
        message: `Images from ${describeSender(sender)} load from now on.`,
      };
    }

    case "image-sender-remove": {
      await removeImageSender(db, userId, field(data, "sender"));

      return { ok: true };
    }

    default: {
      return null;
    }
  }
};

/** The preferences, the responder and the import intents of Settings → Mail; null for any other intent. */
const accountIntent = async (
  intent: string,
  { db, userId, data }: SettingsCall
): Promise<SettingsResult | null> => {
  switch (intent) {
    case "preferences": {
      const wanted = parsePreferences(
        JSON.stringify({
          layout: field(data, "layout"),
          undoSendSeconds: Number(field(data, "undoSendSeconds")),
          pageSize: Number(field(data, "pageSize")),
        })
      );

      const changes: Partial<MailPreferences> = {};

      if (data.has("layout")) {
        changes.layout = wanted.layout;
      }

      if (data.has("undoSendSeconds")) {
        changes.undoSendSeconds = wanted.undoSendSeconds;
      }

      if (data.has("pageSize")) {
        changes.pageSize = wanted.pageSize;
      }

      await savePreferences(db, userId, changes);

      return { ok: true, message: "Saved." };
    }

    case "import-cancel": {
      return (await cancelImport(db, userId, field(data, "id")))
        ? { ok: true, message: "Import cancelled. What it copied stays." }
        : { ok: false, error: "That import has ended already." };
    }

    case "vacation": {
      await saveVacation(db, userId, {
        on: field(data, "on") === "on",
        subject: field(data, "subject"),
        text: field(data, "text"),
        from: field(data, "from") || null,
        until: field(data, "until") || null,
      });

      return { ok: true, message: "Saved." };
    }

    default: {
      return null;
    }
  }
};

/**
 * Settings → Mail: the preferences, a label made, renamed or deleted, a filter saved, moved or deleted, a sender
 * blocked, allowed or let go, a sender's images loaded always or no longer, the responder, a running import cancelled.
 */
export const mailSettingsAction = createServerFn({ method: "POST" })
  .middleware([formPost])
  .validator(formData)
  .handler(async ({ data }): Promise<SettingsResult> => {
    const { db, user } = await appContext();
    const intent = field(data, "intent");
    const call: SettingsCall = { db, userId: user.id, data };

    try {
      const result =
        (await labelIntent(intent, call)) ??
        (await filterIntent(intent, call)) ??
        (await senderIntent(intent, call)) ??
        (await accountIntent(intent, call));

      return result ?? { ok: false, error: "Unknown action." };
    } catch (error) {
      if (
        error instanceof LabelError ||
        error instanceof FilterError ||
        error instanceof SpamError ||
        error instanceof ImageSenderError ||
        error instanceof PreferencesError
      ) {
        return { ok: false, error: error.message };
      }

      throw error;
    }
  });
