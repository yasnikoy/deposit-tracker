PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agency_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`value_date` text NOT NULL,
	`kind` text NOT NULL,
	`evidence_document_id` integer,
	`unallocated_reason` text,
	`created_by` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`voided_at` text,
	`voided_by` integer,
	`void_reason` text,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evidence_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "refunds_amount" CHECK("__new_refunds"."amount_minor" > 0),
	CONSTRAINT "refunds_kind" CHECK("__new_refunds"."kind" IN ('BANK', 'OFFSET')),
	CONSTRAINT "refunds_value_date" CHECK("__new_refunds"."value_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "refunds_unallocated_reason" CHECK("__new_refunds"."unallocated_reason" IS NULL OR length(trim("__new_refunds"."unallocated_reason")) > 0),
	CONSTRAINT "refunds_void" CHECK(("__new_refunds"."voided_at" IS NULL AND "__new_refunds"."voided_by" IS NULL AND "__new_refunds"."void_reason" IS NULL)
      OR ("__new_refunds"."voided_at" IS NOT NULL AND "__new_refunds"."voided_by" IS NOT NULL AND length(trim("__new_refunds"."void_reason")) > 0))
);
--> statement-breakpoint
INSERT INTO `__new_refunds`("id", "agency_id", "amount_minor", "currency", "value_date", "kind", "evidence_document_id", "unallocated_reason", "created_by", "created_at", "updated_at", "voided_at", "voided_by", "void_reason") SELECT "id", "agency_id", "amount_minor", "currency", "value_date", "kind", "evidence_document_id", "unallocated_reason", "created_by", "created_at", "updated_at", "voided_at", "voided_by", "void_reason" FROM `refunds`;--> statement-breakpoint
DROP TABLE `refunds`;--> statement-breakpoint
ALTER TABLE `__new_refunds` RENAME TO `refunds`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_evidence_unique` ON `refunds` (`evidence_document_id`);--> statement-breakpoint
CREATE INDEX `refunds_duplicate_lookup` ON `refunds` (`agency_id`,`value_date`,`amount_minor`);