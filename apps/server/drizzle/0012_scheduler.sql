CREATE TABLE `job_period` (
	`job` text NOT NULL,
	`period` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`steps_json` text DEFAULT '[]' NOT NULL,
	`lease_until` text,
	`next_try_at` text,
	`run_id` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`job`, `period`),
	FOREIGN KEY (`run_id`) REFERENCES `job_run`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "job_period_status" CHECK("job_period"."status" IN ('running','retry','done','gave_up'))
);
--> statement-breakpoint
ALTER TABLE `job_run` ADD `period` text;