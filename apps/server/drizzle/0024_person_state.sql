-- People with a state (philobiblos#34 slice 1, ADR 0011): waiting for an admin's approval, or a member; everyone before
-- is a member. A waiting person is an adult without a handle (it is given at approval). Under HomersLab, the ceiling is
-- the Homeward role the edge sent last (null standalone); arrived_at is when a person first came. Columns added in
-- place, with their CHECKs: rebuilding the table would let its children's ON DELETE CASCADE empty them.
ALTER TABLE `person` ADD `state` text DEFAULT 'active' NOT NULL CONSTRAINT "person_state" CHECK(`state` IN ('waiting','active') AND (`state` = 'active' OR (`role` = 'adult' AND `handle` IS NULL)));--> statement-breakpoint
ALTER TABLE `person` ADD `ceiling` text CONSTRAINT "person_ceiling" CHECK(`ceiling` IN ('admin','adult','kid'));--> statement-breakpoint
ALTER TABLE `person` ADD `arrived_at` text;
