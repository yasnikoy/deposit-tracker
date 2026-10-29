CREATE TABLE `email_bl_links` (
	`email_id` integer NOT NULL,
	`bl_id` integer NOT NULL,
	`linked_by` text NOT NULL,
	`linked_by_user` integer,
	`created_at` text NOT NULL,
	PRIMARY KEY(`email_id`, `bl_id`),
	FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bl_id`) REFERENCES `bills_of_lading`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_by_user`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "email_bl_links_linked_by" CHECK("email_bl_links"."linked_by" IN ('THREAD', 'SUGGESTION', 'MANUAL')),
	CONSTRAINT "email_bl_links_user" CHECK(("email_bl_links"."linked_by" = 'THREAD') = ("email_bl_links"."linked_by_user" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `email_bl_links_bl` ON `email_bl_links` (`bl_id`);--> statement-breakpoint
CREATE TABLE `email_match_suggestions` (
	`email_id` integer NOT NULL,
	`bl_id` integer NOT NULL,
	`state` text DEFAULT 'OPEN' NOT NULL,
	`resolved_by` integer,
	`resolved_at` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`email_id`, `bl_id`),
	FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bl_id`) REFERENCES `bills_of_lading`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "email_match_suggestions_state" CHECK("email_match_suggestions"."state" IN ('OPEN', 'ACCEPTED', 'DISMISSED')),
	CONSTRAINT "email_match_suggestions_resolved" CHECK(("email_match_suggestions"."state" = 'OPEN') = ("email_match_suggestions"."resolved_by" IS NULL AND "email_match_suggestions"."resolved_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `mailbox_state` (
	`folder` text PRIMARY KEY NOT NULL,
	`uid_validity` text NOT NULL,
	`last_uid` integer NOT NULL,
	`last_polled_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `replies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bl_id` integer NOT NULL,
	`reply_type_id` integer NOT NULL,
	`replied_on` text NOT NULL,
	`email_id` integer,
	`note` text,
	`created_by` integer NOT NULL,
	`role_used` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`bl_id`) REFERENCES `bills_of_lading`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_type_id`) REFERENCES `reply_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "replies_replied_on" CHECK("replies"."replied_on" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "replies_role_used" CHECK("replies"."role_used" IN ('ACCOUNTANT', 'OPERATIONS', 'ADMIN'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `replies_email_bl_unique` ON `replies` (`email_id`,`bl_id`) WHERE "replies"."email_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `replies_bl` ON `replies` (`bl_id`);--> statement-breakpoint
CREATE TABLE `reply_types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "reply_types_code" CHECK("reply_types"."code" IS NULL OR "reply_types"."code" IN ('NOT_RETURNED', 'APPROVED', 'STATEMENT_RECEIVED', 'INFO')),
	CONSTRAINT "reply_types_system_active" CHECK("reply_types"."code" IS NULL OR "reply_types"."active" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reply_types_code_unique` ON `reply_types` (`code`) WHERE "reply_types"."code" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `reply_types_name_unique` ON `reply_types` (lower("name"));--> statement-breakpoint
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
	CONSTRAINT "jobs_kind" CHECK("__new_jobs"."kind" IN ('SEND_EMAIL', 'COPY_TO_SENT_FOLDER', 'IMAP_POLL', 'DAILY_UNPROCESSED_EMAIL')),
	CONSTRAINT "jobs_status" CHECK("__new_jobs"."status" IN ('PENDING', 'RUNNING', 'DONE', 'FAILED'))
);
--> statement-breakpoint
INSERT INTO `__new_jobs`("id", "kind", "payload", "run_at", "status", "attempts", "last_error", "created_at", "updated_at") SELECT "id", "kind", "payload", "run_at", "status", "attempts", "last_error", "created_at", "updated_at" FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `jobs_due` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE TABLE `__new_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`owner_type` text,
	`owner_id` integer,
	`original_name` text NOT NULL,
	`stored_path` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`uploaded_by` integer,
	`uploaded_at` text NOT NULL,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "documents_kind" CHECK("__new_documents"."kind" IN ('FORM', 'FORM_TEMPLATE', 'GENERATED_FORM', 'RECEIPT', 'INVOICE', 'DEDUCTION_STATEMENT', 'STANDING', 'OTHER')),
	CONSTRAINT "documents_owner" CHECK(("__new_documents"."owner_type" IS NULL) = ("__new_documents"."owner_id" IS NULL)),
	CONSTRAINT "documents_size" CHECK("__new_documents"."size_bytes" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_documents`("id", "kind", "owner_type", "owner_id", "original_name", "stored_path", "mime_type", "size_bytes", "sha256", "uploaded_by", "uploaded_at") SELECT "id", "kind", "owner_type", "owner_id", "original_name", "stored_path", "mime_type", "size_bytes", "sha256", "uploaded_by", "uploaded_at" FROM `documents`;--> statement-breakpoint
DROP TABLE `documents`;--> statement-breakpoint
ALTER TABLE `__new_documents` RENAME TO `documents`;--> statement-breakpoint
CREATE UNIQUE INDEX `documents_stored_path_unique` ON `documents` (`stored_path`);--> statement-breakpoint
CREATE INDEX `documents_owner` ON `documents` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE TABLE `__new_emails` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`direction` text NOT NULL,
	`agency_id` integer,
	`message_id` text NOT NULL,
	`in_reply_to` text,
	`references` text DEFAULT '[]' NOT NULL,
	`from_address` text NOT NULL,
	`to` text NOT NULL,
	`cc` text DEFAULT '[]' NOT NULL,
	`bcc` text DEFAULT '[]' NOT NULL,
	`subject` text NOT NULL,
	`body_text` text NOT NULL,
	`send_status` text,
	`dry_run` integer DEFAULT false NOT NULL,
	`send_attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`queued_by` integer,
	`role_used` text,
	`sent_at` text,
	`copied_to_sent_at` text,
	`raw_document_id` integer,
	`received_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`queued_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`raw_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "emails_direction" CHECK("__new_emails"."direction" IN ('OUT', 'IN')),
	CONSTRAINT "emails_send_status" CHECK(("__new_emails"."direction" = 'OUT') = ("__new_emails"."send_status" IS NOT NULL)),
	CONSTRAINT "emails_received_at" CHECK(("__new_emails"."direction" = 'IN') = ("__new_emails"."received_at" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_emails`("id", "direction", "agency_id", "message_id", "in_reply_to", "references", "from_address", "to", "cc", "bcc", "subject", "body_text", "send_status", "dry_run", "send_attempts", "last_error", "queued_by", "role_used", "sent_at", "copied_to_sent_at", "raw_document_id", "received_at", "created_at") SELECT "id", "direction", "agency_id", "message_id", "in_reply_to", "references", "from_address", "to", "cc", "bcc", "subject", "body_text", "send_status", "dry_run", "send_attempts", "last_error", "queued_by", "role_used", "sent_at", "copied_to_sent_at", "raw_document_id", NULL, "created_at" FROM `emails`;--> statement-breakpoint
DROP TABLE `emails`;--> statement-breakpoint
ALTER TABLE `__new_emails` RENAME TO `emails`;--> statement-breakpoint
CREATE UNIQUE INDEX `emails_message_id_unique` ON `emails` (`message_id`);--> statement-breakpoint
CREATE INDEX `emails_in_reply_to` ON `emails` (`in_reply_to`);