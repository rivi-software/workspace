import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

/** A name and address as they appear on a message, for the lists the client keeps as JSON. */
export interface Address {
  email: string;
  name: string | null;
}

/**
 * A person with a mailbox. The account's `email` is their primary address on `MAIL_DOMAIN`: what they sign in with,
 * what Email Routing delivers to them and what they send from. Deactivated people keep their mail but cannot sign in.
 * The table is Better Auth's `user` model too (`app/lib/auth.server.ts`): `email_verified`, `image`, `updated_at`
 * and `two_factor_enabled` are its; the password lives in `accounts` (the `credential` account) and the sessions in
 * `sessions`. Better Auth never inserts a person: admins do (`createPerson`).
 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    // A mailbox here is the workspace's own, so it counts as verified from the start.
    emailVerified: integer("email_verified", { mode: "boolean" })
      .notNull()
      .default(true),
    image: text("image"),
    role: text("role", { enum: ["admin", "member"] })
      .notNull()
      .default("member"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    // Whether a password sign-in asks for the code of an authenticator app (Better Auth's two-factor plugin).
    twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    // When a session of the person last started: a password sign-in, with its second factor, or a passkey.
    lastSignInAt: text("last_sign_in_at"),
    // JSON `MailPreferences` (`app/lib/mail/preferences.ts`): the reading layout, the undo-send delay, the page size.
    preferencesJson: text("preferences_json").notNull().default("{}"),
    // The vacation responder (Settings → Mail): while on, and between the dates when they are set, every person
    // who writes gets `vacationText` back once in four days (`app/lib/mail/vacation.server.ts`).
    vacationOn: integer("vacation_on", { mode: "boolean" })
      .notNull()
      .default(false),
    vacationSubject: text("vacation_subject").notNull().default(""),
    vacationText: text("vacation_text").notNull().default(""),
    vacationFrom: text("vacation_from"),
    vacationUntil: text("vacation_until"),
    createdAt: text("created_at").notNull().default(now()),
    // Better Auth stamps it on every change it makes (a name, two-factor on or off); an instant, as its dates are.
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)]
);

/** An instant as Better Auth keeps its dates: milliseconds since the epoch, read and written as a `Date`. */
const instant = (name: string) => integer(name, { mode: "timestamp_ms" });

/**
 * A person signed in on one browser (Better Auth's `session` model): the token the session cookie carries, when it
 * expires (14 days, moved on while it is used), and the browser it started on. Every session of a person goes with
 * "Sign out everywhere", a new password and a deactivation; the rows are only ever written by Better Auth.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: instant("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: instant("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: instant("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("sessions_token_idx").on(t.token),
    index("sessions_user_idx").on(t.userId),
  ]
);

/**
 * How a person signs in (Better Auth's `account` model): one `credential` account per person holds their password
 * hash (`password`, PBKDF2 as `hashPassword` writes it); the other columns are for a social provider, which this
 * workspace has none of.
 */
export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: instant("access_token_expires_at"),
    refreshTokenExpiresAt: instant("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: instant("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: instant("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("accounts_user_idx").on(t.userId)]
);

/** A short-lived value Better Auth keeps between two steps (a passkey's challenge, a two-factor state). */
export const verifications = sqliteTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: instant("expires_at").notNull(),
    createdAt: instant("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: instant("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)]
);

/**
 * A person's authenticator app (Better Auth's two-factor plugin): the TOTP secret and the backup codes, both
 * encrypted with the auth secret, and the lockout after too many wrong codes. Deleted with the person, or by an
 * admin resetting the second factor of someone who lost their phone.
 */
export const twoFactors = sqliteTable(
  "two_factors",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: integer("verified", { mode: "boolean" }),
    failedVerificationCount: integer("failed_verification_count"),
    lockedUntil: instant("locked_until"),
  },
  (t) => [index("two_factors_user_idx").on(t.userId)]
);

/**
 * A signature a person keeps for their mail, put under a message after a "-- " line: plain text, or HTML (a logo, a
 * table from a signature generator) with its text reading beside it for the text part. The composer starts a new
 * message on the default and a reply or forward on the reply default (each at most one per person), and offers the
 * others, or none.
 */
