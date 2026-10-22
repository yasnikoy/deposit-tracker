CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`actor_user_id` integer,
	`role_used` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`before` text,
	`after` text,
	`reason` text,
	`undo_of` integer,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`undo_of`) REFERENCES `audit_log`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "audit_log_role_used" CHECK("audit_log"."role_used" IS NULL OR "audit_log"."role_used" IN ('ACCOUNTANT', 'OPERATIONS', 'ADMIN'))
);
--> statement-breakpoint
CREATE INDEX `audit_log_entity` ON `audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_log_actor` ON `audit_log` (`actor_user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user_id` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` integer,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `settings_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`old_value` text,
	`new_value` text NOT NULL,
	`changed_by` integer,
	`changed_at` text NOT NULL,
	FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `settings_history_key` ON `settings_history` (`key`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` integer NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `user_roles` (
	`user_id` integer NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`user_id`, `role`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "user_roles_role" CHECK("user_roles"."role" IN ('ACCOUNTANT', 'OPERATIONS', 'ADMIN'))
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`must_change_password` integer DEFAULT true NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`failed_login_count` integer DEFAULT 0 NOT NULL,
	`locked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "users_username_format" CHECK("users"."username" NOT GLOB '*[^A-Za-z0-9._-]*' AND length("users"."username") BETWEEN 2 AND 64),
	CONSTRAINT "users_failed_login_count" CHECK("users"."failed_login_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (lower("username"));