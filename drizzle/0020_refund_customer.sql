ALTER TABLE `refunds` ADD `customer_id` integer REFERENCES customers(id);--> statement-breakpoint
CREATE INDEX `refunds_customer` ON `refunds` (`customer_id`);