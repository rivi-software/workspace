CREATE TABLE `search_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`user_id` text NOT NULL,
	`source_at` text NOT NULL,
	`indexed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `search_entries_kind_idx` ON `search_entries` (`kind`,`id`);--> statement-breakpoint
CREATE TABLE `search_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
