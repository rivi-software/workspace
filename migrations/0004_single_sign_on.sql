CREATE TABLE `oauth_client_members` (
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`client_id`, `user_id`),
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `oauth_client_members_user_idx` ON `oauth_client_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`secret_hash` text NOT NULL,
	`redirect_uris_json` text DEFAULT '[]' NOT NULL,
	`post_logout_redirect_uris_json` text DEFAULT '[]' NOT NULL,
	`launch_url` text,
	`pkce_required` integer DEFAULT true NOT NULL,
	`access` text DEFAULT 'everyone' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`scope` text NOT NULL,
	`nonce` text,
	`code_challenge` text,
	`sid` text,
	`auth_time` integer NOT NULL,
	`amr_json` text DEFAULT '[]' NOT NULL,
	`role` text,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_codes_expires_idx` ON `oauth_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_signing_keys` (
	`kid` text PRIMARY KEY NOT NULL,
	`alg` text DEFAULT 'ES256' NOT NULL,
	`private_jwk` text NOT NULL,
	`public_jwk` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`retired_at` text
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `amr` text;