CREATE TABLE `connector_enabled` (
	`id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`enabled_by` text,
	`enabled_at` text NOT NULL,
	FOREIGN KEY (`enabled_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null
);
