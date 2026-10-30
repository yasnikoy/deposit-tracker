PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_deposit_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agency_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`paid_at` text NOT NULL,
	`kind` text NOT NULL,
	`evidence_document_id` integer,
	`extracted_fields` text,
	`extracted_bl_numbers` text DEFAULT '[]' NOT NULL,
	`bl_no_hint` text,
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
	CONSTRAINT "deposit_payments_amount" CHECK("__new_deposit_payments"."amount_minor" > 0),
	CONSTRAINT "deposit_payments_kind" CHECK("__new_deposit_payments"."kind" IN ('BANK', 'OFFSET')),
	CONSTRAINT "deposit_payments_paid_at" CHECK("__new_deposit_payments"."paid_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "deposit_payments_void" CHECK(("__new_deposit_payments"."voided_at" IS NULL AND "__new_deposit_payments"."voided_by" IS NULL AND "__new_deposit_payments"."void_reason" IS NULL)
      OR ("__new_deposit_payments"."voided_at" IS NOT NULL AND "__new_deposit_payments"."voided_by" IS NOT NULL AND length(trim("__new_deposit_payments"."void_reason")) > 0))
);
--> statement-breakpoint
INSERT INTO `__new_deposit_payments`("id", "agency_id", "amount_minor", "currency", "paid_at", "kind", "evidence_document_id", "extracted_fields", "extracted_bl_numbers", "bl_no_hint", "created_by", "created_at", "updated_at", "voided_at", "voided_by", "void_reason") SELECT "id", "agency_id", "amount_minor", "currency", "paid_at", "kind", "evidence_document_id", "extracted_fields", "extracted_bl_numbers", "bl_no_hint", "created_by", "created_at", "updated_at", "voided_at", "voided_by", "void_reason" FROM `deposit_payments`;--> statement-breakpoint
DROP TABLE `deposit_payments`;--> statement-breakpoint
ALTER TABLE `__new_deposit_payments` RENAME TO `deposit_payments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `deposit_payments_evidence_unique` ON `deposit_payments` (`evidence_document_id`);--> statement-breakpoint
CREATE INDEX `deposit_payments_duplicate_lookup` ON `deposit_payments` (`agency_id`,`paid_at`,`amount_minor`);