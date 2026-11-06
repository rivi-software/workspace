/**
 * The one definition of the mailbox's views and of what each action on conversations does, for the client and the
 * server alike. A view is a condition (`Cond`) over a small record of a conversation (`ViewedThread`): the list reads
 * it in JS (`matches`, so `leavesView` can hide a row the moment an action starts) and the server turns the same
 * condition into SQL (`conditionSql` in `mailbox.server.ts`, for the lists, their counts and the unread badges). An
 * intent's effect (`intentEffect`) is data too: `applyThreadAction` (`threads.server.ts`) does it, and the list
 * predicts it with `afterEffect`. A new view or intent is one entry here; `test/views.test.ts` holds the JS and SQL
 * readings to the same answers on the same conversations. A plain module: the client imports it.
 */
import type { Folder, Place } from "./folders";
import { parseQuery, searchScope } from "./query";

/* ---------- intents ---------- */

export type ThreadIntent =
  | "star"
  | "unstar"
  | "archive"
  | "trash"
  | "spam"
  | "inbox"
  | "read"
  | "unread"
  | "delete"
  | "mute"
  | "unmute"
  | "snooze"
  | "unsnooze"
  | "label"
  | "unlabel";

export const THREAD_INTENTS: ThreadIntent[] = [
  "star",
  "unstar",
  "archive",
  "trash",
  "spam",
  "inbox",
  "read",
  "unread",
  "delete",
  "mute",
  "unmute",
  "snooze",
  "unsnooze",
  "label",
  "unlabel",
];

export const isThreadIntent = (value: string): value is ThreadIntent =>
  THREAD_INTENTS.some((intent) => intent === value);

export interface ThreadAction {
  intent: ThreadIntent;
  /** For `snooze`: when the thread comes back, ISO. */
  until?: string | null;
  /** For `label` and `unlabel`. */
  labelId?: string | null;
}

/* ---------- views ---------- */

/** What the views read of a conversation: where it sits, its snooze, its star, whether the owner wrote in it, whether any of it is unread, and its labels. */
export interface ViewedThread {
  folder: Place;
  snoozedUntil: string | null;
  starred: boolean;
  /** The owner sent a message in it (`sent_count > 0`). */
  sent: boolean;
  /** A message in it is unread (`unread_count > 0`). */
  unread: boolean;
  labels: readonly { id: string }[];
}

/** A condition on a conversation, read in JS (`matches`) and as SQL (`conditionSql` in `mailbox.server.ts`). */
export type Cond =
  | { is: "in"; folder: Place }
  | { is: "junk" }
  | { is: "snoozed" }
  | { is: "starred" }
  | { is: "sent" }
  | { is: "unread" }
  | { is: "labelled"; id: string }
  | { is: "not"; cond: Cond }
  | { is: "all"; conds: Cond[] }
  | { is: "always" }
  | { is: "never" };

const notJunk: Cond = { is: "not", cond: { is: "junk" } };
const all = (...conds: Cond[]): Cond => ({ is: "all", conds });

/**
 * The conversations a view shows: a folder of the sidebar, a label's (everything with it but the trash and Spam), or
 * `anywhere` (a search with `in:anywhere`). Drafts and scheduled messages are rows of `drafts`, read on their own.
 */
export const viewCondition = (
  folder: Folder | "anywhere",
  label?: string | null
): Cond => {
  if (folder === "anywhere") {
    return { is: "always" };
  }

  if (label) {
    return all({ is: "labelled", id: label }, notJunk);
  }

  switch (folder) {
    case "inbox": {
      return all(
        { is: "in", folder: "inbox" },
        { is: "not", cond: { is: "snoozed" } }
      );
    }

    case "starred": {
      return all({ is: "starred" }, notJunk);
    }

    case "snoozed": {
      return all({ is: "snoozed" }, notJunk);
    }

    case "sent": {
      return all({ is: "sent" }, notJunk);
    }

    case "archive": {
      // All mail: everything that is not junk, the inbox included.
      return notJunk;
    }

    case "spam":
    case "trash": {
      return { is: "in", folder };
    }

    case "drafts":
    case "scheduled": {
      return { is: "never" };
    }

    default: {
      throw new Error("That folder has no view.");
    }
  }
};

/** What the sidebar counts and the tab's new-mail notice look for (`folderCounts`, `newestUnread`). */
export const COUNTED = {
  inboxUnread: all(viewCondition("inbox"), { is: "unread" }),
  spamUnread: all(viewCondition("spam"), { is: "unread" }),
  snoozed: viewCondition("snoozed"),
  /** Each label's unread conversations, the label aside: a label's view without its label. */
  labelUnread: all(notJunk, { is: "unread" }),
} satisfies Record<string, Cond>;

