CREATE TABLE `idea_proposal` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`name` text NOT NULL,
	`layer` text NOT NULL,
	`confidence` real NOT NULL,
	`state` text DEFAULT 'proposed' NOT NULL,
	`ai_run_id` text,
	`idea_id` text,
	`reviewed_by` text,
	`reviewed_at` text,
	`private_to` text,
	FOREIGN KEY (`book_id`) REFERENCES `book`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ai_run_id`) REFERENCES `ai_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`idea_id`) REFERENCES `idea`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`private_to`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "idea_proposal_layer" CHECK("idea_proposal"."layer" IN ('intro','core','deep','counterpoint')),
	CONSTRAINT "idea_proposal_state" CHECK("idea_proposal"."state" IN ('proposed','confirmed','rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idea_proposal_book_name` ON `idea_proposal` (`book_id`,`name`);--> statement-breakpoint
ALTER TABLE `ai_run` ADD `tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_run` ADD `share_token_id` text REFERENCES share_token(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `ai_run_spend` ON `ai_run` (`provider`,`started_at`);--> statement-breakpoint
ALTER TABLE `household_settings` ADD `ai_daily_tokens` integer DEFAULT 200000 NOT NULL;--> statement-breakpoint
ALTER TABLE `order_line` ADD `why_audience` text;--> statement-breakpoint
ALTER TABLE `share` ADD `token_id` text REFERENCES share_token(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `share` ADD `ai_read_at` text;--> statement-breakpoint
CREATE TRIGGER idea_proposal_private_to_check_insert BEFORE INSERT ON idea_proposal
WHEN NEW.ai_run_id IS NOT NULL AND NEW.private_to IS NOT (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id)
BEGIN SELECT RAISE(ABORT, 'idea_proposal.private_to must be its run''s takeaways_of'); END;
--> statement-breakpoint
CREATE TRIGGER idea_proposal_private_to_kept BEFORE UPDATE OF private_to ON idea_proposal
WHEN NEW.private_to IS NOT OLD.private_to
BEGIN SELECT RAISE(ABORT, 'idea_proposal.private_to never changes (delete the row instead)'); END;
