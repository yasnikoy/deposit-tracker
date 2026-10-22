CREATE TABLE `bank_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`bank_name` text NOT NULL,
	`iban` text NOT NULL,
	`currency` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_accounts_iban_unique` ON `bank_accounts` (`iban`);--> statement-breakpoint
CREATE TABLE `bills_of_lading` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bl_no` text NOT NULL,
	`deposit_payment_id` integer,
	`agency_id` integer NOT NULL,
	`currency` text NOT NULL,
	`deposit_amount_minor` integer NOT NULL,
	`paid_at` text NOT NULL,
	`status` text NOT NULL,
	`created_by` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`voided_at` text,
	`voided_by` integer,
	`void_reason` text,
	FOREIGN KEY (`deposit_payment_id`) REFERENCES `deposit_payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bills_of_lading_amount" CHECK("bills_of_lading"."deposit_amount_minor" > 0),
	CONSTRAINT "bills_of_lading_status" CHECK("bills_of_lading"."status" IN ('PAID', 'REQUESTED', 'AWAITING_RETURN', 'DEDUCTION_OPEN', 'DISPUTED', 'COLLECTED')),
	CONSTRAINT "bills_of_lading_void" CHECK(("bills_of_lading"."voided_at" IS NULL AND "bills_of_lading"."voided_by" IS NULL AND "bills_of_lading"."void_reason" IS NULL)
      OR ("bills_of_lading"."voided_at" IS NOT NULL AND "bills_of_lading"."voided_by" IS NOT NULL AND length(trim("bills_of_lading"."void_reason")) > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bills_of_lading_payment_active` ON `bills_of_lading` (`deposit_payment_id`) WHERE "bills_of_lading"."voided_at" IS NULL AND "bills_of_lading"."deposit_payment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `bills_of_lading_bl_no_active` ON `bills_of_lading` (upper("bl_no")) WHERE "bills_of_lading"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX `bills_of_lading_agency` ON `bills_of_lading` (`agency_id`);--> statement-breakpoint
CREATE TABLE `containers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bl_id` integer NOT NULL,
	`container_no` text NOT NULL,
	`type` text,
	FOREIGN KEY (`bl_id`) REFERENCES `bills_of_lading`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `containers_bl_container_unique` ON `containers` (`bl_id`,`container_no`);--> statement-breakpoint
CREATE TABLE `currencies` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`minor_unit_digits` integer DEFAULT 2 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "currencies_code" CHECK("currencies"."code" GLOB '[A-Z][A-Z][A-Z]'),
	CONSTRAINT "currencies_minor_unit_digits" CHECK("currencies"."minor_unit_digits" = 2)
);
--> statement-breakpoint
CREATE TABLE `deposit_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agency_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`paid_at` text NOT NULL,
	`kind` text NOT NULL,
	`bank_account_id` integer,
	`evidence_document_id` integer NOT NULL,
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
	FOREIGN KEY (`bank_account_id`) REFERENCES `bank_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evidence_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "deposit_payments_amount" CHECK("deposit_payments"."amount_minor" > 0),
	CONSTRAINT "deposit_payments_kind" CHECK("deposit_payments"."kind" IN ('BANK', 'OFFSET')),
	CONSTRAINT "deposit_payments_bank_account" CHECK(("deposit_payments"."kind" = 'BANK') = ("deposit_payments"."bank_account_id" IS NOT NULL)),
	CONSTRAINT "deposit_payments_paid_at" CHECK("deposit_payments"."paid_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "deposit_payments_void" CHECK(("deposit_payments"."voided_at" IS NULL AND "deposit_payments"."voided_by" IS NULL AND "deposit_payments"."void_reason" IS NULL)
      OR ("deposit_payments"."voided_at" IS NOT NULL AND "deposit_payments"."voided_by" IS NOT NULL AND length(trim("deposit_payments"."void_reason")) > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deposit_payments_evidence_unique` ON `deposit_payments` (`evidence_document_id`);--> statement-breakpoint
CREATE INDEX `deposit_payments_duplicate_lookup` ON `deposit_payments` (`agency_id`,`paid_at`,`amount_minor`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`owner_type` text,
	`owner_id` integer,
	`original_name` text NOT NULL,
	`stored_path` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`uploaded_by` integer NOT NULL,
	`uploaded_at` text NOT NULL,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "documents_kind" CHECK("documents"."kind" IN ('FORM', 'FORM_TEMPLATE', 'GENERATED_FORM', 'RECEIPT', 'INVOICE', 'DEDUCTION_STATEMENT', 'STANDING', 'OTHER')),
	CONSTRAINT "documents_owner" CHECK(("documents"."owner_type" IS NULL) = ("documents"."owner_id" IS NULL)),
	CONSTRAINT "documents_size" CHECK("documents"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_stored_path_unique` ON `documents` (`stored_path`);--> statement-breakpoint
CREATE INDEX `documents_owner` ON `documents` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bl_id` integer NOT NULL,
	`type` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`entry_date` text NOT NULL,
	`deposit_payment_id` integer,
	`compensates_entry_id` integer,
	`created_by` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`bl_id`) REFERENCES `bills_of_lading`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deposit_payment_id`) REFERENCES `deposit_payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`compensates_entry_id`) REFERENCES `ledger_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ledger_entries_type" CHECK("ledger_entries"."type" IN ('PAYMENT', 'OFFSET', 'DEDUCTION', 'REFUND_ALLOCATION', 'OPENING_BALANCE')),
	CONSTRAINT "ledger_entries_amount" CHECK("ledger_entries"."amount_minor" <> 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_entries_compensates_unique` ON `ledger_entries` (`compensates_entry_id`) WHERE "ledger_entries"."compensates_entry_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `ledger_entries_bl` ON `ledger_entries` (`bl_id`);--> statement-breakpoint
CREATE TABLE `receipt_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` integer NOT NULL,
	`extracted` text NOT NULL,
	`created_by` integer NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`resolution` text,
	`payment_id` integer,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `deposit_payments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "receipt_queue_resolution" CHECK(("receipt_queue"."resolved_at" IS NULL AND "receipt_queue"."resolution" IS NULL AND "receipt_queue"."payment_id" IS NULL)
        OR ("receipt_queue"."resolution" = 'DISCARDED' AND "receipt_queue"."resolved_at" IS NOT NULL AND "receipt_queue"."payment_id" IS NULL)
        OR ("receipt_queue"."resolution" = 'SAVED' AND "receipt_queue"."resolved_at" IS NOT NULL AND "receipt_queue"."payment_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_queue_document_unique` ON `receipt_queue` (`document_id`);