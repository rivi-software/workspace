CREATE TABLE `assistant_undos` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`undo` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`used_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assistant_undos_user_idx` ON `assistant_undos` (`user_id`,`created_at`);