export const signatures = sqliteTable(
  "signatures",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    // The plain-text signature, or the text reading of `html` (`htmlToText`), for the text part and plain mail.
    text: text("text").notNull(),
    // Sanitised on save (`sanitizeSignatureHtml`); its images are `data:` URIs that go out as inline attachments.
    // Null for a signature written as plain text.
    html: text("html"),
    isDefault: integer("is_default", { mode: "boolean" })
      .notNull()
      .default(false),
    // What a reply or forward starts on, as Outlook's "For replies/forwards" (CORE-1226).
    isReplyDefault: integer("is_reply_default", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("signatures_user_idx").on(t.userId, t.createdAt),
    uniqueIndex("signatures_user_default_idx")
      .on(t.userId)
      .where(sql`is_default = 1`),
    uniqueIndex("signatures_user_reply_default_idx")
      .on(t.userId)
      .where(sql`is_reply_default = 1`),
  ]
);

/** An extra address delivered to a mailbox (hello@, a former name), which the owner can also send from. */
export const aliases = sqliteTable(
  "aliases",
  {
    address: text("address").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("aliases_user_idx").on(t.userId)]
);

/**
 * A personal address outside `MAIL_DOMAIN` where a person can receive a link to reset a forgotten password
 * (Settings → Account): their own mailbox is no help while they cannot sign in. Only a confirmed address gets one.
 */
export const recoveryAddresses = sqliteTable(
  "recovery_addresses",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    address: text("address").notNull(),
    // When the person opened the confirmation link sent to it; null until then.
    confirmedAt: text("confirmed_at"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    uniqueIndex("recovery_addresses_user_address_idx").on(t.userId, t.address),
  ]
);

/**
 * A passkey a person added under Settings → Account (Better Auth's passkey plugin, on WebAuthn): Touch ID, Windows
 * Hello, a phone or a security key, which signs them in without a password. The public key is checked against each
 * sign-in's signature; only the public key is here, never a biometric or a private key. Removed with the person.
 */
export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // What the person called it ("MacBook", "YubiKey"), shown in Settings.
    name: text("name"),
    publicKey: text("public_key").notNull(),
    // The credential id the authenticator chose (base64url), what a sign-in names.
    credentialID: text("credential_id").notNull(),
    // The authenticator's signature counter at the last sign-in; one that goes back is a cloned key.
    counter: integer("counter").notNull(),
    // `singleDevice` or `multiDevice`, and whether it syncs to the person's other devices (iCloud Keychain, Google
    // Password Manager, a password manager).
    deviceType: text("device_type").notNull(),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
    // How the browser can reach it (`internal`, `hybrid`, `usb`, …), comma-separated, handed back on each sign-in.
    transports: text("transports"),
    aaguid: text("aaguid"),
    createdAt: instant("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("passkeys_user_idx").on(t.userId),
    uniqueIndex("passkeys_credential_idx").on(t.credentialID),
  ]
);

/**
 * A single-use link mailed to a recovery address: one that confirms the address, or one that resets the person's
 * password. Kept as its SHA-256; the link carries the token in its fragment, which no request (and no log) holds.
 */
export const recoveryTokens = sqliteTable(
  "recovery_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    purpose: text("purpose", {
      enum: ["confirm-address", "reset-password"],
    }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    // The address a confirmation link confirms; removing the address voids its link.
    recoveryAddressId: text("recovery_address_id").references(
      () => recoveryAddresses.id,
      {
        onDelete: "cascade",
      }
    ),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("recovery_tokens_user_idx").on(t.userId, t.purpose, t.createdAt),
  ]
);

/**
 * A conversation in one mailbox: the unit the list shows and the folders hold. `folder` is where the thread sits
 * (the inbox, the archive, the spam folder or the trash); starred, snoozed, sent, drafts, "All mail" and the labels
 * are views over it. A thread that only holds mail the owner sent starts in the archive, so it shows under Sent,
 * and comes to the inbox with the first reply.
 */
export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    subject: text("subject").notNull(),
    snippet: text("snippet").notNull().default(""),
    folder: text("folder", { enum: ["inbox", "archive", "trash", "spam"] })
      .notNull()
      .default("inbox"),
    starred: integer("starred", { mode: "boolean" }).notNull().default(false),
    // When the thread went to the trash or the spam folder: 30 days later it is deleted for good (`pruneExpired`).
    trashedAt: text("trashed_at"),
    // A snoozed thread is out of the inbox until this moment, when it returns to the top (`wakeSnoozed`).
    snoozedUntil: text("snoozed_until"),
    // A muted thread stays out of the inbox when replies come; it is still under All mail and in search.
    muted: integer("muted", { mode: "boolean" }).notNull().default(false),
    messageCount: integer("message_count").notNull().default(0),
    unreadCount: integer("unread_count").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    hasAttachments: integer("has_attachments", { mode: "boolean" })
      .notNull()
      .default(false),
    // JSON `Address[]`: everyone on the thread except the owner, newest last, for the list row.
    participantsJson: text("participants_json").notNull().default("[]"),
    lastMessageAt: text("last_message_at").notNull().default(now()),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("threads_user_folder_idx").on(t.userId, t.folder, t.lastMessageAt),
    index("threads_user_starred_idx").on(t.userId, t.starred),
    index("threads_user_snoozed_idx").on(t.userId, t.snoozedUntil),
  ]
);

