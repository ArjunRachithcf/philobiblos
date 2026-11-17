PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_household_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`budget_min_c` integer DEFAULT 10000 NOT NULL,
	`budget_max_c` integer DEFAULT 15000 NOT NULL,
	`adult_picks` integer DEFAULT 2 NOT NULL,
	`new_authors_only` integer DEFAULT 1 NOT NULL,
	`ai_provider` text DEFAULT 'ollama' NOT NULL,
	`ai_jobs_json` text DEFAULT '{"read":true,"link":true,"suggest":true,"explain":true,"wildcards":true}' NOT NULL,
	`cycle_day` integer DEFAULT 1 NOT NULL,
	`cycle_time` text DEFAULT '20:17' NOT NULL,
	`timezone` text DEFAULT 'Europe/Zurich' NOT NULL,
	`ai_models_json` text DEFAULT '{}' NOT NULL,
	`ai_leaves_accepted` text,
	`ai_daily_tokens` integer DEFAULT 200000 NOT NULL,
	`currency` text,
	`unknown_price_c` integer DEFAULT 2500 NOT NULL,
	CONSTRAINT "household_settings_one" CHECK("__new_household_settings"."id" = 1),
	CONSTRAINT "household_settings_ai_provider" CHECK("__new_household_settings"."ai_provider" IN ('claude','ollama','none')),
	CONSTRAINT "household_settings_currency" CHECK("__new_household_settings"."currency" IS NULL OR (length("__new_household_settings"."currency") = 3 AND "__new_household_settings"."currency" GLOB '[A-Z][A-Z][A-Z]')),
	CONSTRAINT "household_settings_unknown_price" CHECK("__new_household_settings"."unknown_price_c" BETWEEN 0 AND 1000000)
);
--> statement-breakpoint
-- philobiblos#27 slice 2: a household from before M4 kept its amounts in the one currency the first slices were built
-- for (contract v1's "money in centimes, integer CHF*100"), so its settings row says so; its unknown price stays 25 of it.
-- A new household has no row yet: PHILOBIBLOS_CURRENCY or an admin in Settings gives it its currency.
INSERT INTO `__new_household_settings`("id", "budget_min_c", "budget_max_c", "adult_picks", "new_authors_only", "ai_provider", "ai_jobs_json", "cycle_day", "cycle_time", "timezone", "ai_models_json", "ai_leaves_accepted", "ai_daily_tokens", "currency", "unknown_price_c") SELECT "id", "budget_min_c", "budget_max_c", "adult_picks", "new_authors_only", "ai_provider", "ai_jobs_json", "cycle_day", "cycle_time", "timezone", "ai_models_json", "ai_leaves_accepted", "ai_daily_tokens", 'CHF', 2500 FROM `household_settings`;--> statement-breakpoint
DROP TABLE `household_settings`;--> statement-breakpoint
ALTER TABLE `__new_household_settings` RENAME TO `household_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;