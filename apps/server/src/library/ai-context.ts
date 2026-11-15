// What the AI may know of a person's reading (ADR 0009, contracts/ai-plugin.md): the one place that reads takeaways
// for an AI job. Read books with their ideas always (book metadata and idea names); a takeaway only when that person
// has turned on `takeawaysToAi`, whichever provider runs (Ollama is local, but it is still an AI reading them).
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { getPerson } from '../household/people';
import { bookRef, ideasOf } from './library';
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
