-- shelf#3: a proposal written from someone's takeaways is private to them, whoever writes it. private_to follows the
-- AI run (ai_run.takeaways_of): an insert with a run and no private_to gets it; a mismatch is refused, and so is an
-- update of ai_run_id or private_to that leaves them apart (taking private_to off while the run is set, or moving a row
-- to someone's run without making it theirs). Clearing ai_run_id (the purge) keeps private_to, and once set it never
-- changes or goes (deleting the row is the only way out). INSERT OR REPLACE deletes without delete triggers, so an insert
-- over a private row is refused unless the statement itself names the same private_to: one that leaves it to the fill
-- trigger is refused too (that trigger runs after the insert; this check sees NULL), which fails closed. A run's
-- takeaways_of is fixed once it has proposals, and a run with takeaways is deleted only after its proposals are (the
-- purge deletes or lets them go in the same transaction).
-- src/knowledge/from-run.ts sets it too; this is the guard for every other path (raw SQL included).
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
--> statement-breakpoint
CREATE TRIGGER book_link_private_to_kept BEFORE UPDATE OF private_to ON book_link
WHEN OLD.private_to IS NOT NULL AND NEW.private_to IS NOT OLD.private_to
BEGIN SELECT RAISE(ABORT, 'book_link.private_to never changes once set (delete the row instead)'); END;
--> statement-breakpoint
CREATE TRIGGER book_idea_private_to_kept BEFORE UPDATE OF private_to ON book_idea
WHEN OLD.private_to IS NOT NULL AND NEW.private_to IS NOT OLD.private_to
BEGIN SELECT RAISE(ABORT, 'book_idea.private_to never changes once set (delete the row instead)'); END;
--> statement-breakpoint
CREATE TRIGGER ai_run_takeaways_of_fixed BEFORE UPDATE OF takeaways_of ON ai_run
WHEN NEW.takeaways_of IS NOT OLD.takeaways_of AND (EXISTS (SELECT 1 FROM book_link WHERE ai_run_id = OLD.id) OR EXISTS (SELECT 1 FROM book_idea WHERE ai_run_id = OLD.id))
BEGIN SELECT RAISE(ABORT, 'ai_run.takeaways_of is fixed once the run has proposals'); END;
--> statement-breakpoint
CREATE TRIGGER ai_run_with_takeaways_delete BEFORE DELETE ON ai_run
WHEN OLD.takeaways_of IS NOT NULL AND (EXISTS (SELECT 1 FROM book_link WHERE ai_run_id = OLD.id) OR EXISTS (SELECT 1 FROM book_idea WHERE ai_run_id = OLD.id))
BEGIN SELECT RAISE(ABORT, 'a run with takeaways goes only after its proposals are deleted or let go (purgeTakeawayRuns)'); END;
--> statement-breakpoint
CREATE TRIGGER book_link_private_not_replaced BEFORE INSERT ON book_link
WHEN EXISTS (SELECT 1 FROM book_link WHERE from_book = NEW.from_book AND to_book = NEW.to_book AND private_to IS NOT NULL AND private_to IS NOT NEW.private_to)
BEGIN SELECT RAISE(ABORT, 'book_link: a private row is never replaced (INSERT OR REPLACE) without its private_to'); END;
--> statement-breakpoint
CREATE TRIGGER book_idea_private_not_replaced BEFORE INSERT ON book_idea
WHEN EXISTS (SELECT 1 FROM book_idea WHERE book_id = NEW.book_id AND idea_id = NEW.idea_id AND private_to IS NOT NULL AND private_to IS NOT NEW.private_to)
BEGIN SELECT RAISE(ABORT, 'book_idea: a private row is never replaced (INSERT OR REPLACE) without its private_to'); END;
