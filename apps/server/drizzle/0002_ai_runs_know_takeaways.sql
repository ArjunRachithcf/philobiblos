-- drizzle-kit 0.31 leaves out ON DELETE when it adds a column with a foreign key; written by hand to match
-- contracts/schema.sql v3 (test/migrations.contract.test.ts checks it).
ALTER TABLE `ai_run` ADD `takeaways_of` text REFERENCES person(id) ON DELETE CASCADE;
