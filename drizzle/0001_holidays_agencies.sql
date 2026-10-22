CREATE TABLE `agencies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`to_recipients` text DEFAULT '[]' NOT NULL,
	`cc_recipients` text DEFAULT '[]' NOT NULL,
	`bank_sender_aliases` text DEFAULT '[]' NOT NULL,
	`bl_number_patterns` text DEFAULT '[]' NOT NULL,
	`batch_sending` integer DEFAULT false NOT NULL,
	`request_channel` text DEFAULT 'EMAIL' NOT NULL,
	`portal_url` text,
	`notes` text,
	`first_request_due_days` integer,
	`upcoming_days` integer,
	`follow_up_days` integer,
	`statement_request_days` integer,
	`statement_follow_up_days` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "agencies_request_channel" CHECK("agencies"."request_channel" IN ('EMAIL', 'PORTAL')),
	CONSTRAINT "agencies_portal_url" CHECK("agencies"."request_channel" <> 'PORTAL' OR "agencies"."portal_url" IS NOT NULL),
	CONSTRAINT "agencies_overrides_non_negative" CHECK(coalesce("agencies"."first_request_due_days", 0) >= 0 AND coalesce("agencies"."upcoming_days", 0) >= 0
        AND coalesce("agencies"."follow_up_days", 1) >= 1 AND coalesce("agencies"."statement_request_days", 0) >= 0
        AND coalesce("agencies"."statement_follow_up_days", 1) >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agencies_name_unique` ON `agencies` (lower("name"));--> statement-breakpoint
CREATE TABLE `holidays` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "holidays_kind" CHECK("holidays"."kind" IN ('FULL', 'HALF')),
	CONSTRAINT "holidays_date_format" CHECK("holidays"."date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `holidays_date_unique` ON `holidays` (`date`);--> statement-breakpoint
ALTER TABLE `settings_history` ADD `reason` text;