/** A label a person puts on threads (Gmail's labels): a name and one of the palette's colours (`LABEL_COLORS`). */
export const labels = sqliteTable(
  "labels",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    color: text("color").notNull().default("gray"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [uniqueIndex("labels_user_name_idx").on(t.userId, t.name)]
);

export const threadLabels = sqliteTable(
  "thread_labels",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.labelId] }),
    index("thread_labels_user_label_idx").on(t.userId, t.labelId),
  ]
);

/**
 * The people a person has written to or heard from, for the composer's suggestions: kept up on every send and
 * every delivery (`touchContacts`), most recent and most used first.
 */
export const contacts = sqliteTable(
  "contacts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    email: text("email").notNull(),
    name: text("name"),
    timesUsed: integer("times_used").notNull().default(1),
    lastUsedAt: text("last_used_at").notNull().default(now()),
    // When the person last wrote to them (sent, or imported from their sent mail); null for someone they only heard
    // from. The spam filter never sends mail from such a person to Spam (`judgeMail`).
    writtenAt: text("written_at"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.email] }),
    index("contacts_user_used_idx").on(t.userId, t.lastUsedAt),
  ]
);

/**
 * A rule run on every message that arrives, in `position` order (Settings → Mail → Filters): `conditionsJson` is
 * a `FilterConditions`, `actionsJson` a `FilterActions` (`app/lib/mail/filters.ts`).
 */
export const filters = sqliteTable(
  "filters",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    position: integer("position").notNull().default(0),
    conditionsJson: text("conditions_json").notNull().default("{}"),
    actionsJson: text("actions_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("filters_user_idx").on(t.userId, t.position)]
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    // RFC 5322 Message-ID with its angle brackets: the sender's on inbound mail, Email Service's on sent mail.
    messageId: text("message_id").notNull(),
    inReplyTo: text("in_reply_to"),
    referencesHeader: text("references_header"),
    fromEmail: text("from_email").notNull(),
    fromName: text("from_name"),
    // JSON `Address[]`.
    toJson: text("to_json").notNull().default("[]"),
    ccJson: text("cc_json").notNull().default("[]"),
    bccJson: text("bcc_json").notNull().default("[]"),
    replyTo: text("reply_to"),
    subject: text("subject").notNull(),
    text: text("text").notNull().default(""),
    // The HTML part as received, sanitised only when shown (`app/lib/mail/sanitize.ts`).
    html: text("html"),
    snippet: text("snippet").notNull().default(""),
    // The Date header when it parses, else when the message arrived or was sent.
    date: text("date").notNull(),
    read: integer("read", { mode: "boolean" }).notNull().default(false),
    // The raw message as received, in the MAIL bucket (`raw/<user>/<message>.eml`); sent mail has none.
    rawKey: text("raw_key"),
    size: integer("size").notNull().default(0),
    deliveryStatus: text("delivery_status", {
      enum: ["received", "sent", "failed"],
    })
      .notNull()
      .default("received"),
    deliveryError: text("delivery_error"),
    // JSON `Unsubscribe` (`app/lib/mail/unsubscribe.ts`): the sender's List-Unsubscribe ways out, when it names any.
    listUnsubscribe: text("list_unsubscribe"),
    // JSON `SpamCheck` (`app/lib/mail/spam.ts`): why the spam filter put it in Spam on arrival; null otherwise.
    spamJson: text("spam_json"),
    // What the message taught the spam filter (`spam_tokens`), so a later "Not spam" or "Report spam" takes it back.
    spamLearned: text("spam_learned", { enum: ["spam", "ham"] }),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("messages_thread_idx").on(t.threadId, t.date),
    // A message delivered twice (a retry, or two aliases of one mailbox on the same mail) is stored once per mailbox.
    uniqueIndex("messages_user_message_id_idx").on(t.userId, t.messageId),
  ]
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    r2Key: text("r2_key").notNull(),
    // The Content-ID of an inline image, so the HTML's `cid:` references find it.
    contentId: text("content_id"),
    inline: integer("inline", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("attachments_message_idx").on(t.messageId)]
);

