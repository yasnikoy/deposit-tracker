-- The portal reference number is no longer used. Any reference recorded so far is kept as a
-- line in its B/L's description ("Portal ref.: …") before the column goes; templates lose the
-- {portal_ref} placeholder (an unedited template takes the new seed text on start anyway).
UPDATE `bills_of_lading` SET `description` = coalesce(`description` || char(10), '') || (
	SELECT group_concat('Portal ref.: ' || r.`portal_ref`, char(10) ORDER BY r.`id`)
	FROM `requests` r WHERE r.`bl_id` = `bills_of_lading`.`id` AND r.`portal_ref` IS NOT NULL
) WHERE EXISTS (SELECT 1 FROM `requests` r WHERE r.`bl_id` = `bills_of_lading`.`id` AND r.`portal_ref` IS NOT NULL);--> statement-breakpoint
UPDATE `email_templates` SET
	`subject` = replace(replace(`subject`, ' – Portal ref. {portal_ref}', ''), '{portal_ref}', ''),
	`body` = replace(`body`, '{portal_ref}', '')
WHERE `subject` LIKE '%{portal_ref}%' OR `body` LIKE '%{portal_ref}%';--> statement-breakpoint
ALTER TABLE `requests` DROP COLUMN `portal_ref`;
