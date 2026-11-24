-- Join codes (philobiblos#34 slice 4a, ADR 0011): a link may ask for an address at a mail domain, verified by a 6-digit
-- code sent over SMTP; the code is kept only as an HMAC, the address on the request alone (a waiting one's, until it is
-- decided or lapses), and a person the rule let in keeps only the domain. join_code_sent counts the sends of the last day.
CREATE TABLE `join_code` (
	`id` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`join_link_id` text,
	`address` text,
	`mac` blob,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`tries` integer DEFAULT 0 NOT NULL,
	`verified_at` text,
	FOREIGN KEY (`join_link_id`) REFERENCES `join_link`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "join_code_tries" CHECK("join_code"."tries" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `join_code_request_hash_unique` ON `join_code` (`request_hash`);--> statement-breakpoint
CREATE INDEX `join_code_address` ON `join_code` (`address`);--> statement-breakpoint
CREATE TABLE `join_code_sent` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sent_at` text NOT NULL,
	`join_link_id` text NOT NULL,
	`address_mac` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `join_code_sent_at` ON `join_code_sent` (`sent_at`);--> statement-breakpoint
ALTER TABLE `join_link` ADD `mail_domain` text;--> statement-breakpoint
ALTER TABLE `join_request` ADD `verified_address` text;--> statement-breakpoint
ALTER TABLE `person` ADD `admitted_domain` text;