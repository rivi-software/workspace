import { parseJsonObject } from "~/lib/guards";

/** A person's mail preferences (Settings → Mail), kept as JSON on `users.preferences_json`. */
export interface MailPreferences {
  /** The list beside the open conversation on a wide screen, or each on its own. */
  layout: "split" | "full";
  /** How long a sent message waits before it leaves, so it can be taken back; 0 sends at once. */
  undoSendSeconds: 0 | 5 | 10 | 20 | 30;
  /** Rows per page of a list. */
  pageSize: 25 | 50 | 100;
}

export const DEFAULT_PREFERENCES: MailPreferences = {
  layout: "split",
  undoSendSeconds: 5,
  pageSize: 50,
};

export const UNDO_SEND_CHOICES: MailPreferences["undoSendSeconds"][] = [
  0, 5, 10, 20, 30,
];

export const PAGE_SIZE_CHOICES: MailPreferences["pageSize"][] = [25, 50, 100];

export const parsePreferences = (
  json: string | null | undefined
): MailPreferences => {
  const raw = parseJsonObject(json);
  const undo = Number(raw.undoSendSeconds);
  const pageSize = Number(raw.pageSize);

  return {
    layout: raw.layout === "full" ? "full" : "split",
    undoSendSeconds:
      UNDO_SEND_CHOICES.find((choice) => choice === undo) ??
      DEFAULT_PREFERENCES.undoSendSeconds,
    pageSize:
      PAGE_SIZE_CHOICES.find((choice) => choice === pageSize) ??
      DEFAULT_PREFERENCES.pageSize,
  };
};
