CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `accounts_user_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `aliases` (
	`address` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `aliases_user_idx` ON `aliases` (`user_id`);--> statement-breakpoint
CREATE TABLE `assistant_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assistant_conversations_user_idx` ON `assistant_conversations` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `assistant_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`parts_json` text DEFAULT '[]' NOT NULL,
	`model` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `assistant_conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assistant_messages_conversation_idx` ON `assistant_messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`r2_key` text NOT NULL,
	`content_id` text,
	`inline` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attachments_message_idx` ON `attachments` (`message_id`);--> statement-breakpoint
CREATE TABLE `calendar_attendees` (
	`event_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'needs-action' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`event_id`, `user_id`),
	FOREIGN KEY (`event_id`) REFERENCES `calendar_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `calendar_attendees_user_idx` ON `calendar_attendees` (`user_id`);--> statement-breakpoint
CREATE TABLE `calendar_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`repeat` text DEFAULT 'none' NOT NULL,
	`repeat_until` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `calendar_events_user_idx` ON `calendar_events` (`user_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`times_used` integer DEFAULT 1 NOT NULL,
	`last_used_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`written_at` text,
	PRIMARY KEY(`user_id`, `email`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contacts_user_used_idx` ON `contacts` (`user_id`,`last_used_at`);--> statement-breakpoint
CREATE TABLE `draft_files` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`user_id` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`r2_key` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `draft_files_draft_idx` ON `draft_files` (`draft_id`);--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`thread_id` text,
	`in_reply_to_id` text,
	`mode` text DEFAULT 'new' NOT NULL,
	`from_email` text NOT NULL,
	`to_json` text DEFAULT '[]' NOT NULL,
	`cc_json` text DEFAULT '[]' NOT NULL,
	`bcc_json` text DEFAULT '[]' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`html` text,
	`signature_id` text,
	`scheduled_at` text,
	`send_error` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`signature_id`) REFERENCES `signatures`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `drafts_user_idx` ON `drafts` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `drafts_scheduled_idx` ON `drafts` (`scheduled_at`);--> statement-breakpoint
