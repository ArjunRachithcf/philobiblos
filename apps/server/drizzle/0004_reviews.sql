-- drizzle-kit 0.31 leaves out ON DELETE when it adds a column with a foreign key; those lines are written by hand to
-- match contracts/schema.sql v5 (test/migrations.contract.test.ts checks it).
CREATE TABLE `idea_merge` (
	`id` text PRIMARY KEY NOT NULL,
	`idea_id` text NOT NULL,
	`into_id` text NOT NULL,
	`repointed_json` text DEFAULT '[]' NOT NULL,
	`merged_by` text,
	`merged_at` text NOT NULL,
	`undone_by` text,
	`undone_at` text,
	FOREIGN KEY (`idea_id`) REFERENCES `idea`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`into_id`) REFERENCES `idea`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merged_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`undone_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `book_idea` ADD `reviewed_by` text REFERENCES person(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `book_idea` ADD `reviewed_at` text;--> statement-breakpoint
ALTER TABLE `book_idea` ADD `private_to` text REFERENCES person(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `book_link` ADD `reviewed_by` text REFERENCES person(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `book_link` ADD `reviewed_at` text;--> statement-breakpoint
ALTER TABLE `book_link` ADD `private_to` text REFERENCES person(id) ON DELETE CASCADE;