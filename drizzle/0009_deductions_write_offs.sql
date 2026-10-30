CREATE TABLE `write_offs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bl_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`reason` text NOT NULL,
	`state` text DEFAULT 'PROPOSED' NOT NULL,
	`proposed_by` integer NOT NULL,
	`proposed_at` text NOT NULL,
	`decided_by` integer,
	`decided_at` text,
	`decision_note` text,
	`ledger_entry_id` integer,
	FOREIGN KEY (`bl_id`) REFERENCES `bills_of_lading`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proposed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ledger_entry_id`) REFERENCES `ledger_entries`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "write_offs_amount" CHECK("write_offs"."amount_minor" > 0),
	CONSTRAINT "write_offs_reason" CHECK(length(trim("write_offs"."reason")) > 0),
	CONSTRAINT "write_offs_state" CHECK("write_offs"."state" IN ('PROPOSED', 'APPROVED', 'REJECTED')),
	CONSTRAINT "write_offs_decision" CHECK(("write_offs"."state" = 'PROPOSED' AND "write_offs"."decided_by" IS NULL AND "write_offs"."decided_at" IS NULL AND "write_offs"."ledger_entry_id" IS NULL)
        OR ("write_offs"."state" = 'APPROVED' AND "write_offs"."decided_by" IS NOT NULL AND "write_offs"."decided_at" IS NOT NULL AND "write_offs"."ledger_entry_id" IS NOT NULL)
        OR ("write_offs"."state" = 'REJECTED' AND "write_offs"."decided_by" IS NOT NULL AND "write_offs"."decided_at" IS NOT NULL AND "write_offs"."ledger_entry_id" IS NULL
          AND length(trim("write_offs"."decision_note")) > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `write_offs_proposed_unique` ON `write_offs` (`bl_id`) WHERE "write_offs"."state" = 'PROPOSED';--> statement-breakpoint
CREATE INDEX `write_offs_bl` ON `write_offs` (`bl_id`);--> statement-breakpoint
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
	`document_id` integer,
	`disputed` integer DEFAULT false NOT NULL,
	`dispute_note` text,
	`created_by` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`bl_id`) REFERENCES `bills_of_lading`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`currency`) REFERENCES `currencies`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deposit_payment_id`) REFERENCES `deposit_payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`compensates_entry_id`) REFERENCES `ledger_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`refund_allocation_id`) REFERENCES `refund_allocations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deduction_type_id`) REFERENCES `deduction_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ledger_entries_type" CHECK("__new_ledger_entries"."type" IN ('PAYMENT', 'OFFSET', 'DEDUCTION', 'REFUND_ALLOCATION', 'OPENING_BALANCE')),
	CONSTRAINT "ledger_entries_statement_document" CHECK("__new_ledger_entries"."deduction_source" IS NOT 'STATEMENT' OR "__new_ledger_entries"."document_id" IS NOT NULL),
	CONSTRAINT "ledger_entries_dispute" CHECK(("__new_ledger_entries"."disputed" = 0 AND "__new_ledger_entries"."dispute_note" IS NULL)
        OR ("__new_ledger_entries"."disputed" = 1 AND "__new_ledger_entries"."type" = 'DEDUCTION' AND "__new_ledger_entries"."compensates_entry_id" IS NULL AND length(trim("__new_ledger_entries"."dispute_note")) > 0)),
	CONSTRAINT "ledger_entries_deduction" CHECK(("__new_ledger_entries"."type" = 'DEDUCTION') = ("__new_ledger_entries"."deduction_type_id" IS NOT NULL AND "__new_ledger_entries"."deduction_source" IN ('STATEMENT', 'SHORTFALL', 'WRITE_OFF'))),
	CONSTRAINT "ledger_entries_allocation" CHECK("__new_ledger_entries"."type" <> 'REFUND_ALLOCATION' OR "__new_ledger_entries"."refund_allocation_id" IS NOT NULL),
	CONSTRAINT "ledger_entries_amount" CHECK("__new_ledger_entries"."amount_minor" <> 0)
);
--> statement-breakpoint
INSERT INTO `__new_ledger_entries`("id", "bl_id", "type", "amount_minor", "currency", "entry_date", "deposit_payment_id", "compensates_entry_id", "refund_allocation_id", "deduction_type_id", "deduction_source", "document_id", "disputed", "dispute_note", "created_by", "created_at") SELECT "id", "bl_id", "type", "amount_minor", "currency", "entry_date", "deposit_payment_id", "compensates_entry_id", "refund_allocation_id", "deduction_type_id", "deduction_source", NULL, 0, NULL, "created_by", "created_at" FROM `ledger_entries`;--> statement-breakpoint
DROP TABLE `ledger_entries`;--> statement-breakpoint
ALTER TABLE `__new_ledger_entries` RENAME TO `ledger_entries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_entries_compensates_unique` ON `ledger_entries` (`compensates_entry_id`) WHERE "ledger_entries"."compensates_entry_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `ledger_entries_bl` ON `ledger_entries` (`bl_id`);