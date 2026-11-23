-- A price paid learnt is dated by its invoice's day, UTC midnight (philobiblos#53, mail/effects.ts receive). A row from
-- before was dated when its invoice was read or its Inbox line decided: it takes the day of the latest copy an invoice
-- (mailed or typed) made of that book at that price, never later than its own day, else its own day.
UPDATE `book_offer` SET `seen_at` = min(
  substr(`seen_at`, 1, 10),
  coalesce((SELECT substr(max(`acquired_at`), 1, 10) FROM `copy` WHERE `copy`.`book_id` = `book_offer`.`book_id` AND `copy`.`source` IN ('invoice', 'manual') AND `copy`.`price_c` = `book_offer`.`price_c`), substr(`seen_at`, 1, 10))
) || 'T00:00:00.000Z' WHERE `source` = 'invoice';
