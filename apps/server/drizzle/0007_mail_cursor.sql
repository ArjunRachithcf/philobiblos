CREATE TABLE `mail_cursor` (
	`folder` text PRIMARY KEY NOT NULL,
	`uid_validity` integer NOT NULL,
	`last_uid` integer NOT NULL,
	`config_key` text NOT NULL,
	`updated_at` text NOT NULL
);
