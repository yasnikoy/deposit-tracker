CREATE TABLE `notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bl_id` integer NOT NULL,
	`author_id` integer NOT NULL,
	`body` text NOT NULL,
	`mentioned_user_ids` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`undone_at` text,
	`undone_by` integer,
	FOREIGN KEY (`bl_id`) REFERENCES `bills_of_lading`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`undone_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notes_body" CHECK(length(trim("notes"."body")) > 0),
	CONSTRAINT "notes_undone" CHECK(("notes"."undone_at" IS NULL) = ("notes"."undone_by" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `notes_bl` ON `notes` (`bl_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`kind` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`detail` text NOT NULL,
	`created_at` text NOT NULL,
	`read_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notifications_kind" CHECK("notifications"."kind" IN ('MENTION', 'CORRECTION', 'UNPROCESSED_REPLY', 'WRITE_OFF_PROPOSED', 'WRITE_OFF_DECIDED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_unprocessed_once` ON `notifications` (`user_id`,`entity_id`) WHERE "notifications"."kind" = 'UNPROCESSED_REPLY';--> statement-breakpoint
CREATE INDEX `notifications_user` ON `notifications` (`user_id`,`read_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`run_at` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "jobs_kind" CHECK("__new_jobs"."kind" IN ('SEND_EMAIL', 'COPY_TO_SENT_FOLDER', 'IMAP_POLL', 'DAILY_UNPROCESSED_EMAIL', 'WEEKLY_SUMMARY_EMAIL')),
	CONSTRAINT "jobs_status" CHECK("__new_jobs"."status" IN ('PENDING', 'RUNNING', 'DONE', 'FAILED'))
);
--> statement-breakpoint
INSERT INTO `__new_jobs`("id", "kind", "payload", "run_at", "status", "attempts", "last_error", "created_at", "updated_at") SELECT "id", "kind", "payload", "run_at", "status", "attempts", "last_error", "created_at", "updated_at" FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `jobs_due` ON `jobs` (`status`,`run_at`);