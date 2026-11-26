/**
 * Settings → Mail: how the list reads, the labels, the filters, spam, images, the vacation responder, a mailbox
 * import and OpenPGP. What the tab loads (`mailSettings`) and what its forms do (`mailSettingsIntent`), apart from
 * `mailSettingsAction` so the tests call both; OpenPGP's forms are `pgpIntent`'s (`pgp/settings.server.ts`).
 */
import type { Database } from "~/db";
import type { User } from "~/db/schema";
import { field } from "~/lib/guards";

import {
  FilterError,
  deleteFilter,
  listFilters,
  moveFilter,
  saveFilter,
} from "./filters.server";
import {
  ImageSenderError,
  addImageSender,
  listImageSenders,
  removeImageSender,
} from "./images.server";
import { cancelImport, importView, latestImport } from "./import/import.server";
import { microsoftConfigured } from "./import/microsoft.server";
import {
  LabelError,
  createLabel,
  deleteLabel,
  listLabels,
  updateLabel,
} from "./labels.server";
import { pgpSettings } from "./pgp/settings.server";
import { parsePreferences } from "./preferences";
import type { MailPreferences } from "./preferences";
import {
  PreferencesError,
  savePreferences,
  saveVacation,
} from "./preferences.server";
import { describeSender } from "./spam";
import {
  SpamError,
  learntTotals,
  listSenderRules,
  removeSenderRule,
  setSenderRule,
} from "./spam.server";

/** What the Mail tab shows; each read stands alone, so they go at once. */
export const mailSettings = async (db: Database, env: Env, user: User) => {
  const [labels, filters, senderRules, learnt, imageSenderRows, latest, pgp] =
    await Promise.all([
      listLabels(db, user.id),
      listFilters(db, user.id),
      listSenderRules(db, user.id),
      learntTotals(db, user.id),
      listImageSenders(db, user.id),
      latestImport(db, user.id),
      pgpSettings(db, env, user),
    ]);

  return {
    preferences: parsePreferences(user.preferencesJson),
    labels,
    filters,
    spam: {
      senders: senderRules.map(({ sender, verdict }) => ({ sender, verdict })),
      learnt,
      mailDomain: env.MAIL_DOMAIN,
    },
    imageSenders: imageSenderRows.map((s) => s.sender),
    vacation: {
      on: user.vacationOn,
      subject: user.vacationSubject,
      text: user.vacationText,
      from: user.vacationFrom,
      until: user.vacationUntil,
    },
    imports: {
      configured: microsoftConfigured(env),
      latest: latest ? importView(latest) : null,
    },
    pgp,
  };
};

export type MailSettingsResult =
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
): Promise<MailSettingsResult | null> => {
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
): Promise<MailSettingsResult | null> => {
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
): Promise<MailSettingsResult | null> => {
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
const preferencesIntent = async (
  intent: string,
  { db, userId, data }: SettingsCall
): Promise<MailSettingsResult | null> => {
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
 * A Mail form: the preferences, a label made, renamed or deleted, a filter saved, moved or deleted, a sender blocked,
 * allowed or let go, a sender's images loaded always or no longer, the responder, a running import cancelled. An
 * intent it does not know is refused.
 */
export const mailSettingsIntent = async (
  db: Database,
  _env: Env,
  user: User,
  form: FormData
): Promise<MailSettingsResult> => {
  const intent = field(form, "intent");
  const call: SettingsCall = { db, userId: user.id, data: form };

  try {
    const result =
      (await labelIntent(intent, call)) ??
      (await filterIntent(intent, call)) ??
      (await senderIntent(intent, call)) ??
      (await preferencesIntent(intent, call));

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
};
