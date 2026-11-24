-- A book's isbn13 is 13 digits beginning 978 or 979, or none (philobiblos#59): an ISBN is put into a price lookup's URL
-- (books/prices.ts isbnUrl, which also checks its check digit). Every writer already stores one that bookIsbn read; a
-- stored value of any other shape is dropped here (the book itself is kept). Triggers, not a CHECK: adding one would
-- rebuild the table, and its children's ON DELETE CASCADE would empty them.
UPDATE `book` SET `isbn13` = NULL WHERE `isbn13` IS NOT NULL AND NOT (length(`isbn13`) = 13 AND `isbn13` GLOB '97[89][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]');--> statement-breakpoint
CREATE TRIGGER book_isbn13_check_insert BEFORE INSERT ON book
WHEN NEW.isbn13 IS NOT NULL AND NOT (length(NEW.isbn13) = 13 AND NEW.isbn13 GLOB '97[89][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]')
BEGIN SELECT RAISE(ABORT, 'CHECK book.isbn13: 13 digits beginning 978 or 979'); END;--> statement-breakpoint
CREATE TRIGGER book_isbn13_check_update BEFORE UPDATE OF isbn13 ON book
WHEN NEW.isbn13 IS NOT NULL AND NOT (length(NEW.isbn13) = 13 AND NEW.isbn13 GLOB '97[89][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]')
BEGIN SELECT RAISE(ABORT, 'CHECK book.isbn13: 13 digits beginning 978 or 979'); END;
