-- drizzle-kit 0.31 leaves out ON DELETE when it adds a column with a foreign key; written by hand to match
-- contracts/schema.sql v3 (test/migrations.contract.test.ts checks it).
ALTER TABLE `passkey` ADD `invited_by` text REFERENCES person(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `passkey_id` text REFERENCES passkey(id) ON DELETE CASCADE;