CREATE TABLE `drive_links` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_sealed` text NOT NULL,
	`email` text,
	`password_hash` text,
	`allow_download` integer DEFAULT true NOT NULL,
	`expires_at` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`revoked_at` text,
	`revoked_by` text,
	`code_hash` text,
	`code_expires_at` text,
	`code_attempts` integer DEFAULT 0 NOT NULL,
	`confirmed_at` text,
	`views` integer DEFAULT 0 NOT NULL,
	`downloads` integer DEFAULT 0 NOT NULL,
	`last_viewed_at` text,
	FOREIGN KEY (`node_id`) REFERENCES `drive_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drive_links_token_idx` ON `drive_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `drive_links_node_idx` ON `drive_links` (`node_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `drive_links_created_idx` ON `drive_links` (`created_at`);--> statement-breakpoint
CREATE TABLE `drive_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`parent_id` text,
	`path` text DEFAULT '/' NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`r2_key` text,
	`status` text DEFAULT 'ready' NOT NULL,
	`upload_id` text,
	`created_by` text,
	`trashed_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `drive_nodes_parent_idx` ON `drive_nodes` (`parent_id`,`name`);--> statement-breakpoint
CREATE INDEX `drive_nodes_user_idx` ON `drive_nodes` (`user_id`,`parent_id`);--> statement-breakpoint
CREATE INDEX `drive_nodes_path_idx` ON `drive_nodes` (`path`);--> statement-breakpoint
CREATE INDEX `drive_nodes_user_trashed_idx` ON `drive_nodes` (`user_id`,`trashed_at`);--> statement-breakpoint
CREATE INDEX `drive_nodes_user_updated_idx` ON `drive_nodes` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `drive_nodes_status_idx` ON `drive_nodes` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `drive_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`subject` text NOT NULL,
	`user_id` text,
	`role` text DEFAULT 'viewer' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `drive_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drive_shares_node_subject_idx` ON `drive_shares` (`node_id`,`subject`);--> statement-breakpoint
CREATE INDEX `drive_shares_subject_idx` ON `drive_shares` (`subject`,`created_at`);--> statement-breakpoint
CREATE TABLE `drive_stars` (
	`user_id` text NOT NULL,
	`node_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`user_id`, `node_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`node_id`) REFERENCES `drive_nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `filters` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`conditions_json` text DEFAULT '{}' NOT NULL,
	`actions_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `filters_user_idx` ON `filters` (`user_id`,`position`);--> statement-breakpoint
CREATE TABLE `github_connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`login` text NOT NULL,
	`name` text,
	`token_sealed` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `hand_signatures` (
	`user_id` text PRIMARY KEY NOT NULL,
	`png` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `image_senders` (
	`user_id` text NOT NULL,
	`sender` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`user_id`, `sender`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'gray' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_user_name_idx` ON `labels` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `mail_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text DEFAULT 'microsoft' NOT NULL,
	`account` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`tokens_sealed` text,
	`folders_json` text DEFAULT '{}' NOT NULL,
	`cursor_json` text DEFAULT '{}' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`imported` integer DEFAULT 0 NOT NULL,
	`duplicates` integer DEFAULT 0 NOT NULL,
	`left_out` integer DEFAULT 0 NOT NULL,
	`left_out_json` text DEFAULT '[]' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`lease_until` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mail_imports_user_idx` ON `mail_imports` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `mail_imports_status_idx` ON `mail_imports` (`status`,`lease_until`);--> statement-breakpoint
CREATE UNIQUE INDEX `mail_imports_user_running_idx` ON `mail_imports` (`user_id`) WHERE status = 'running';--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`user_id` text NOT NULL,
	`direction` text NOT NULL,
	`message_id` text NOT NULL,
	`in_reply_to` text,
	`references_header` text,
	`from_email` text NOT NULL,
	`from_name` text,
	`to_json` text DEFAULT '[]' NOT NULL,
	`cc_json` text DEFAULT '[]' NOT NULL,
	`bcc_json` text DEFAULT '[]' NOT NULL,
	`reply_to` text,
	`subject` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`html` text,
	`snippet` text DEFAULT '' NOT NULL,
	`date` text NOT NULL,
	`read` integer DEFAULT false NOT NULL,
	`raw_key` text,
	`size` integer DEFAULT 0 NOT NULL,
	`delivery_status` text DEFAULT 'received' NOT NULL,
	`delivery_error` text,
	`list_unsubscribe` text,
	`spam_json` text,
	`spam_learned` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_thread_idx` ON `messages` (`thread_id`,`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_user_message_id_idx` ON `messages` (`user_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`transports` text,
	`aaguid` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passkeys_user_idx` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_idx` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE TABLE `recovery_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`address` text NOT NULL,
	`confirmed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_addresses_user_address_idx` ON `recovery_addresses` (`user_id`,`address`);--> statement-breakpoint
CREATE TABLE `recovery_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`user_id` text NOT NULL,
	`recovery_address_id` text,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recovery_address_id`) REFERENCES `recovery_addresses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recovery_tokens_user_idx` ON `recovery_tokens` (`user_id`,`purpose`,`created_at`);--> statement-breakpoint
CREATE TABLE `sender_rules` (
	`user_id` text NOT NULL,
	`sender` text NOT NULL,
	`verdict` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`user_id`, `sender`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_idx` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `signatures` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`text` text NOT NULL,
	`html` text,
	`is_default` integer DEFAULT false NOT NULL,
	`is_reply_default` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `signatures_user_idx` ON `signatures` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `signatures_user_default_idx` ON `signatures` (`user_id`) WHERE is_default = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `signatures_user_reply_default_idx` ON `signatures` (`user_id`) WHERE is_reply_default = 1;--> statement-breakpoint
CREATE TABLE `signing_events` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text,
	`actor` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`detail` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `signing_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `signing_events_request_idx` ON `signing_events` (`request_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `signing_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text,
	`name` text NOT NULL,
	`created_by` text NOT NULL,
	`signer_id` text NOT NULL,
	`auto_sign` integer DEFAULT false NOT NULL,
	`customer_name` text NOT NULL,
	`customer_email` text NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	`page_count` integer NOT NULL,
	`fields_json` text DEFAULT '[]' NOT NULL,
	`values_json` text DEFAULT '{}' NOT NULL,
	`original_key` text NOT NULL,
	`original_sha256` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_sealed` text NOT NULL,
	`code_hash` text,
	`code_expires_at` text,
	`code_attempts` integer DEFAULT 0 NOT NULL,
	`confirmed_at` text,
	`customer_signature` text,
	`customer_signed_at` text,
	`signer_signature` text,
	`signer_signed_at` text,
	`signed_key` text,
	`signed_sha256` text,
	`signed_node_id` text,
	`completed_at` text,
	`ended_at` text,
	`decline_reason` text,
	`reminded_at` text,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `drive_nodes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`signer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`signed_node_id`) REFERENCES `drive_nodes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signing_requests_token_idx` ON `signing_requests` (`token_hash`);--> statement-breakpoint