/**
 * A message being written: new, or a reply or forward of one of the owner's messages. Sent, it becomes a message.
 * With `scheduled_at` it is a scheduled message: the cron sends it then (`sendDueDrafts`), and it shows under
 * Scheduled instead of Drafts.
 */
export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    threadId: text("thread_id").references(() => threads.id),
    // The owner's message this answers or forwards (`messages.id`), for the threading headers.
    inReplyToId: text("in_reply_to_id"),
    mode: text("mode", { enum: ["new", "reply", "forward"] })
      .notNull()
      .default("new"),
    fromEmail: text("from_email").notNull(),
    toJson: text("to_json").notNull().default("[]"),
    ccJson: text("cc_json").notNull().default("[]"),
    bccJson: text("bcc_json").notNull().default("[]"),
    subject: text("subject").notNull().default(""),
    text: text("text").notNull().default(""),
    // What the rich composer holds, as written (sanitised when sent); null for a draft written as plain text.
    html: text("html"),
    // The signature it goes out with; none when null, and none once that signature is deleted.
    signatureId: text("signature_id").references(() => signatures.id, {
      onDelete: "set null",
    }),
    // When the cron sends it; null for a draft still being written.
    scheduledAt: text("scheduled_at"),
    // Why a scheduled send failed: the message went back to Drafts with this on it, until it is sent or rescheduled.
    sendError: text("send_error"),
    updatedAt: text("updated_at").notNull().default(now()),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("drafts_user_idx").on(t.userId, t.updatedAt),
    index("drafts_scheduled_idx").on(t.scheduledAt),
  ]
);

/** A file attached to a draft, kept in the MAIL bucket (`draft/<user>/<file>`) until the draft is sent or discarded. */
export const draftFiles = sqliteTable(
  "draft_files",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    r2Key: text("r2_key").notNull(),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("draft_files_draft_idx").on(t.draftId)]
);

/**
 * A person's mail being copied in from another mailbox (Settings → Mail → Import): today a Microsoft 365 mailbox
 * through Microsoft Graph (`app/lib/mail/import/`). The cron works through it a batch a minute, oldest message
 * first, from `cursor_json`; one runs per person at a time. The connection's tokens are kept encrypted
 * (`sealSecret`) while it runs and deleted when it ends.
 */
export const mailImports = sqliteTable(
  "mail_imports",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    provider: text("provider", { enum: ["microsoft"] })
      .notNull()
      .default("microsoft"),
    // The mailbox the mail comes from, as its provider names it (the Microsoft 365 account's address).
    account: text("account").notNull(),
    status: text("status", { enum: ["running", "done", "failed", "cancelled"] })
      .notNull()
      .default("running"),
    // The provider's tokens, encrypted with a key from SESSION_SECRET; null once the import ended.
    tokensSealed: text("tokens_sealed"),
    // JSON `Record<string, ImportFolder>`: the source's folders by id, and where their mail goes here.
    foldersJson: text("folders_json").notNull().default("{}"),
    // JSON `ImportCursor`: how far through the source the import is.
    cursorJson: text("cursor_json").notNull().default("{}"),
    // The messages the source's imported folders held when the import started: the progress bar's whole.
    total: integer("total").notNull().default(0),
    imported: integer("imported").notNull().default(0),
    // Already in this mailbox (delivered here, or imported before), so not copied again.
    duplicates: integer("duplicates").notNull().default(0),
    // Not copied: too large, or unreadable. `left_out_json` names the first of them (`ImportLeftOut[]`).
    leftOut: integer("left_out").notNull().default(0),
    leftOutJson: text("left_out_json").notNull().default("[]"),
    // Batches in a row that failed at the same message; a few and that message is left out, so the rest goes on.
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    // A batch holds the import until then, so two cron runs never work on it at once.
    leaseUntil: text("lease_until"),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
    finishedAt: text("finished_at"),
  },
  (t) => [
    index("mail_imports_user_idx").on(t.userId, t.createdAt),
    index("mail_imports_status_idx").on(t.status, t.leaseUntil),
    uniqueIndex("mail_imports_user_running_idx")
      .on(t.userId)
      .where(sql`status = 'running'`),
  ]
);

