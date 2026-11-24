-- An invoice typed or imported that a person answered is the same as a bookshop's mail counted already (philobiblos#58):
-- that mail's mail_seen.message_id. Such an entry counted nothing; entries before it have none.
ALTER TABLE `order_entry` ADD `duplicate_of` text;--> statement-breakpoint
CREATE INDEX `order_entry_duplicate_of` ON `order_entry` (`duplicate_of`);