CREATE INDEX `signing_requests_created_by_idx` ON `signing_requests` (`created_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `signing_requests_signer_idx` ON `signing_requests` (`signer_id`,`status`);--> statement-breakpoint
CREATE INDEX `signing_requests_node_idx` ON `signing_requests` (`node_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `spam_tokens` (
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`spam` integer DEFAULT 0 NOT NULL,
	`ham` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`user_id`, `token`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`due_on` text,
	`completed_at` text,
	`github_repo` text,
	`github_number` integer,
	`github_url` text,
	`github_title` text,
	`github_state` text,
	`github_synced_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tasks_user_status_idx` ON `tasks` (`user_id`,`status`,`due_on`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_user_github_idx` ON `tasks` (`user_id`,`github_repo`,`github_number`) WHERE github_number is not null;--> statement-breakpoint
CREATE TABLE `thread_labels` (
	`thread_id` text NOT NULL,
	`label_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`thread_id`, `label_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `thread_labels_user_label_idx` ON `thread_labels` (`user_id`,`label_id`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`subject` text NOT NULL,
	`snippet` text DEFAULT '' NOT NULL,
	`folder` text DEFAULT 'inbox' NOT NULL,
	`starred` integer DEFAULT false NOT NULL,
	`trashed_at` text,
	`snoozed_until` text,
	`muted` integer DEFAULT false NOT NULL,
	`message_count` integer DEFAULT 0 NOT NULL,
	`unread_count` integer DEFAULT 0 NOT NULL,
	`sent_count` integer DEFAULT 0 NOT NULL,
	`has_attachments` integer DEFAULT false NOT NULL,
	`participants_json` text DEFAULT '[]' NOT NULL,
	`last_message_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `threads_user_folder_idx` ON `threads` (`user_id`,`folder`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `threads_user_starred_idx` ON `threads` (`user_id`,`starred`);--> statement-breakpoint
CREATE INDEX `threads_user_snoozed_idx` ON `threads` (`user_id`,`snoozed_until`);--> statement-breakpoint
CREATE TABLE `two_factors` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`secret` text NOT NULL,
	`backup_codes` text NOT NULL,
	`verified` integer,
	`failed_verification_count` integer,
	`locked_until` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `two_factors_user_idx` ON `two_factors` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`email_verified` integer DEFAULT true NOT NULL,
	`image` text,
	`role` text DEFAULT 'member' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`two_factor_enabled` integer DEFAULT false NOT NULL,
	`last_sign_in_at` text,
	`preferences_json` text DEFAULT '{}' NOT NULL,
	`vacation_on` integer DEFAULT false NOT NULL,
	`vacation_subject` text DEFAULT '' NOT NULL,
	`vacation_text` text DEFAULT '' NOT NULL,
	`vacation_from` text,
	`vacation_until` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verifications_identifier_idx` ON `verifications` (`identifier`);--> statement-breakpoint
CREATE TABLE `workspace_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
