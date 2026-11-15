// The one way an AI run's proposals enter the knowledge layer (shelf#3): `private_to` is never the writer's choice,
// it is derived from the run (ai_run.takeaways_of), so a proposal written from someone's takeaways is private to them
// whichever job wrote it. Nothing else in src/ inserts a book_link or book_idea with a run (architecture test in
// test/knowledge.test.ts); the seed writes only decided rows, without a run.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/open';
import * as t from '../db/schema';

/** Whose takeaways the run read (null: nobody's). Throws for an unknown run: a proposal never outlives its run's row. */
export function privateToFor(db: Db, aiRunId: string): string | null {
  const run = db.select({ of: t.aiRun.takeawaysOf }).from(t.aiRun).where(eq(t.aiRun.id, aiRunId)).get();
  if (!run) throw new Error(`unknown AI run ${aiRunId}`);
  return run.of;
}

export interface ProposedLink { fromBook: string; toBook: string; reason: string; confidence: number }
export interface ProposedBookIdea { bookId: string; ideaId: string; layer: 'intro' | 'core' | 'deep' | 'counterpoint'; confidence: number }

/** Proposes links from a run; an existing row (decided or not) is left alone. Returns how many were added. */
export function proposeLinks(db: Db, aiRunId: string, links: readonly ProposedLink[]): number {
  if (!links.length) return 0;
  const privateTo = privateToFor(db, aiRunId);
  return db.insert(t.bookLink).values(links.map((l) => ({ ...l, state: 'proposed' as const, aiRunId, privateTo }))).onConflictDoNothing().run().changes;
}

/** Proposes book ideas from a run; an existing row (decided or not) is left alone. Returns how many were added. */
export function proposeBookIdeas(db: Db, aiRunId: string, rows: readonly ProposedBookIdea[]): number {
  if (!rows.length) return 0;
  const privateTo = privateToFor(db, aiRunId);
  return db.insert(t.bookIdea).values(rows.map((r) => ({ ...r, state: 'proposed' as const, aiRunId, privateTo }))).onConflictDoNothing().run().changes;
}
