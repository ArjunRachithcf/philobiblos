CREATE TABLE `saved_filter` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`name` text NOT NULL,
	`q` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `candidate` ADD `snoozed_until` text;