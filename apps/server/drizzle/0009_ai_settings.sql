ALTER TABLE `ai_run` ADD `person_id` text REFERENCES person(id) ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX `ai_run_cache` ON `ai_run` (`job`,`prompt_version`,`input_hash`);--> statement-breakpoint
ALTER TABLE `household_settings` ADD `ai_models_json` text DEFAULT '{}' NOT NULL;