/**
 * Drive: a folder or a file in a person's drive (`user_id` is the owner, whose storage it counts towards). The tree
 * is a materialized path: `path` is "/" for something at the drive's root, else the ids of its ancestors, each
 * followed by "/" ("/dn_a/dn_b/" for a child of folder dn_b inside dn_a), so one query lists a subtree (`path GLOB
 * prefix*`) and the ancestors of a node are the ids in its own path. A file's bytes are in the DRIVE bucket under
 * `r2_key` (`drive/<owner>/<node>`); `status` is `uploading` while they arrive (`upload_id` names the multipart
 * upload of a large file) and `ready` once they are whole. Trashing marks only the node itself (`trashed_at`); what
 * is under a trashed folder is in the trash with it and comes back with it, so a trashed ancestor hides a node too.
 */
export const driveNodes = sqliteTable(
  "drive_nodes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    // The folder it sits in; null at the root of the owner's drive. No cascade: a folder is deleted with its subtree.
    parentId: text("parent_id"),
    path: text("path").notNull().default("/"),
    kind: text("kind", { enum: ["folder", "file"] }).notNull(),
    name: text("name").notNull(),
    // A file's media type as the browser gave it (else from its extension), and its size in bytes; a folder's are
    // "inode/directory" and 0.
    contentType: text("content_type")
      .notNull()
      .default("application/octet-stream"),
    size: integer("size").notNull().default(0),
    r2Key: text("r2_key"),
    status: text("status", { enum: ["uploading", "ready"] })
      .notNull()
      .default("ready"),
    uploadId: text("upload_id"),
    // Who put it here: the owner, or an editor of a shared folder.
    createdBy: text("created_by").references(() => users.id),
    trashedAt: text("trashed_at"),
    updatedAt: text("updated_at").notNull().default(now()),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("drive_nodes_parent_idx").on(t.parentId, t.name),
    index("drive_nodes_user_idx").on(t.userId, t.parentId),
    index("drive_nodes_path_idx").on(t.path),
    index("drive_nodes_user_trashed_idx").on(t.userId, t.trashedAt),
    index("drive_nodes_user_updated_idx").on(t.userId, t.updatedAt),
    index("drive_nodes_status_idx").on(t.status, t.createdAt),
  ]
);

/**
 * A folder or file shared by its owner: with one person (`subject` is their id, `user_id` the same, so the share
 * goes with the person) or with everyone in the workspace (`subject` "everyone", `user_id` null). A share on a
 * folder covers everything under it; the strongest role on the node or any ancestor is what the person has.
 * `viewer` reads and downloads; `editor` also adds, renames, moves and trashes within what is shared.
 */
export const driveShares = sqliteTable(
  "drive_shares",
  {
    id: text("id").primaryKey(),
    nodeId: text("node_id")
      .notNull()
      .references(() => driveNodes.id, { onDelete: "cascade" }),
    // The owner who shared it, for "Shared with me" to name.
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    subject: text("subject").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["viewer", "editor"] })
      .notNull()
      .default("viewer"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    uniqueIndex("drive_shares_node_subject_idx").on(t.nodeId, t.subject),
    index("drive_shares_subject_idx").on(t.subject, t.createdAt),
  ]
);

/**
 * A folder or file shared outside the workspace (#2836): a `link` that anyone holding it opens (with its password,
 * when it has one), or an `invite` for one address, whose holder confirms with a code mailed there. Always viewer
 * only, and only for as long as its creator (anyone who reaches the node) still reaches it. The token is kept as its
 * SHA-256 to be found by, and sealed (`sealSecret`, purpose `drive-link`) to be shown and copied again. Revoking sets
 * `revoked_at`, so the row stays as the record of who shared what outside, and how often it was opened.
 */
