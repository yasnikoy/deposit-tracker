-- B/L description ("Açıklama") replaces the team notes. Notes still in effect move into the
-- description, oldest first, one line each: "DD.MM.YYYY Author: text" (Istanbul date, UTC+3).
-- Their audit rows (note.add) stay in the audit log.
ALTER TABLE `bills_of_lading` ADD `description` text;--> statement-breakpoint
UPDATE `bills_of_lading` SET `description` = (
	SELECT group_concat(strftime('%d.%m.%Y', n.`created_at`, '+3 hours') || ' ' || u.`display_name` || ': ' || n.`body`, char(10) ORDER BY n.`created_at`, n.`id`)
	FROM `notes` n JOIN `users` u ON u.`id` = n.`author_id`
	WHERE n.`bl_id` = `bills_of_lading`.`id` AND n.`undone_at` IS NULL
) WHERE EXISTS (SELECT 1 FROM `notes` n WHERE n.`bl_id` = `bills_of_lading`.`id` AND n.`undone_at` IS NULL);--> statement-breakpoint
DROP TABLE `notes`;
