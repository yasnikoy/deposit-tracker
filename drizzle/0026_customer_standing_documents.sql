ALTER TABLE `standing_documents` ADD `customer_id` integer REFERENCES customers(id);--> statement-breakpoint
CREATE INDEX `standing_documents_customer` ON `standing_documents` (`customer_id`,`slot`);