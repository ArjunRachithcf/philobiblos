CREATE TABLE `inbox_decision` (
	`item` text NOT NULL,
	`idx` integer NOT NULL,
	`decision` text NOT NULL,
	`person_id` text,
	`book_id` text,
	`decided_at` text NOT NULL,
	PRIMARY KEY(`item`, `idx`),
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`book_id`) REFERENCES `book`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "inbox_decision_decision" CHECK("inbox_decision"."decision" IN ('added','skipped','dismissed'))
);
--> statement-breakpoint
ALTER TABLE `share` ADD `title` text;--> statement-breakpoint
ALTER TABLE `share` ADD `caption` text;--> statement-breakpoint
ALTER TABLE `share` ADD `media_total` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `share` ADD `media_refused` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `share` ADD `error` text;