CREATE TABLE `feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`page` text,
	`created_by` integer NOT NULL,
	`created_at` text NOT NULL,
	`closed_by` integer,
	`closed_at` text,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "feedback_kind" CHECK("feedback"."kind" IN ('BUG', 'IDEA')),
	CONSTRAINT "feedback_body" CHECK(length(trim("feedback"."body")) > 0),
	CONSTRAINT "feedback_closed" CHECK(("feedback"."closed_by" IS NULL) = ("feedback"."closed_at" IS NULL))
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`kind` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`detail` text NOT NULL,
	`created_at` text NOT NULL,
	`read_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notifications_kind" CHECK("__new_notifications"."kind" IN ('MENTION', 'CORRECTION', 'UNPROCESSED_REPLY', 'WRITE_OFF_PROPOSED', 'WRITE_OFF_DECIDED', 'NEW_AGENCY', 'NEW_CUSTOMER', 'NEW_FEEDBACK'))
);
--> statement-breakpoint
INSERT INTO `__new_notifications`("id", "user_id", "kind", "entity_type", "entity_id", "detail", "created_at", "read_at") SELECT "id", "user_id", "kind", "entity_type", "entity_id", "detail", "created_at", "read_at" FROM `notifications`;--> statement-breakpoint
DROP TABLE `notifications`;--> statement-breakpoint
ALTER TABLE `__new_notifications` RENAME TO `notifications`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_unprocessed_once` ON `notifications` (`user_id`,`entity_id`) WHERE "notifications"."kind" = 'UNPROCESSED_REPLY';--> statement-breakpoint
CREATE INDEX `notifications_user` ON `notifications` (`user_id`,`read_at`);