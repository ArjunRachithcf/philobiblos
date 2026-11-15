// What the AI may know of a person's reading (ADR 0009, contracts/ai-plugin.md): the one place that reads takeaways
// for an AI job. Read books with their ideas always (book metadata and idea names); a takeaway only when that person
// has turned on `takeawaysToAi`, whichever provider runs (Ollama is local, but it is still an AI reading them).
import { and, eq, inArray, or } from 'drizzle-orm';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { getPerson } from '../household/people';
import { bookRef, ideasOf } from './library';
import { PRIVATE_REASON } from '../knowledge/knowledge';
import { personSettings } from './settings';

export interface ReadBookForAi { id: string; title: string; authors: string[]; ideas: string[]; takeaway?: string }

export function readBooksForAi(db: Db, personId: string): ReadBookForAi[] {
  const p = getPerson(db, personId);
  if (!p || p.role === 'kid') return [];
  const share = personSettings(p).takeawaysToAi === true;
  const rows = db.select({ book: t.book, takeaway: t.reading.takeaway }).from(t.reading).innerJoin(t.book, eq(t.book.id, t.reading.bookId))
    .where(and(eq(t.reading.personId, p.id), eq(t.reading.status, 'read'))).all();
  const ideas = ideasOf(db, rows.map((r) => r.book.id));
  return rows.map(({ book, takeaway }) => {
    const ref = bookRef(book);
    return { id: ref.id, title: ref.title, authors: ref.authors ?? [], ideas: ideas.get(book.id) ?? [], ...(share && takeaway ? { takeaway } : {}) };
  });
}

/**
 * When a person turns `takeawaysToAi` off (or is removed): every AI run whose input held their takeaways goes, with its
 * cached output, and so does what it (or anything private to them) proposed that nobody has decided yet. Decisions
 * stay, still private to that person (`private_to` does not depend on the run), and a link's reason written from their
 * takeaways is replaced by a neutral one. Nothing derived from a takeaway outlives the person's choice.
 */
export function purgeTakeawayRuns(db: Db, personId: string): number {
  const runs = db.select({ id: t.aiRun.id }).from(t.aiRun).where(eq(t.aiRun.takeawaysOf, personId)).all().map((r) => r.id);
  const fromThem = <C extends typeof t.bookLink.aiRunId | typeof t.bookIdea.aiRunId, P extends typeof t.bookLink.privateTo | typeof t.bookIdea.privateTo>(run: C, priv: P) =>
    runs.length ? or(inArray(run, runs), eq(priv, personId)) : eq(priv, personId);
  db.transaction((tx) => {
    // Undecided: gone. Decided: kept (a person decided), still private to them, the reason replaced by a neutral one.
    tx.delete(t.bookLink).where(and(fromThem(t.bookLink.aiRunId, t.bookLink.privateTo), eq(t.bookLink.state, 'proposed'))).run();
    tx.delete(t.bookIdea).where(and(fromThem(t.bookIdea.aiRunId, t.bookIdea.privateTo), eq(t.bookIdea.state, 'proposed'))).run();
    tx.update(t.bookLink).set({ reason: PRIVATE_REASON }).where(fromThem(t.bookLink.aiRunId, t.bookLink.privateTo)).run();
    if (runs.length) {
      tx.update(t.bookLink).set({ aiRunId: null }).where(inArray(t.bookLink.aiRunId, runs)).run();
      tx.update(t.bookIdea).set({ aiRunId: null }).where(inArray(t.bookIdea.aiRunId, runs)).run();
      tx.delete(t.aiRun).where(inArray(t.aiRun.id, runs)).run();
    }
  });
  return runs.length;
}
