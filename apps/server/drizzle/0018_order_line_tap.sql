-- The copy a tap made and the state it found (no-shop mode, philobiblos#27 slice 5). drizzle-kit writes ADD COLUMN without the ON DELETE clause.
ALTER TABLE `order_line` ADD `copy_id` text REFERENCES copy(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `order_line` ADD `tapped_from` text;
