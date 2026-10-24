CREATE TABLE `requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bl_id` integer NOT NULL,
	`type` text NOT NULL,
	`channel` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`send_status` text NOT NULL,
	`requested_on` text,
	`sent_at` text,
	`portal_ref` text,
	`failure_reason` text,
	`created_by` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`bl_id`) REFERENCES `bills_of_lading`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "requests_type" CHECK("requests"."type" IN ('REFUND', 'DEDUCTION_STATEMENT')),
	CONSTRAINT "requests_channel" CHECK("requests"."channel" IN ('EMAIL', 'PORTAL')),
	CONSTRAINT "requests_send_status" CHECK("requests"."send_status" IN ('QUEUED', 'SENT', 'FAILED')),
	CONSTRAINT "requests_attempt_no" CHECK("requests"."attempt_no" >= 1),
	CONSTRAINT "requests_sent" CHECK(("requests"."send_status" = 'SENT') = ("requests"."requested_on" IS NOT NULL AND "requests"."sent_at" IS NOT NULL)),
	CONSTRAINT "requests_requested_on" CHECK("requests"."requested_on" IS NULL OR "requests"."requested_on" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "requests_portal_sent" CHECK("requests"."channel" <> 'PORTAL' OR "requests"."send_status" = 'SENT')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `requests_attempt_unique` ON `requests` (`bl_id`,`type`,`attempt_no`) WHERE "requests"."send_status" <> 'FAILED';--> statement-breakpoint
CREATE INDEX `requests_bl` ON `requests` (`bl_id`);--> statement-breakpoint
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
	CONSTRAINT "bills_of_lading_amount" CHECK("__new_bills_of_lading"."deposit_amount_minor" > 0),
	CONSTRAINT "bills_of_lading_status" CHECK("__new_bills_of_lading"."status" IN ('PAID', 'REQUESTED', 'AWAITING_RETURN', 'DEDUCTION_OPEN', 'DISPUTED', 'COLLECTED')),
	CONSTRAINT "bills_of_lading_void" CHECK(("__new_bills_of_lading"."voided_at" IS NULL AND "__new_bills_of_lading"."voided_by" IS NULL AND "__new_bills_of_lading"."void_reason" IS NULL)
      OR ("__new_bills_of_lading"."voided_at" IS NOT NULL AND "__new_bills_of_lading"."voided_by" IS NOT NULL AND length(trim("__new_bills_of_lading"."void_reason")) > 0)),
	CONSTRAINT "bills_of_lading_overrides_non_negative" CHECK(coalesce("__new_bills_of_lading"."first_request_due_days", 0) >= 0 AND coalesce("__new_bills_of_lading"."upcoming_days", 0) >= 0
        AND coalesce("__new_bills_of_lading"."follow_up_days", 1) >= 1 AND coalesce("__new_bills_of_lading"."statement_request_days", 0) >= 0
        AND coalesce("__new_bills_of_lading"."statement_follow_up_days", 1) >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_bills_of_lading`("id", "bl_no", "deposit_payment_id", "agency_id", "currency", "deposit_amount_minor", "paid_at", "status", "created_by", "created_at", "updated_at", "voided_at", "voided_by", "void_reason") SELECT "id", "bl_no", "deposit_payment_id", "agency_id", "currency", "deposit_amount_minor", "paid_at", "status", "created_by", "created_at", "updated_at", "voided_at", "voided_by", "void_reason" FROM `bills_of_lading`;--> statement-breakpoint
DROP TABLE `bills_of_lading`;--> statement-breakpoint
ALTER TABLE `__new_bills_of_lading` RENAME TO `bills_of_lading`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `bills_of_lading_payment_active` ON `bills_of_lading` (`deposit_payment_id`) WHERE "bills_of_lading"."voided_at" IS NULL AND "bills_of_lading"."deposit_payment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `bills_of_lading_bl_no_active` ON `bills_of_lading` (upper("bl_no")) WHERE "bills_of_lading"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX `bills_of_lading_agency` ON `bills_of_lading` (`agency_id`);