export const driveLinks = sqliteTable(
  "drive_links",
  {
    id: text("id").primaryKey(),
    nodeId: text("node_id")
      .notNull()
      .references(() => driveNodes.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["link", "invite"] }).notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenSealed: text("token_sealed").notNull(),
    // An invite's address, lower-cased.
    email: text("email"),
    // A link's password (PBKDF2, as `users.password_hash`), when it has one.
    passwordHash: text("password_hash"),
    allowDownload: integer("allow_download", { mode: "boolean" })
      .notNull()
      .default(true),
    // Null: it never expires.
    expiresAt: text("expires_at"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").notNull().default(now()),
    revokedAt: text("revoked_at"),
    revokedBy: text("revoked_by").references(() => users.id),
    // An invite's one-time code, the last one mailed, as its SHA-256 until it is used, runs out or is guessed at
    // too often; and when the invitee first confirmed.
    codeHash: text("code_hash"),
    codeExpiresAt: text("code_expires_at"),
    codeAttempts: integer("code_attempts").notNull().default(0),
    confirmedAt: text("confirmed_at"),
    // How often its pages were opened and its files downloaded.
    views: integer("views").notNull().default(0),
    downloads: integer("downloads").notNull().default(0),
    lastViewedAt: text("last_viewed_at"),
  },
  (t) => [
    uniqueIndex("drive_links_token_idx").on(t.tokenHash),
    index("drive_links_node_idx").on(t.nodeId, t.createdAt),
    index("drive_links_created_idx").on(t.createdAt),
  ]
);

/**
 * A request for signatures on a PDF in Drive (#2974): one customer outside the workspace and one RIVI signer (a
 * person here), the customer first. The PDF is copied at the request (`original_key`, `signing/<id>/original.pdf` in
 * the DRIVE bucket, with its SHA-256), so what is signed is what was sent whatever happens to the file in Drive since.
 * `fields_json` holds the fields placed on its pages (`SigningField`, `app/lib/drive/signing.ts`), `values_json` what
 * the signers filled in. The customer opens the request by its token (kept as its SHA-256, and sealed to mail it
 * again) after a one-time code mailed to their address. With `auto_sign` the RIVI signer is the person who asked, and
 * their saved signature (`hand_signatures`) signs RIVI's fields once the customer has signed. When both have, the
 * signed PDF (`signed_key`, its SHA-256) is filed in Drive beside the original (`signed_node_id`) and mailed.
 */
export const signingRequests = sqliteTable(
  "signing_requests",
  {
    id: text("id").primaryKey(),
    // The file it was made from; null once that is deleted for good (the copy stays).
    nodeId: text("node_id").references(() => driveNodes.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    signerId: text("signer_id")
      .notNull()
      .references(() => users.id),
    autoSign: integer("auto_sign", { mode: "boolean" })
      .notNull()
      .default(false),
    customerName: text("customer_name").notNull(),
    // Lower-cased.
    customerEmail: text("customer_email").notNull(),
    message: text("message").notNull().default(""),
    status: text("status", {
      enum: ["sent", "customer-signed", "completed", "declined", "cancelled"],
    })
      .notNull()
      .default("sent"),
    pageCount: integer("page_count").notNull(),
    fieldsJson: text("fields_json").notNull().default("[]"),
    valuesJson: text("values_json").notNull().default("{}"),
    originalKey: text("original_key").notNull(),
    originalSha256: text("original_sha256").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenSealed: text("token_sealed").notNull(),
    // The customer's one-time code, the last one mailed, as its SHA-256 until it is used, runs out or is guessed at
    // too often; and when they first confirmed their address.
    codeHash: text("code_hash"),
    codeExpiresAt: text("code_expires_at"),
    codeAttempts: integer("code_attempts").notNull().default(0),
    confirmedAt: text("confirmed_at"),
    // Each signature as a PNG, base64, with when it was given.
    customerSignature: text("customer_signature"),
    customerSignedAt: text("customer_signed_at"),
    signerSignature: text("signer_signature"),
    signerSignedAt: text("signer_signed_at"),
    signedKey: text("signed_key"),
    signedSha256: text("signed_sha256"),
    signedNodeId: text("signed_node_id").references(() => driveNodes.id, {
      onDelete: "set null",
    }),
    completedAt: text("completed_at"),
    // Declined by the customer, or cancelled by the person who asked: when, and the customer's reason.
    endedAt: text("ended_at"),
    declineReason: text("decline_reason"),
    remindedAt: text("reminded_at"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(now()),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [
    uniqueIndex("signing_requests_token_idx").on(t.tokenHash),
    index("signing_requests_created_by_idx").on(t.createdBy, t.createdAt),
    index("signing_requests_signer_idx").on(t.signerId, t.status),
    index("signing_requests_node_idx").on(t.nodeId, t.createdAt),
  ]
);

/**
 * What happened to a signing request, for its audit trail and the certificate page of the signed PDF: who (a person
 * here, or the customer), from which address and browser, and when. Rows are only ever added.
 */
export const signingEvents = sqliteTable(
  "signing_events",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => signingRequests.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    // A person's id, or null for the customer.
    userId: text("user_id").references(() => users.id),
    // The name and address the event shows.
    actor: text("actor").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    detail: text("detail"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("signing_events_request_idx").on(t.requestId, t.createdAt)]
);

/** A person's own handwritten signature (drawn or typed, a PNG as base64), which signs for RIVI and auto-signs. */
export const handSignatures = sqliteTable("hand_signatures", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id),
  png: text("png").notNull(),
  updatedAt: text("updated_at").notNull().default(now()),
});

/**
 * Workspace-wide settings an admin changes (Settings → Drive): a key and its value as text, with who set it last. A
 * key without a row has its default (`app/lib/workspace-settings.server.ts`).
 */
export const workspaceSettings = sqliteTable("workspace_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedBy: text("updated_by").references(() => users.id),
  updatedAt: text("updated_at").notNull().default(now()),
});

