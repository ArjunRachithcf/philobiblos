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
	`price_high_c` integer,
	`price_max_c` integer,
	CONSTRAINT "household_settings_one" CHECK("__new_household_settings"."id" = 1),
	CONSTRAINT "household_settings_ai_provider" CHECK("__new_household_settings"."ai_provider" IN ('claude','ollama','none')),
	CONSTRAINT "household_settings_currency" CHECK("__new_household_settings"."currency" IS NULL OR (length("__new_household_settings"."currency") = 3 AND "__new_household_settings"."currency" GLOB '[A-Z][A-Z][A-Z]')),
	CONSTRAINT "household_settings_unknown_price" CHECK("__new_household_settings"."unknown_price_c" BETWEEN 0 AND 1000000000000),
	CONSTRAINT "household_settings_price_limits" CHECK(("__new_household_settings"."price_high_c" IS NULL AND "__new_household_settings"."price_max_c" IS NULL) OR ("__new_household_settings"."price_high_c" IS NOT NULL AND "__new_household_settings"."price_max_c" IS NOT NULL AND "__new_household_settings"."price_high_c" BETWEEN 0 AND "__new_household_settings"."price_max_c" AND "__new_household_settings"."price_max_c" <= 1000000000000))
);
--> statement-breakpoint
-- philobiblos#40: every household before it scored with limits of 40 and 60 of its currency, whatever its unknown price.
-- One whose unknown price is 25 gets them by following it, as a new household does; any other keeps them as its own, so
-- no score changes at the upgrade. Its unknown price may now be as large as any amount (packages/contracts money.ts).
INSERT INTO `__new_household_settings`("id", "budget_min_c", "budget_max_c", "adult_picks", "new_authors_only", "ai_provider", "ai_jobs_json", "cycle_day", "cycle_time", "timezone", "ai_models_json", "ai_leaves_accepted", "ai_daily_tokens", "currency", "unknown_price_c", "price_high_c", "price_max_c") SELECT "id", "budget_min_c", "budget_max_c", "adult_picks", "new_authors_only", "ai_provider", "ai_jobs_json", "cycle_day", "cycle_time", "timezone", "ai_models_json", "ai_leaves_accepted", "ai_daily_tokens", "currency", "unknown_price_c", CASE WHEN "unknown_price_c" = 2500 THEN NULL ELSE 4000 END, CASE WHEN "unknown_price_c" = 2500 THEN NULL ELSE 6000 END FROM `household_settings`;--> statement-breakpoint
DROP TABLE `household_settings`;--> statement-breakpoint
ALTER TABLE `__new_household_settings` RENAME TO `household_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;