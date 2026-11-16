PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_job_period` (
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
	CONSTRAINT "job_period_status" CHECK("__new_job_period"."status" IN ('running','retry','done','gave_up','void'))
);
--> statement-breakpoint
INSERT INTO `__new_job_period`("job", "period", "status", "attempts", "steps_json", "lease_until", "next_try_at", "run_id", "updated_at") SELECT "job", "period", "status", "attempts", "steps_json", "lease_until", "next_try_at", "run_id", "updated_at" FROM `job_period`;--> statement-breakpoint
DROP TABLE `job_period`;--> statement-breakpoint
ALTER TABLE `__new_job_period` RENAME TO `job_period`;--> statement-breakpoint
PRAGMA foreign_keys=ON;