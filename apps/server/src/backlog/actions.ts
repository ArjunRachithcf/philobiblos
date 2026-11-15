// Changing the Backlog: adding a book by hand, the bulk actions, saved filters. Who may change what: your own
// candidates and the kids' (adults act for them); another adult's backlog is theirs (403), though everyone sees it.
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { getPerson, household } from '../household/people';
import { norm } from '../seed/import';
import { candidateId, parseCandidateId } from './backlog';

export class BacklogError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}

const ISBN13 = /^97[89]\d{10}$/;

export function mayChange(db: Db, me: string, personId: string): void {
  const p = getPerson(db, personId);
  if (!p) throw new BacklogError(404, 'no such person');
  if (p.id !== me && p.role !== 'kid') throw new BacklogError(403, 'only they change their own backlog');
}

const text = (v: unknown, name: string, max: number, required: boolean): string | null => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new BacklogError(400, `${name} is required`);
    return null;
  }
  if (typeof v !== 'string' || v.trim().length > max || (required && !v.trim())) throw new BacklogError(400, `${name}: up to ${max} characters`);
  return v.trim() || null;
};

/** POST /backlog: a book by hand, for yourself or a kid (`for`: a handle, `me` or nothing). */
export function addToBacklog(db: Db, me: string, body: unknown, now = new Date()): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BacklogError(400, 'a JSON object is needed');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!['title', 'author', 'isbn13', 'for'].includes(k)) throw new BacklogError(400, `unknown field ${k}`);
  const title = text(b.title, 'title', 300, true)!;
  const author = text(b.author, 'author', 200, false);
  const isbn = text(b.isbn13, 'isbn13', 13, false);
  if (isbn && !ISBN13.test(isbn)) throw new BacklogError(400, 'isbn13: 13 digits starting 978 or 979');
  const forWho = text(b.for, 'for', 40, false);
  const target = !forWho || forWho === 'me' ? getPerson(db, me) : household(db).find((p) => p.handle === forWho);
  if (!target) throw new BacklogError(404, 'no one in the household has that handle');
  mayChange(db, me, target.id);

  const iso = now.toISOString();
  let bookId = (isbn ? db.select().from(t.book).where(eq(t.book.isbn13, isbn)).get()?.id : undefined)
    ?? db.select().from(t.book).where(eq(t.book.normKey, `${norm(title)}|${norm(author ?? '')}`)).get()?.id;
  db.transaction((tx) => {
    if (!bookId) {
      bookId = ulid();
      tx.insert(t.book).values({
        id: bookId, title, authorsJson: JSON.stringify(author ? [author] : []), isbn13: isbn,
        audience: target.role === 'kid' ? 'kids' : 'adult', normKey: `${norm(title)}|${norm(author ?? '')}`, createdAt: iso,
      }).run();
    }
    const r = tx.insert(t.candidate).values({ personId: target.id, bookId, origin: 'manual', addedAt: iso, touchedAt: iso }).onConflictDoNothing().run();
    if (r.changes === 0) throw new BacklogError(409, 'already in that backlog');
  });
  return candidateId(target.id, bookId!);
}

export type BulkAction = 'not_for_me' | 'snooze' | 'reopen' | 'add_to_month';

/** POST /backlog/bulk: all or nothing; every id must be a candidate you may change. */
export function bulk(db: Db, me: string, body: unknown, now = new Date()): number {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BacklogError(400, 'a JSON object is needed');
  const b = body as { ids?: unknown; action?: unknown; months?: unknown };
  if (!Array.isArray(b.ids) || b.ids.length === 0 || b.ids.length > 200) throw new BacklogError(400, 'ids: 1 to 200 candidate ids');
  if (!['not_for_me', 'snooze', 'reopen'].includes(b.action as string)) throw new BacklogError(400, 'action: not_for_me, snooze or reopen');
  const months = b.months === undefined ? 3 : b.months;
  if (b.action === 'snooze' && (!Number.isInteger(months) || (months as number) < 1 || (months as number) > 24)) throw new BacklogError(400, 'months: 1 to 24');
  const keys = b.ids.map((id) => {
    const k = parseCandidateId(id);
    if (!k) throw new BacklogError(400, 'ids: candidate ids from the list');
    return k;
  });
  for (const k of keys) {
    mayChange(db, me, k.personId);
    if (!db.select({ s: t.candidate.state }).from(t.candidate).where(and(eq(t.candidate.personId, k.personId), eq(t.candidate.bookId, k.bookId))).get()) {
      throw new BacklogError(404, 'no such candidate');
    }
  }
  const iso = now.toISOString();
  const until = new Date(now);
  until.setUTCMonth(until.getUTCMonth() + (months as number));
  const set = b.action === 'not_for_me' ? { state: 'not_for_me' as const, snoozedUntil: null }
    : b.action === 'snooze' ? { state: 'snoozed' as const, snoozedUntil: until.toISOString() }
    : { state: 'active' as const, snoozedUntil: null };
  db.transaction((tx) => {
    for (const k of keys) tx.update(t.candidate).set({ ...set, touchedAt: iso }).where(and(eq(t.candidate.personId, k.personId), eq(t.candidate.bookId, k.bookId))).run();
  });
  return keys.length;
}

