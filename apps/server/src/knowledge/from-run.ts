// The one way an AI run's proposals enter the knowledge layer (shelf#3): `private_to` is never the writer's choice,
// it is derived from the run (ai_run.takeaways_of), so a proposal written from someone's takeaways is private to them
// whichever job wrote it. Nothing else in src/ inserts a book_link or book_idea with a run (architecture test in
// test/knowledge.test.ts); the seed writes only decided rows, without a run.
import { and, eq } from 'drizzle-orm';
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
  // Existing rows are skipped here, not left to ON CONFLICT: the database refuses an insert over a private row (0005).
  const fresh = links.filter((l) => !db.select({ x: t.bookLink.fromBook }).from(t.bookLink).where(and(eq(t.bookLink.fromBook, l.fromBook), eq(t.bookLink.toBook, l.toBook))).get());
  if (!fresh.length) return 0;
  return db.insert(t.bookLink).values(fresh.map((l) => ({ ...l, state: 'proposed' as const, aiRunId, privateTo }))).onConflictDoNothing().run().changes;
}

/** Proposes book ideas from a run; an existing row (decided or not) is left alone. Returns how many were added. */
export function proposeBookIdeas(db: Db, aiRunId: string, rows: readonly ProposedBookIdea[]): number {
  if (!rows.length) return 0;
  const privateTo = privateToFor(db, aiRunId);
  const fresh = rows.filter((r) => !db.select({ x: t.bookIdea.bookId }).from(t.bookIdea).where(and(eq(t.bookIdea.bookId, r.bookId), eq(t.bookIdea.ideaId, r.ideaId))).get());
  if (!fresh.length) return 0;
  return db.insert(t.bookIdea).values(fresh.map((r) => ({ ...r, state: 'proposed' as const, aiRunId, privateTo }))).onConflictDoNothing().run().changes;
}
