// Books' ideas as everything reads them (ADR 0005, spec §6). A merged idea's rows stay as they were: each row is read
// under the idea it points at (idea.merged_into, one step: a merge re-points the ideas merged into it). When a book
// then has two rows for one idea, the stronger decision is the book's: confirmed over proposed over rejected (then the
// higher confidence). A tag counts when that decision is confirmed, or is one of the seed's guesses (proposed, no AI run,
// confidence ≥ 0.8). The AI's proposals never count until a person confirms them, whatever confidence the model gave:
// a model that read hostile text chooses that number (spec §6, ADR 0009).
//
// `as`: whose AI run reads them (null: the household's, nobody's in particular). Rows private to anyone else are left
// out, so a book idea from Sam's takeaways never reaches Alex's prompts.
import { eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Db } from '../db/open';
import * as t from '../db/schema';

export type Layer = 'intro' | 'core' | 'deep' | 'counterpoint';
export type State = 'proposed' | 'confirmed' | 'rejected';
export interface Tag { bookId: string; ideaId: string; name: string; layer: Layer; state: State; confidence: number; fromAi: boolean; privateTo: string | null }

export const COUNTED = 0.8;
export const RANK: Record<State, number> = { confirmed: 2, proposed: 1, rejected: 0 };
export const counts = (x: Pick<Tag, 'state' | 'confidence' | 'fromAi'>) => x.state === 'confirmed' || (x.state === 'proposed' && !x.fromAi && x.confidence >= COUNTED);
/** A proposal is the AI's when a run wrote it or it is private to someone (only AI runs write private rows). */
export const fromAi = (r: { aiRunId: string | null; privateTo: string | null }) => r.aiRunId !== null || r.privateTo !== null;
export interface Reader { as: string | null }

/** One tag per (book, idea as it reads now), the stronger decision winning. All of them, or only `bookIds`'. */
export function resolvedTags(db: Db, bookIds?: string[], reader?: Reader): Tag[] {
  if (bookIds && !bookIds.length) return [];
  const row = alias(t.idea, 'row_idea');
  const into = alias(t.idea, 'into_idea');
  const q = db.select({ bookId: t.bookIdea.bookId, rowIdea: row.id, rowName: row.name, mergedInto: row.mergedInto, intoName: into.name, layer: t.bookIdea.layer, state: t.bookIdea.state, confidence: t.bookIdea.confidence, aiRunId: t.bookIdea.aiRunId, privateTo: t.bookIdea.privateTo })
    .from(t.bookIdea).innerJoin(row, eq(row.id, t.bookIdea.ideaId)).leftJoin(into, eq(into.id, row.mergedInto));
  const rows = bookIds ? q.where(inArray(t.bookIdea.bookId, bookIds)).all() : q.all();
  const best = new Map<string, Tag>();
  for (const r of rows) {
    if (reader && r.privateTo !== null && r.privateTo !== reader.as) continue;
    const tag: Tag = { bookId: r.bookId, ideaId: r.mergedInto ?? r.rowIdea, name: r.intoName ?? r.rowName, layer: r.layer, state: r.state, confidence: r.confidence, fromAi: fromAi(r), privateTo: r.privateTo };
    const key = `${tag.bookId}\u0000${tag.ideaId}`;
    const was = best.get(key);
    if (!was || RANK[tag.state] > RANK[was.state] || (RANK[tag.state] === RANK[was.state] && tag.confidence > was.confidence)) best.set(key, tag);
  }
  return [...best.values()];
}

/** The tags that count, per book: what the Library, the Backlog, the brain and the AI read. */
export function countedTags(db: Db, bookIds?: string[], reader?: Reader): Tag[] {
  return resolvedTags(db, bookIds, reader).filter(counts);
}
