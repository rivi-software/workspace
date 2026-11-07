CREATE TABLE `pgp_keys` (
	`user_id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`public_key` text NOT NULL,
	`private_key_sealed` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pgp_peer_keys` (
	`user_id` text NOT NULL,
	`address` text NOT NULL,
	`fingerprint` text NOT NULL,
	`public_key` text NOT NULL,
	`source` text NOT NULL,
	`prefer_encrypt` integer DEFAULT false NOT NULL,
	`seen_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`user_id`, `address`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `drafts` ADD `pgp_sign` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `drafts` ADD `pgp_encrypt` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `pgp_json` text;