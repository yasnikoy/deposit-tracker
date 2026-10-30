PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_replies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bl_id` integer NOT NULL,
	`reply_type_id` integer NOT NULL,
	`replied_on` text NOT NULL,
	`email_id` integer,
	`note` text,
	`created_by` integer NOT NULL,
	`role_used` text NOT NULL,
	`created_at` text NOT NULL,
	`undone_at` text,
	`undone_by` integer,
	FOREIGN KEY (`bl_id`) REFERENCES `bills_of_lading`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_type_id`) REFERENCES `reply_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`undone_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "replies_replied_on" CHECK("__new_replies"."replied_on" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "replies_role_used" CHECK("__new_replies"."role_used" IN ('ACCOUNTANT', 'OPERATIONS', 'ADMIN')),
	CONSTRAINT "replies_undone" CHECK(("__new_replies"."undone_at" IS NULL) = ("__new_replies"."undone_by" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_replies`("id", "bl_id", "reply_type_id", "replied_on", "email_id", "note", "created_by", "role_used", "created_at", "undone_at", "undone_by") SELECT "id", "bl_id", "reply_type_id", "replied_on", "email_id", "note", "created_by", "role_used", "created_at", NULL, NULL FROM `replies`;--> statement-breakpoint
DROP TABLE `replies`;--> statement-breakpoint
ALTER TABLE `__new_replies` RENAME TO `replies`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `replies_email_bl_unique` ON `replies` (`email_id`,`bl_id`) WHERE "replies"."email_id" IS NOT NULL AND "replies"."undone_at" IS NULL;--> statement-breakpoint
CREATE INDEX `replies_bl` ON `replies` (`bl_id`);--> statement-breakpoint
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
	`withdrawn_at` text,
	`withdrawn_by` integer,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`withdrawn_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "documents_kind" CHECK("__new_documents"."kind" IN ('FORM', 'FORM_TEMPLATE', 'GENERATED_FORM', 'RECEIPT', 'INVOICE', 'DEDUCTION_STATEMENT', 'STANDING', 'OTHER')),
	CONSTRAINT "documents_withdrawn" CHECK(("__new_documents"."withdrawn_at" IS NULL) = ("__new_documents"."withdrawn_by" IS NULL)),
	CONSTRAINT "documents_owner" CHECK(("__new_documents"."owner_type" IS NULL) = ("__new_documents"."owner_id" IS NULL)),
	CONSTRAINT "documents_size" CHECK("__new_documents"."size_bytes" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_documents`("id", "kind", "owner_type", "owner_id", "original_name", "stored_path", "mime_type", "size_bytes", "sha256", "uploaded_by", "uploaded_at", "withdrawn_at", "withdrawn_by") SELECT "id", "kind", "owner_type", "owner_id", "original_name", "stored_path", "mime_type", "size_bytes", "sha256", "uploaded_by", "uploaded_at", NULL, NULL FROM `documents`;--> statement-breakpoint
DROP TABLE `documents`;--> statement-breakpoint
ALTER TABLE `__new_documents` RENAME TO `documents`;--> statement-breakpoint
CREATE UNIQUE INDEX `documents_stored_path_unique` ON `documents` (`stored_path`);--> statement-breakpoint
CREATE INDEX `documents_owner` ON `documents` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE TABLE `__new_email_bl_links` (
	`email_id` integer NOT NULL,
	`bl_id` integer NOT NULL,
	`linked_by` text NOT NULL,
	`linked_by_user` integer,
	`created_at` text NOT NULL,
	`unlinked_at` text,
	`unlinked_by` integer,
	PRIMARY KEY(`email_id`, `bl_id`),
	FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bl_id`) REFERENCES `bills_of_lading`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_by_user`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unlinked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "email_bl_links_unlinked" CHECK(("__new_email_bl_links"."unlinked_at" IS NULL) = ("__new_email_bl_links"."unlinked_by" IS NULL) AND ("__new_email_bl_links"."unlinked_at" IS NULL OR "__new_email_bl_links"."linked_by" <> 'THREAD')),
	CONSTRAINT "email_bl_links_linked_by" CHECK("__new_email_bl_links"."linked_by" IN ('THREAD', 'SUGGESTION', 'MANUAL')),
	CONSTRAINT "email_bl_links_user" CHECK(("__new_email_bl_links"."linked_by" = 'THREAD') = ("__new_email_bl_links"."linked_by_user" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_email_bl_links`("email_id", "bl_id", "linked_by", "linked_by_user", "created_at", "unlinked_at", "unlinked_by") SELECT "email_id", "bl_id", "linked_by", "linked_by_user", "created_at", NULL, NULL FROM `email_bl_links`;--> statement-breakpoint
DROP TABLE `email_bl_links`;--> statement-breakpoint
ALTER TABLE `__new_email_bl_links` RENAME TO `email_bl_links`;--> statement-breakpoint
CREATE INDEX `email_bl_links_bl` ON `email_bl_links` (`bl_id`);