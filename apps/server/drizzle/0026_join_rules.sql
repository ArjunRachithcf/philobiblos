-- Join rules (philobiblos#34 slice 3, ADR 0011): a link accepts automatically or by approval, refuses non-matches or
-- lets them wait, and may narrow the household's networks; a waiting request says whether it matched the link's own
-- rules (NULL: it has none, as every request from before this migration); a person a link let in keeps which link and
-- whose it was.
ALTER TABLE `join_link` ADD `automatic` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `join_link` ADD `refuse_non_matches` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `join_link` ADD `networks_json` text;--> statement-breakpoint
ALTER TABLE `join_request` ADD `matches_rules` integer;--> statement-breakpoint
ALTER TABLE `person` ADD `admitted_link` text;--> statement-breakpoint
ALTER TABLE `person` ADD `admitted_by` text;