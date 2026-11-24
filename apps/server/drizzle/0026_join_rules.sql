-- Join rules (philobiblos#34 slice 3, ADR 0011): a link accepts automatically or by approval, refuses non-matches or
-- lets them wait, and may narrow the household's networks; a waiting request says whether it matched every rule.
ALTER TABLE `join_link` ADD `automatic` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `join_link` ADD `refuse_non_matches` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `join_link` ADD `networks_json` text;--> statement-breakpoint
ALTER TABLE `join_request` ADD `matches_rules` integer DEFAULT 0 NOT NULL;