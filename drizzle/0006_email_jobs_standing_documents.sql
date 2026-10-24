CREATE TABLE `email_attachments` (
	`email_id` integer NOT NULL,
	`document_id` integer NOT NULL,
	PRIMARY KEY(`email_id`, `document_id`),
	FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `email_templates` (
	`key` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` integer,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `emails` (
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
	`created_at` text NOT NULL,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`queued_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`raw_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "emails_direction" CHECK("emails"."direction" IN ('OUT', 'IN')),
	CONSTRAINT "emails_send_status" CHECK(("emails"."direction" = 'OUT') = ("emails"."send_status" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `emails_message_id_unique` ON `emails` (`message_id`);--> statement-breakpoint
CREATE INDEX `emails_in_reply_to` ON `emails` (`in_reply_to`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`run_at` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "jobs_kind" CHECK("jobs"."kind" IN ('SEND_EMAIL', 'COPY_TO_SENT_FOLDER')),
	CONSTRAINT "jobs_status" CHECK("jobs"."status" IN ('PENDING', 'RUNNING', 'DONE', 'FAILED'))
);
--> statement-breakpoint
CREATE INDEX `jobs_due` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE TABLE `service_status` (
	`service` text PRIMARY KEY NOT NULL,
	`failing_since` text,
	`last_error` text,
	`last_ok_at` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "service_status_service" CHECK("service_status"."service" IN ('SMTP', 'IMAP'))
);
--> statement-breakpoint
CREATE TABLE `standing_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slot` text NOT NULL,
	`document_id` integer NOT NULL,
	`uploaded_by` integer NOT NULL,
	`uploaded_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "standing_documents_slot" CHECK("standing_documents"."slot" IN ('SIGNATURE_CIRCULAR', 'POWER_OF_ATTORNEY'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `standing_documents_document_unique` ON `standing_documents` (`document_id`);--> statement-breakpoint
ALTER TABLE `bills_of_lading` ADD `locked_by` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `bills_of_lading` ADD `locked_at` text;--> statement-breakpoint
ALTER TABLE `requests` ADD `email_id` integer REFERENCES emails(id);