/** contracts/backlog-query.md: shown until a person saves their own. */
export const DEFAULT_FILTERS = [
  { name: 'To buy now', q: 'is:open is:adult score:>40' },
  { name: 'Kids', q: 'is:open is:kids' },
  { name: 'Cheap & good', q: 'is:open score:>30 price:<25' },
  { name: 'From Instagram', q: 'is:open source:instagram sort:added' },
];

export function savedFilters(db: Db, me: string) {
  const mine = db.select().from(t.savedFilter).where(eq(t.savedFilter.personId, me)).orderBy(t.savedFilter.createdAt).all();
  return mine.length ? mine.map((f) => ({ id: f.id.replace(/^(default-\d)-.*$/, '$1'), name: f.name, q: f.q })) : DEFAULT_FILTERS.map((f, i) => ({ id: `default-${i + 1}`, ...f }));
}

export const MAX_FILTERS = 20;

/** Your list as rows: the first change to it (save, rename, remove) starts it from the defaults. */
function startList(db: Db, me: string, now: Date): void {
  if (db.select({ id: t.savedFilter.id }).from(t.savedFilter).where(eq(t.savedFilter.personId, me)).get()) return;
  for (const [i, f] of DEFAULT_FILTERS.entries()) {
    db.insert(t.savedFilter).values({ id: `default-${i + 1}-${me}`, personId: me, ...f, createdAt: new Date(now.getTime() - (DEFAULT_FILTERS.length - i) - 1000).toISOString() }).run();
  }
}

/** A default's id before the list starts (default-N) is the same filter as its row after (default-N-<person>). */
function rowId(me: string, id: string): string {
  return /^default-\d$/.test(id) ? `${id}-${me}` : id;
}

/** PATCH /backlog/saved-filters/{id}: renames one of your filters. */
export function renameFilter(db: Db, me: string, id: string, body: unknown, now = new Date()): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BacklogError(400, 'a JSON object is needed');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'name') throw new BacklogError(400, `unknown field ${k}`);
  const name = text(b.name, 'name', 40, true)!;
  db.transaction((tx) => {
    startList(tx as unknown as Db, me, now);
    const r = tx.update(t.savedFilter).set({ name }).where(and(eq(t.savedFilter.id, rowId(me, id)), eq(t.savedFilter.personId, me))).run();
    if (r.changes === 0) throw new BacklogError(404, 'no such saved filter of yours');
  });
}

/** DELETE /backlog/saved-filters/{id}: removes one of your filters (an empty list shows the defaults again). */
export function removeFilter(db: Db, me: string, id: string, now = new Date()): void {
  db.transaction((tx) => {
    startList(tx as unknown as Db, me, now);
    const r = tx.delete(t.savedFilter).where(and(eq(t.savedFilter.id, rowId(me, id)), eq(t.savedFilter.personId, me))).run();
    if (r.changes === 0) throw new BacklogError(404, 'no such saved filter of yours');
  });
}

export function saveFilter(db: Db, me: string, body: unknown, now = new Date()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BacklogError(400, 'a JSON object is needed');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!['name', 'q'].includes(k)) throw new BacklogError(400, `unknown field ${k}`);
  const name = text(b.name, 'name', 40, true)!;
  const q = text(b.q, 'q', 500, true)!;
  const existing = db.select().from(t.savedFilter).where(eq(t.savedFilter.personId, me)).all();
  if (existing.length >= MAX_FILTERS) throw new BacklogError(409, `at most ${MAX_FILTERS} saved filters: remove one first`);
  // The first filter you save starts your own list, from the defaults.
  db.transaction((tx) => {
    startList(tx as unknown as Db, me, now);
    tx.insert(t.savedFilter).values({ id: ulid(), personId: me, name, q, createdAt: now.toISOString() }).run();
  });
}
