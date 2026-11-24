-- What a typed or imported invoice did, kept to undo it (philobiblos#45, orders/entries.ts undoEntry). Entries recorded before it have none, and are not undone.
ALTER TABLE `order_entry` ADD `undo_json` text;
