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
	CONSTRAINT "jobs_kind" CHECK("__new_jobs"."kind" IN ('SEND_EMAIL', 'COPY_TO_SENT_FOLDER', 'IMAP_POLL', 'DAILY_UNPROCESSED_EMAIL', 'WEEKLY_SUMMARY_EMAIL', 'BACKUP')),
	CONSTRAINT "jobs_status" CHECK("__new_jobs"."status" IN ('PENDING', 'RUNNING', 'DONE', 'FAILED'))
);
--> statement-breakpoint
INSERT INTO `__new_jobs`("id", "kind", "payload", "run_at", "status", "attempts", "last_error", "created_at", "updated_at") SELECT "id", "kind", "payload", "run_at", "status", "attempts", "last_error", "created_at", "updated_at" FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `jobs_due` ON `jobs` (`status`,`run_at`);