/**
 * What Mail's two reads answer (`reads.server.ts`): a page of a list, and a thread opened with its messages made safe
 * to show. A plain module: the list and the thread page import these types, and the server builds them.
 */
import type { Address } from "~/db/schema";

import type { Folder, LabelRef, Place } from "./folders";
import type { PgpStatus } from "./pgp/pgp";
import type { SpamCheck } from "./spam";
import type { Unsubscribe } from "./unsubscribe";

/** A conversation as a list shows it. */
export interface ListRow {
  id: string;
  subject: string;
  snippet: string;
  people: string;
  count: number;
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
  lastMessageAt: string;
  folder: Place;
  snoozedUntil: string | null;
  muted: boolean;
  /** The owner wrote in it: what the Sent view looks for (`views.ts`). */
  sent: boolean;
  labels: LabelRef[];
}

/** A draft or a scheduled message as the Drafts and Scheduled lists show it. */
export interface DraftRow {
  id: string;
  to: string;
  subject: string;
  snippet: string;
  updatedAt: string;
  /** When a scheduled message goes (the Scheduled view). */
  scheduledAt: string | null;
  /** Why its scheduled send failed: it is a draft again. */
  sendError: string | null;
}

/** A page of a list: a view or a label, with a search over it; drafts instead of threads under Drafts and Scheduled. */
export interface MailListData {
  folder: Folder;
  q: string;
  page: number;
  pageSize: number;
  total: number;
  label: LabelRef | null;
  labels: LabelRef[];
  threads: ListRow[];
  drafts: DraftRow[];
}

export interface AttachmentView {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
  url: string;
}

/** A stored message with signed links to its files (`loadThread`), its HTML part as it arrived. */
export interface MessageView {
  id: string;
  direction: "inbound" | "outbound";
  messageId: string;
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address | null;
  subject: string;
  text: string;
  html: string | null;
  date: string;
  read: boolean;
  hasRaw: boolean;
  deliveryStatus: "received" | "sent" | "failed";
  deliveryError: string | null;
  unsubscribe: Unsubscribe | null;
  /** Why the spam filter put it in Spam when it arrived; null when it did not. */
  spam: SpamCheck | null;
  /** What OpenPGP did to it (signed, encrypted, opened here); null for mail without OpenPGP. */
  pgp: PgpStatus | null;
  attachments: AttachmentView[];
}

/** A message of an opened thread: its markup made safe, whether its images load, and the files to list. */
export type MessageData = Omit<MessageView, "html"> & {
  /** The HTML part sanitised, its inline images on their signed links; null when it has none. */
  html: string | null;
  remoteImages: boolean;
  /** Its images from the web load on opening: the owner always loads its sender's, and it is not in Spam. */
  loadImages: boolean;
  /** The attachments to list: all but the inline images its markup shows. */
  files: AttachmentView[];
};

/** The owner's rule for a message's sender: blocked (their mail goes to Spam) or allowed (it never does). */
export interface SenderRuleView {
  sender: string;
  verdict: "block" | "allow";
}
