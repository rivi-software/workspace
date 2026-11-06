/** The views of a mailbox, shared by the list, the sidebar and the server (`mailbox.server.ts`). */
export const FOLDERS = [
  "inbox",
  "starred",
  "snoozed",
  "sent",
  "scheduled",
  "drafts",
  "archive",
  "spam",
  "trash",
] as const;

export type Folder = (typeof FOLDERS)[number];

export const isFolder = (value: string | undefined): value is Folder =>
  FOLDERS.some((folder) => folder === value);

export const FOLDER_LABEL: Record<Folder, string> = {
  inbox: "Inbox",
  starred: "Starred",
  snoozed: "Snoozed",
  sent: "Sent",
  scheduled: "Scheduled",
  drafts: "Drafts",
  archive: "All mail",
  spam: "Spam",
  trash: "Trash",
};

/** Where a thread can be put: the folders a thread sits in, as against the views over them. */
export const PLACES = ["inbox", "archive", "spam", "trash"] as const;

export type Place = (typeof PLACES)[number];

export const isPlace = (value: string | undefined): value is Place =>
  PLACES.some((place) => place === value);

/** The trash and the spam folder empty themselves: a thread is deleted for good this many days after it went there. */
export const EXPIRY_DAYS = 30;

/** The palette a label is coloured from; `app.css` defines `--label-<name>` and `--label-<name>-soft` for each. */
export const LABEL_COLORS = [
  "gray",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const;

export type LabelColor = (typeof LABEL_COLORS)[number];

export const isLabelColor = (value: string | undefined): value is LabelColor =>
  LABEL_COLORS.some((color) => color === value);

/** What a label row carries to the client: enough for a chip and a sidebar entry. */
export interface LabelRef {
  id: string;
  name: string;
  color: LabelColor;
}

export const MAX_LABEL_NAME = 40;
