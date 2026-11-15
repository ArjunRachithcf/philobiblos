-- shelf#3: a proposal written from someone's takeaways is private to them, whoever writes it. private_to follows the
-- AI run (ai_run.takeaways_of): an insert with a run and no private_to gets it; a mismatch is refused, and so is an
-- update of ai_run_id or private_to that leaves them apart (taking private_to off while the run is set, or moving a row
-- to someone's run without making it theirs). Clearing ai_run_id (the purge) keeps private_to. src/knowledge/from-run.ts sets it too; this is the guard for every other path (raw SQL included).
CREATE TRIGGER book_link_private_to_check_insert BEFORE INSERT ON book_link
WHEN NEW.ai_run_id IS NOT NULL AND NEW.private_to IS NOT NULL AND NEW.private_to IS NOT (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id)
BEGIN SELECT RAISE(ABORT, 'book_link.private_to must be its run''s takeaways_of'); END;
--> statement-breakpoint
CREATE TRIGGER book_link_private_to_check_update BEFORE UPDATE OF ai_run_id, private_to ON book_link
WHEN NEW.ai_run_id IS NOT NULL AND NEW.private_to IS NOT (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id)
BEGIN SELECT RAISE(ABORT, 'book_link.private_to must be its run''s takeaways_of'); END;
--> statement-breakpoint
CREATE TRIGGER book_link_private_to_fill AFTER INSERT ON book_link
WHEN NEW.ai_run_id IS NOT NULL AND NEW.private_to IS NULL AND (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id) IS NOT NULL
BEGIN UPDATE book_link SET private_to = (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id) WHERE from_book = NEW.from_book AND to_book = NEW.to_book; END;
--> statement-breakpoint
CREATE TRIGGER book_idea_private_to_check_insert BEFORE INSERT ON book_idea
WHEN NEW.ai_run_id IS NOT NULL AND NEW.private_to IS NOT NULL AND NEW.private_to IS NOT (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id)
BEGIN SELECT RAISE(ABORT, 'book_idea.private_to must be its run''s takeaways_of'); END;
--> statement-breakpoint
CREATE TRIGGER book_idea_private_to_check_update BEFORE UPDATE OF ai_run_id, private_to ON book_idea
WHEN NEW.ai_run_id IS NOT NULL AND NEW.private_to IS NOT (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id)
BEGIN SELECT RAISE(ABORT, 'book_idea.private_to must be its run''s takeaways_of'); END;
--> statement-breakpoint
CREATE TRIGGER book_idea_private_to_fill AFTER INSERT ON book_idea
WHEN NEW.ai_run_id IS NOT NULL AND NEW.private_to IS NULL AND (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id) IS NOT NULL
BEGIN UPDATE book_idea SET private_to = (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id) WHERE book_id = NEW.book_id AND idea_id = NEW.idea_id; END;
