CREATE TABLE `customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`code` text,
	`aliases` text DEFAULT '[]' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "customers_name" CHECK(length(trim("customers"."name")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_name_unique` ON `customers` (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX `customers_code_unique` ON `customers` (`code`) WHERE "customers"."code" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `bills_of_lading` ADD `customer_id` integer REFERENCES customers(id);--> statement-breakpoint
ALTER TABLE `bills_of_lading` ADD `file_no` text;--> statement-breakpoint
CREATE INDEX `bills_of_lading_customer` ON `bills_of_lading` (`customer_id`);