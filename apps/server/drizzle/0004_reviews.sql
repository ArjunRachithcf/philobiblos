-- drizzle-kit 0.31 leaves out ON DELETE when it adds a column with a foreign key; written by hand to match
-- contracts/schema.sql v5 (test/migrations.contract.test.ts checks it).
ALTER TABLE `book_idea` ADD `reviewed_by` text REFERENCES person(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `book_idea` ADD `reviewed_at` text;--> statement-breakpoint
ALTER TABLE `book_link` ADD `reviewed_by` text REFERENCES person(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `book_link` ADD `reviewed_at` text;
