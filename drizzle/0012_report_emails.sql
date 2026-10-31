CREATE TABLE `report_emails` (
	`email_id` integer PRIMARY KEY NOT NULL,
	`sections` text NOT NULL,
	`filters` text NOT NULL,
	FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE no action
);
