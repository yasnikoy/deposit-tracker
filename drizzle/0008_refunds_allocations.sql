CREATE TABLE `deduction_types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "deduction_types_code" CHECK("deduction_types"."code" IS NULL OR "deduction_types"."code" IN ('UNEXPLAINED', 'WRITE_OFF')),
	CONSTRAINT "deduction_types_system_active" CHECK("deduction_types"."code" IS NULL OR "deduction_types"."active" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deduction_types_code_unique` ON `deduction_types` (`code`) WHERE "deduction_types"."code" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `deduction_types_name_unique` ON `deduction_types` (lower("name"));--> statement-breakpoint
CREATE TABLE `refund_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`refund_id` integer NOT NULL,
	`bl_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`state` text DEFAULT 'CONFIRMED' NOT NULL,
	`bl_status_before` text NOT NULL,
	`confirmed_by` integer NOT NULL,
	`role_used` text NOT NULL,
	`confirmed_at` text NOT NULL,
	`reversed_by` integer,
	`reversed_at` text,
	`reversal_reason` text,
	FOREIGN KEY (`refund_id`) REFERENCES `refunds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bl_id`) REFERENCES `bills_of_lading`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`confirmed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reversed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "refund_allocations_amount" CHECK("refund_allocations"."amount_minor" > 0),
	CONSTRAINT "refund_allocations_state" CHECK("refund_allocations"."state" IN ('CONFIRMED', 'REVERSED')),
	CONSTRAINT "refund_allocations_reversal" CHECK(("refund_allocations"."state" = 'REVERSED') = ("refund_allocations"."reversed_by" IS NOT NULL AND "refund_allocations"."reversed_at" IS NOT NULL AND length(trim("refund_allocations"."reversal_reason")) > 0)),
	CONSTRAINT "refund_allocations_role_used" CHECK("refund_allocations"."role_used" IN ('ACCOUNTANT', 'OPERATIONS', 'ADMIN'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refund_allocations_confirmed_unique` ON `refund_allocations` (`refund_id`,`bl_id`) WHERE "refund_allocations"."state" = 'CONFIRMED';--> statement-breakpoint
CREATE INDEX `refund_allocations_bl` ON `refund_allocations` (`bl_id`);--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agency_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`value_date` text NOT NULL,
	`kind` text NOT NULL,
	`evidence_document_id` integer NOT NULL,
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
	CONSTRAINT "refunds_amount" CHECK("refunds"."amount_minor" > 0),
	CONSTRAINT "refunds_kind" CHECK("refunds"."kind" IN ('BANK', 'OFFSET')),
	CONSTRAINT "refunds_value_date" CHECK("refunds"."value_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "refunds_unallocated_reason" CHECK("refunds"."unallocated_reason" IS NULL OR length(trim("refunds"."unallocated_reason")) > 0),
	CONSTRAINT "refunds_void" CHECK(("refunds"."voided_at" IS NULL AND "refunds"."voided_by" IS NULL AND "refunds"."void_reason" IS NULL)
      OR ("refunds"."voided_at" IS NOT NULL AND "refunds"."voided_by" IS NOT NULL AND length(trim("refunds"."void_reason")) > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_evidence_unique` ON `refunds` (`evidence_document_id`);--> statement-breakpoint
CREATE INDEX `refunds_duplicate_lookup` ON `refunds` (`agency_id`,`value_date`,`amount_minor`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ledger_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bl_id` integer NOT NULL,
	`type` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`entry_date` text NOT NULL,
	`deposit_payment_id` integer,
	`compensates_entry_id` integer,
	`refund_allocation_id` integer,
	`deduction_type_id` integer,
	`deduction_source` text,
	`created_by` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`bl_id`) REFERENCES `bills_of_lading`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deposit_payment_id`) REFERENCES `deposit_payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`compensates_entry_id`) REFERENCES `ledger_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`refund_allocation_id`) REFERENCES `refund_allocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deduction_type_id`) REFERENCES `deduction_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ledger_entries_type" CHECK("__new_ledger_entries"."type" IN ('PAYMENT', 'OFFSET', 'DEDUCTION', 'REFUND_ALLOCATION', 'OPENING_BALANCE')),
	CONSTRAINT "ledger_entries_deduction" CHECK(("__new_ledger_entries"."type" = 'DEDUCTION') = ("__new_ledger_entries"."deduction_type_id" IS NOT NULL AND "__new_ledger_entries"."deduction_source" IN ('STATEMENT', 'SHORTFALL', 'WRITE_OFF'))),
	CONSTRAINT "ledger_entries_allocation" CHECK("__new_ledger_entries"."type" <> 'REFUND_ALLOCATION' OR "__new_ledger_entries"."refund_allocation_id" IS NOT NULL),
	CONSTRAINT "ledger_entries_amount" CHECK("__new_ledger_entries"."amount_minor" <> 0)
);
--> statement-breakpoint
INSERT INTO `__new_ledger_entries`("id", "bl_id", "type", "amount_minor", "currency", "entry_date", "deposit_payment_id", "compensates_entry_id", "refund_allocation_id", "deduction_type_id", "deduction_source", "created_by", "created_at") SELECT "id", "bl_id", "type", "amount_minor", "currency", "entry_date", "deposit_payment_id", "compensates_entry_id", NULL, NULL, NULL, "created_by", "created_at" FROM `ledger_entries`;--> statement-breakpoint
DROP TABLE `ledger_entries`;--> statement-breakpoint
ALTER TABLE `__new_ledger_entries` RENAME TO `ledger_entries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_entries_compensates_unique` ON `ledger_entries` (`compensates_entry_id`) WHERE "ledger_entries"."compensates_entry_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `ledger_entries_bl` ON `ledger_entries` (`bl_id`);