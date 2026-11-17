CREATE TABLE `order_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`number` text,
	`order_id` text,
	`person_id` text,
	`total_c` integer NOT NULL,
	`lines_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `order`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "order_entry_kind" CHECK("order_entry"."kind" IN ('quote','invoice')),
	CONSTRAINT "order_entry_source" CHECK("order_entry"."source" IN ('typed','csv')),
	CONSTRAINT "order_entry_number_invoice" CHECK("order_entry"."kind" = 'invoice' OR "order_entry"."number" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_entry_number` ON `order_entry` (`number`);