CREATE TABLE `auth_identity_links` (
	`google_user_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_identity_links_owner_id_unique` ON `auth_identity_links` (`owner_id`);--> statement-breakpoint
CREATE TABLE `auth_oauth_flows` (
	`nonce_hash` text PRIMARY KEY NOT NULL,
	`intent` text NOT NULL,
	`sites_owner_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_oauth_flows_expires_at_idx` ON `auth_oauth_flows` (`expires_at`);