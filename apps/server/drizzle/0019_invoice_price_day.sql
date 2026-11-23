-- Prices paid learnt, repaired (philobiblos#53, mail/effects.ts receive): an invoice row is the latest invoice's price,
-- dated by its day (UTC midnight). Before, the invoice read or decided last won, a free line (0) included. Each row now
-- takes the price and the day of the latest copy an invoice made of its book (mailed: source invoice; typed: manual),
-- priced above 0 and not a tap's (a tap's copy is priced as quoted), the day never later than the row's own; a row with
-- no such copy goes. A free quote (0) is no price either, and goes.
UPDATE `book_offer` SET (`price_c`, `seen_at`) = (
  SELECT `c`.`price_c`, min(substr(`c`.`acquired_at`, 1, 10), substr(`book_offer`.`seen_at`, 1, 10)) || 'T00:00:00.000Z'
  FROM `copy` `c`
  WHERE `c`.`book_id` = `book_offer`.`book_id` AND `c`.`source` IN ('invoice', 'manual') AND `c`.`price_c` > 0
    AND NOT EXISTS (SELECT 1 FROM `order_line` `l` WHERE `l`.`copy_id` = `c`.`id`)
  ORDER BY `c`.`acquired_at` DESC, `c`.`rowid` DESC LIMIT 1
) WHERE `source` = 'invoice' AND EXISTS (
  SELECT 1 FROM `copy` `c`
  WHERE `c`.`book_id` = `book_offer`.`book_id` AND `c`.`source` IN ('invoice', 'manual') AND `c`.`price_c` > 0
    AND NOT EXISTS (SELECT 1 FROM `order_line` `l` WHERE `l`.`copy_id` = `c`.`id`)
);--> statement-breakpoint
DELETE FROM `book_offer` WHERE `source` = 'invoice' AND NOT EXISTS (
  SELECT 1 FROM `copy` `c`
  WHERE `c`.`book_id` = `book_offer`.`book_id` AND `c`.`source` IN ('invoice', 'manual') AND `c`.`price_c` > 0
    AND NOT EXISTS (SELECT 1 FROM `order_line` `l` WHERE `l`.`copy_id` = `c`.`id`)
);--> statement-breakpoint
DELETE FROM `book_offer` WHERE `source` = 'quote' AND `price_c` = 0;
