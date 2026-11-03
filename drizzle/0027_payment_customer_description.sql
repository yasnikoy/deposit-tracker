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
	CONSTRAINT "notifications_kind" CHECK("__new_notifications"."kind" IN ('MENTION', 'CORRECTION', 'UNPROCESSED_REPLY', 'WRITE_OFF_PROPOSED', 'WRITE_OFF_DECIDED', 'NEW_AGENCY', 'NEW_CUSTOMER'))
);
--> statement-breakpoint
INSERT INTO `__new_notifications`("id", "user_id", "kind", "entity_type", "entity_id", "detail", "created_at", "read_at") SELECT "id", "user_id", "kind", "entity_type", "entity_id", "detail", "created_at", "read_at" FROM `notifications`;--> statement-breakpoint
DROP TABLE `notifications`;--> statement-breakpoint
ALTER TABLE `__new_notifications` RENAME TO `notifications`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_unprocessed_once` ON `notifications` (`user_id`,`entity_id`) WHERE "notifications"."kind" = 'UNPROCESSED_REPLY';--> statement-breakpoint
CREATE INDEX `notifications_user` ON `notifications` (`user_id`,`read_at`);--> statement-breakpoint
ALTER TABLE `deposit_payments` ADD `customer_id` integer REFERENCES customers(id);--> statement-breakpoint
ALTER TABLE `deposit_payments` ADD `file_no` text;--> statement-breakpoint
ALTER TABLE `deposit_payments` ADD `description` text;