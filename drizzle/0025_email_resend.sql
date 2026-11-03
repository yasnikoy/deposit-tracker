ALTER TABLE `emails` ADD `resend_of_email_id` integer REFERENCES emails(id);--> statement-breakpoint
CREATE INDEX `emails_resend_of` ON `emails` (`resend_of_email_id`);