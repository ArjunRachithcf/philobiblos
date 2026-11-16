// The one way an AI run's proposals enter the knowledge layer (philobiblos#3): `private_to` is never the writer's choice,
// it is derived from the run (ai_run.takeaways_of), so a proposal written from someone's takeaways is private to them
// whichever job wrote it. Nothing else in src/ inserts a book_link, a book_idea, an idea_proposal or an idea (the
// architecture test in test/knowledge.test.ts); the seed writes only decided rows, without a run.
//
// A name the AI made up is only a proposal (idea_proposal): it becomes an idea, and joins the household's vocabulary
// that later prompts carry, only when a person confirms it (confirmIdeaProposal).
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
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

export interface ProposedNewIdea { bookId: string; name: string; layer: ProposedBookIdea['layer']; confidence: number }

/** Proposes new ideas from a run, by name only (no idea row); an existing proposal of that name on that book is left alone. */
export function proposeNewIdeas(db: Db, aiRunId: string, rows: readonly ProposedNewIdea[]): number {
  if (!rows.length) return 0;
  const privateTo = privateToFor(db, aiRunId);
  return db.insert(t.ideaProposal).values(rows.map((r) => ({ id: ulid(), ...r, state: 'proposed' as const, aiRunId, privateTo }))).onConflictDoNothing().run().changes;
}

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** The idea of that name as it reads now (merges followed), or null: never a new one. */
export function knownIdea(db: Db, name: string): string | null {
  const hit = db.select().from(t.idea).all().find((i) => norm(i.name) === norm(name));
  return hit ? hit.mergedInto ?? hit.id : null;
}

/**
 * A person confirmed a new idea: the idea of that name (an existing one, or a new one now), and the book's tag in it,
 * confirmed by them, private as the proposal was. Returns the idea's id.
 */
export function confirmIdeaProposal(db: Db, p: typeof t.ideaProposal.$inferSelect, layer: ProposedBookIdea['layer'], by: string, now: Date): string {
  return db.transaction((tx) => {
    let ideaId = knownIdea(tx as unknown as Db, p.name);
    if (!ideaId) { ideaId = ulid(); tx.insert(t.idea).values({ id: ideaId, name: p.name }).run(); }
    const at = now.toISOString();
    const row = tx.select().from(t.bookIdea).where(and(eq(t.bookIdea.bookId, p.bookId), eq(t.bookIdea.ideaId, ideaId))).get();
    // A row of that idea private to someone else stays theirs to decide.
    if (row && row.privateTo !== null && row.privateTo !== by) { /* left alone */ } else if (row) tx.update(t.bookIdea).set({ state: 'confirmed', layer, reviewedBy: by, reviewedAt: at }).where(and(eq(t.bookIdea.bookId, p.bookId), eq(t.bookIdea.ideaId, ideaId))).run();
    else tx.insert(t.bookIdea).values({ bookId: p.bookId, ideaId, layer, confidence: p.confidence, state: 'confirmed', reviewedBy: by, reviewedAt: at, privateTo: p.privateTo }).run();
    tx.update(t.ideaProposal).set({ state: 'confirmed', layer, ideaId, reviewedBy: by, reviewedAt: at }).where(eq(t.ideaProposal.id, p.id)).run();
    return ideaId;
  });
}