/** A star a person put on a node of theirs or shared with them: Starred is their own view. */
export const driveStars = sqliteTable(
  "drive_stars",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    nodeId: text("node_id")
      .notNull()
      .references(() => driveNodes.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.nodeId] })]
);

/**
 * What a person's spam filter learnt (`app/lib/mail/spam.server.ts`): for each word, in how many messages they
 * marked as spam and how many they kept it came up. The row `TOTAL_TOKEN` counts the messages themselves.
 */
export const spamTokens = sqliteTable(
  "spam_tokens",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    token: text("token").notNull(),
    spam: integer("spam").notNull().default(0),
    ham: integer("ham").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(now()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.token] })]
);

/**
 * A sender a person blocked (their mail goes to Spam) or allowed (it never does), Settings → Mail → Spam: a
 * lower-cased address, or a domain behind its at (`@acme.com`, its subdomains too).
 */
export const senderRules = sqliteTable(
  "sender_rules",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    sender: text("sender").notNull(),
    verdict: text("verdict", { enum: ["block", "allow"] }).notNull(),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sender] })]
);

/**
 * A sender whose images from the web a person always loads ("Always from …" beside "Load images", Settings → Mail
 * → Images): a lower-cased address, or a domain behind its at, as `sender_rules` keeps them.
 */
export const imageSenders = sqliteTable(
  "image_senders",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    sender: text("sender").notNull(),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sender] })]
);

export type User = typeof users.$inferSelect;

export type Signature = typeof signatures.$inferSelect;

export type Alias = typeof aliases.$inferSelect;

export type RecoveryAddress = typeof recoveryAddresses.$inferSelect;

export type Passkey = typeof passkeys.$inferSelect;

export type Session = typeof sessions.$inferSelect;

export type Account = typeof accounts.$inferSelect;

export type Thread = typeof threads.$inferSelect;

export type Message = typeof messages.$inferSelect;

export type Attachment = typeof attachments.$inferSelect;

export type Draft = typeof drafts.$inferSelect;

export type DraftFile = typeof draftFiles.$inferSelect;

export type Label = typeof labels.$inferSelect;

export type Contact = typeof contacts.$inferSelect;

export type Filter = typeof filters.$inferSelect;

export type MailImport = typeof mailImports.$inferSelect;

export type DriveNode = typeof driveNodes.$inferSelect;

export type DriveShare = typeof driveShares.$inferSelect;

export type DriveStar = typeof driveStars.$inferSelect;

export type DriveLink = typeof driveLinks.$inferSelect;

export type SigningRequest = typeof signingRequests.$inferSelect;

export type SigningEvent = typeof signingEvents.$inferSelect;

export type SenderRule = typeof senderRules.$inferSelect;

export type ImageSender = typeof imageSenders.$inferSelect;

/**
 * A conversation with the Assistant (the module beside Mail and Drive): a person's own, listed in the sidebar newest
 * first. `title` is the opening words of the first question. Deleting one deletes its messages; nothing else refers to
 * it.
 */
export const assistantConversations = sqliteTable(
  "assistant_conversations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    // When the last message was added, for the sidebar's order.
    updatedAt: text("updated_at").notNull().default(now()),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("assistant_conversations_user_idx").on(t.userId, t.updatedAt)]
);

/**
 * One turn of a conversation: the person's question or the assistant's answer, as the UI message the page renders
 * (`parts_json`: the text, and each tool call with its input and what it answered, `app/lib/assistant/assistant.ts`).
 * An answer notes the model that wrote it and the tokens it took.
 */
