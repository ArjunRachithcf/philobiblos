CREATE TABLE `book_meta` (
	`book_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text,
	`description` text,
	`subjects_json` text DEFAULT '[]' NOT NULL,
	`cover_id` text,
	`status` text NOT NULL,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `book`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "book_meta_status" CHECK("book_meta"."status" IN ('found','not_found'))
);
