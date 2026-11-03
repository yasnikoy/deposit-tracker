-- Deposit transfers: TRANSFER_IN/TRANSFER_OUT ledger entries linked to the other B/L, and the TRANSFERRED status.
-- Fixed by hand after drizzle-kit: the ledger copy selects NULL for the new transfer_bl_id, the B/L number index is an
-- expression, and foreign keys stay off until both tables are rebuilt.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_bills_of_lading` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bl_no` text NOT NULL,
	`deposit_payment_id` integer,
	`agency_id` integer NOT NULL,
	`currency` text NOT NULL,
	`deposit_amount_minor` integer NOT NULL,
	`paid_at` text NOT NULL,
	`status` text NOT NULL,
	`first_request_due_days` integer,
	`upcoming_days` integer,
	`follow_up_days` integer,
	`statement_request_days` integer,
	`statement_follow_up_days` integer,
	`locked_by` integer,
	`locked_at` text,
	`customer_id` integer,
	`file_no` text,
	`description` text,
	`unit_id` integer,
	`created_by` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`voided_at` text,
	`voided_by` integer,
	`void_reason` text,
	FOREIGN KEY (`deposit_payment_id`) REFERENCES `deposit_payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agency_id`) REFERENCES `agencies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`locked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`unit_id`,`agency_id`) REFERENCES `agency_units`(`id`,`agency_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bills_of_lading_amount" CHECK("__new_bills_of_lading"."deposit_amount_minor" > 0),
	CONSTRAINT "bills_of_lading_status" CHECK("__new_bills_of_lading"."status" IN ('PAID', 'REQUESTED', 'AWAITING_RETURN', 'DEDUCTION_OPEN', 'DISPUTED', 'ACCOUNTING_PENDING', 'COLLECTED', 'TRANSFERRED')),
	CONSTRAINT "bills_of_lading_void" CHECK(("__new_bills_of_lading"."voided_at" IS NULL AND "__new_bills_of_lading"."voided_by" IS NULL AND "__new_bills_of_lading"."void_reason" IS NULL)
      OR ("__new_bills_of_lading"."voided_at" IS NOT NULL AND "__new_bills_of_lading"."voided_by" IS NOT NULL AND length(trim("__new_bills_of_lading"."void_reason")) > 0)),
	CONSTRAINT "bills_of_lading_overrides_non_negative" CHECK(coalesce("__new_bills_of_lading"."first_request_due_days", 0) >= 0 AND coalesce("__new_bills_of_lading"."upcoming_days", 0) >= 0
        AND coalesce("__new_bills_of_lading"."follow_up_days", 1) >= 1 AND coalesce("__new_bills_of_lading"."statement_request_days", 0) >= 0
        AND coalesce("__new_bills_of_lading"."statement_follow_up_days", 1) >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_bills_of_lading`("id", "bl_no", "deposit_payment_id", "agency_id", "currency", "deposit_amount_minor", "paid_at", "status", "first_request_due_days", "upcoming_days", "follow_up_days", "statement_request_days", "statement_follow_up_days", "locked_by", "locked_at", "customer_id", "file_no", "description", "unit_id", "created_by", "created_at", "updated_at", "voided_at", "voided_by", "void_reason") SELECT "id", "bl_no", "deposit_payment_id", "agency_id", "currency", "deposit_amount_minor", "paid_at", "status", "first_request_due_days", "upcoming_days", "follow_up_days", "statement_request_days", "statement_follow_up_days", "locked_by", "locked_at", "customer_id", "file_no", "description", "unit_id", "created_by", "created_at", "updated_at", "voided_at", "voided_by", "void_reason" FROM `bills_of_lading`;--> statement-breakpoint
DROP TABLE `bills_of_lading`;--> statement-breakpoint
ALTER TABLE `__new_bills_of_lading` RENAME TO `bills_of_lading`;--> statement-breakpoint
CREATE INDEX `bills_of_lading_customer` ON `bills_of_lading` (`customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bills_of_lading_payment_active` ON `bills_of_lading` (`deposit_payment_id`) WHERE "bills_of_lading"."voided_at" IS NULL AND "bills_of_lading"."deposit_payment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `bills_of_lading_bl_no_active` ON `bills_of_lading` (upper("bl_no")) WHERE "bills_of_lading"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX `bills_of_lading_agency` ON `bills_of_lading` (`agency_id`);--> statement-breakpoint
CREATE INDEX `bills_of_lading_unit` ON `bills_of_lading` (`unit_id`);--> statement-breakpoint
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
	`document_id` integer,
	`disputed` integer DEFAULT false NOT NULL,
	`dispute_note` text,
	`transfer_bl_id` integer,
	`created_by` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`bl_id`) REFERENCES `bills_of_lading`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deposit_payment_id`) REFERENCES `deposit_payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`compensates_entry_id`) REFERENCES `ledger_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`refund_allocation_id`) REFERENCES `refund_allocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deduction_type_id`) REFERENCES `deduction_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transfer_bl_id`) REFERENCES `bills_of_lading`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ledger_entries_type" CHECK("__new_ledger_entries"."type" IN ('PAYMENT', 'OFFSET', 'DEDUCTION', 'REFUND_ALLOCATION', 'OPENING_BALANCE', 'TRANSFER_IN', 'TRANSFER_OUT')),
	CONSTRAINT "ledger_entries_transfer" CHECK(("__new_ledger_entries"."type" IN ('TRANSFER_IN', 'TRANSFER_OUT')) = ("__new_ledger_entries"."transfer_bl_id" IS NOT NULL)),
	CONSTRAINT "ledger_entries_statement_document" CHECK("__new_ledger_entries"."deduction_source" IS NOT 'STATEMENT' OR "__new_ledger_entries"."document_id" IS NOT NULL),
	CONSTRAINT "ledger_entries_dispute" CHECK(("__new_ledger_entries"."disputed" = 0 AND "__new_ledger_entries"."dispute_note" IS NULL)
        OR ("__new_ledger_entries"."disputed" = 1 AND "__new_ledger_entries"."type" = 'DEDUCTION' AND "__new_ledger_entries"."compensates_entry_id" IS NULL AND length(trim("__new_ledger_entries"."dispute_note")) > 0)),
	CONSTRAINT "ledger_entries_deduction" CHECK(("__new_ledger_entries"."type" = 'DEDUCTION') = ("__new_ledger_entries"."deduction_type_id" IS NOT NULL AND "__new_ledger_entries"."deduction_source" IN ('STATEMENT', 'SHORTFALL', 'WRITE_OFF'))),
	CONSTRAINT "ledger_entries_allocation" CHECK("__new_ledger_entries"."type" <> 'REFUND_ALLOCATION' OR "__new_ledger_entries"."refund_allocation_id" IS NOT NULL),
	CONSTRAINT "ledger_entries_amount" CHECK("__new_ledger_entries"."amount_minor" <> 0)
);
--> statement-breakpoint
INSERT INTO `__new_ledger_entries`("id", "bl_id", "type", "amount_minor", "currency", "entry_date", "deposit_payment_id", "compensates_entry_id", "refund_allocation_id", "deduction_type_id", "deduction_source", "document_id", "disputed", "dispute_note", "transfer_bl_id", "created_by", "created_at") SELECT "id", "bl_id", "type", "amount_minor", "currency", "entry_date", "deposit_payment_id", "compensates_entry_id", "refund_allocation_id", "deduction_type_id", "deduction_source", "document_id", "disputed", "dispute_note", NULL, "created_by", "created_at" FROM `ledger_entries`;--> statement-breakpoint
DROP TABLE `ledger_entries`;--> statement-breakpoint
ALTER TABLE `__new_ledger_entries` RENAME TO `ledger_entries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_entries_compensates_unique` ON `ledger_entries` (`compensates_entry_id`) WHERE "ledger_entries"."compensates_entry_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `ledger_entries_bl` ON `ledger_entries` (`bl_id`);