/** Whether a conversation meets a condition: the JS reading of `conditionSql`. */
export const matches = (cond: Cond, t: ViewedThread): boolean => {
  switch (cond.is) {
    case "in": {
      return t.folder === cond.folder;
    }

    case "junk": {
      return t.folder === "trash" || t.folder === "spam";
    }

    case "snoozed": {
      return t.snoozedUntil !== null;
    }

    case "starred": {
      return t.starred;
    }

    case "sent": {
      return t.sent;
    }

    case "unread": {
      return t.unread;
    }

    case "labelled": {
      return t.labels.some((l) => l.id === cond.id);
    }

    case "not": {
      return !matches(cond.cond, t);
    }

    case "all": {
      return cond.conds.every((c) => matches(c, t));
    }

    case "always": {
      return true;
    }

    case "never": {
      return false;
    }

    default: {
      throw new Error("That condition is not one a view can hold.");
    }
  }
};

/* ---------- what an intent does ---------- */

/** What an intent does to a conversation, as data; `applyThreadAction` does it, `afterEffect` predicts it. */
export interface Effect {
  /** It goes to a folder (the inbox, with `snoozedUntil`, for a snooze); with `from`, only from that folder. */
  move?: { folder: Place; snoozedUntil: string | null; from?: Place };
  /** Its snooze ends; it stays where it is. */
  wake?: true;
  starred?: boolean;
  muted?: boolean;
  label?: { id: string; on: boolean };
  read?: boolean;
  /** Deleted for good, from the trash or Spam. */
  deleted?: true;
}

export const intentEffect = (action: ThreadAction): Effect => {
  switch (action.intent) {
    case "archive":
    case "trash":
    case "spam":
    case "inbox": {
      return { move: { folder: action.intent, snoozedUntil: null } };
    }

    case "snooze": {
      return { move: { folder: "inbox", snoozedUntil: action.until ?? null } };
    }

    case "unsnooze": {
      return { wake: true };
    }

    case "mute": {
      // A muted conversation leaves the inbox, as in Gmail; its replies stay out of it.
      return {
        muted: true,
        move: { folder: "archive", snoozedUntil: null, from: "inbox" },
      };
    }

    case "unmute": {
      return { muted: false };
    }

    case "star":
    case "unstar": {
      return { starred: action.intent === "star" };
    }

    case "label":
    case "unlabel": {
      return {
        label: { id: action.labelId ?? "", on: action.intent === "label" },
      };
    }

    case "read":
    case "unread": {
      return { read: action.intent === "read" };
    }

    case "delete": {
      return { deleted: true };
    }

    default: {
      throw new Error("That intent changes nothing.");
    }
  }
};

/** The conversation as an effect leaves it, as far as a view can tell; null once it is deleted. */
export const afterEffect = (
  t: ViewedThread,
  effect: Effect
): ViewedThread | null => {
  if (effect.deleted) {
    return null;
  }

  let next: ViewedThread = { ...t };
  const { move, label } = effect;

  if (move && (!move.from || t.folder === move.from)) {
    next = { ...next, folder: move.folder, snoozedUntil: move.snoozedUntil };
  }

  if (effect.wake) {
    next.snoozedUntil = null;
  }

  if (effect.starred !== undefined) {
    next.starred = effect.starred;
  }

  if (effect.read !== undefined) {
    next.unread = !effect.read;
  }

  if (label) {
    const others = next.labels.filter((l) => l.id !== label.id);
    next.labels = label.on ? [...others, { id: label.id }] : others;
  }

  return next;
};

/* ---------- the list on screen ---------- */

/** A view of the list: a folder or a label, and a search in it. */
export interface View {
  folder: Folder;
  label: { id: string } | null;
  q: string;
}

/**
 * Whether an action takes the conversation out of the view on screen, so its row can go before the list reloads.
 * A search is judged by where it looks, not by its terms: what a term would drop goes when the list reloads.
 */
export const leavesView = (
  view: View,
  thread: ViewedThread,
  action: ThreadAction
): boolean => {
  const after = afterEffect(thread, intentEffect(action));

  if (!after) {
    return true;
  }

  const terms = parseQuery(view.q);
  const scope = terms.length ? searchScope(view.folder, terms) : view.folder;

  return !matches(viewCondition(scope, view.label?.id ?? null), after);
};