export const assistantMessages = sqliteTable(
  "assistant_messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    partsJson: text("parts_json").notNull().default("[]"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("assistant_messages_conversation_idx").on(
      t.conversationId,
      t.createdAt
    ),
  ]
);

/**
 * Calendar (#3111): an event on a person's calendar, theirs to change. A timed event runs from `starts_at` to
 * `ends_at` (instants, the end exclusive); an all-day one (`all_day`) spans whole days, its `starts_at` the first
 * day's midnight UTC and its `ends_at` the midnight UTC after its last day, read as dates wherever it is shown.
 * `time_zone` is the zone the owner made it in, which a repeat keeps its wall-clock time in across a DST change
 * (`occurrences` in `app/lib/calendar/calendar.ts`): `repeat` says how often it comes back, `repeat_until` the last
 * day it may start on (null: for ever). Colleagues invited to it are `calendar_attendees`; they see it on their own
 * calendar.
 */
export const calendarEvents = sqliteTable(
  "calendar_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    location: text("location").notNull().default(""),
    startsAt: text("starts_at").notNull(),
    endsAt: text("ends_at").notNull(),
    allDay: integer("all_day", { mode: "boolean" }).notNull().default(false),
    timeZone: text("time_zone").notNull().default("UTC"),
    repeat: text("repeat", {
      enum: ["none", "daily", "weekly", "monthly", "yearly"],
    })
      .notNull()
      .default("none"),
    repeatUntil: text("repeat_until"),
    updatedAt: text("updated_at").notNull().default(now()),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [index("calendar_events_user_idx").on(t.userId, t.startsAt)]
);

/** A colleague invited to an event: they see it on their calendar and say whether they come. */
export const calendarAttendees = sqliteTable(
  "calendar_attendees",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => calendarEvents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["needs-action", "accepted", "declined"] })
      .notNull()
      .default("needs-action"),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.userId] }),
    index("calendar_attendees_user_idx").on(t.userId),
  ]
);

/**
 * Tasks (#3111): a person's own to-do, due on a day (`due_on`, a date, or null) with a priority and notes, `open`
 * until `done` (`completed_at`). One made from a GitHub issue, or linked to one, keeps where the issue is
 * (`github_repo` as `owner/name`, `github_number`, `github_url`) and what it last looked like (`github_title`,
 * `github_state`, as of `github_synced_at`); marking the task done closes the issue through the person's own
 * connection (`github_connections`), and reopening it reopens the issue. A person has at most one task per issue.
 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    notes: text("notes").notNull().default(""),
    status: text("status", { enum: ["open", "done"] })
      .notNull()
      .default("open"),
    priority: text("priority", { enum: ["low", "normal", "high"] })
      .notNull()
      .default("normal"),
    // "YYYY-MM-DD": the day it is due, in whatever zone the person reads it; null for a task without a day.
    dueOn: text("due_on"),
    completedAt: text("completed_at"),
    githubRepo: text("github_repo"),
    githubNumber: integer("github_number"),
    githubUrl: text("github_url"),
    githubTitle: text("github_title"),
    githubState: text("github_state", { enum: ["open", "closed"] }),
    githubSyncedAt: text("github_synced_at"),
    updatedAt: text("updated_at").notNull().default(now()),
    createdAt: text("created_at").notNull().default(now()),
  },
  (t) => [
    index("tasks_user_status_idx").on(t.userId, t.status, t.dueOn),
    uniqueIndex("tasks_user_github_idx")
      .on(t.userId, t.githubRepo, t.githubNumber)
      .where(sql`github_number is not null`),
  ]
);

/**
 * A person's connection to GitHub for their Tasks (Settings → Tasks, #3111): a personal access token of their own,
 * kept encrypted (`sealSecret`, purpose `github-token`), and the account it belongs to as GitHub named it when the
 * token was checked. Workspace reads the issues assigned to that account with it, and closes or reopens an issue
 * when its task is marked done or reopened. Disconnecting deletes the row; nothing of the token stays.
 */
export const githubConnections = sqliteTable("github_connections", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  login: text("login").notNull(),
  name: text("name"),
  tokenSealed: text("token_sealed").notNull(),
  createdAt: text("created_at").notNull().default(now()),
});

export type CalendarEvent = typeof calendarEvents.$inferSelect;

export type CalendarAttendee = typeof calendarAttendees.$inferSelect;

export type Task = typeof tasks.$inferSelect;

export type GithubConnection = typeof githubConnections.$inferSelect;
