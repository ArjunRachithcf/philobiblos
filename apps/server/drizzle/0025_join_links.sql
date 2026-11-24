-- Join links (philobiblos#34 slice 2, ADR 0011): the household's networks, its join links (only the token's SHA-256)
-- and what a waiting person's request says; person.seen_at, when the edge last sent someone (HomersLab).
CREATE TABLE `home_network` (
	`cidr` text PRIMARY KEY NOT NULL,
	`added_by` text,
	`added_at` text NOT NULL,
	FOREIGN KEY (`added_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `join_link` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`max_uses` integer DEFAULT 5 NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "join_link_uses" CHECK("join_link"."max_uses" BETWEEN 1 AND 10 AND "join_link"."uses" BETWEEN 0 AND "join_link"."max_uses")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `join_link_token_hash_unique` ON `join_link` (`token_hash`);--> statement-breakpoint
CREATE TABLE `join_request` (
	`person_id` text PRIMARY KEY NOT NULL,
	`join_link_id` text,
	`from_home_network` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`join_link_id`) REFERENCES `join_link`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `person` ADD `seen_at` text;