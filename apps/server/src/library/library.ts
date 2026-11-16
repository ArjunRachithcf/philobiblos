// The Library (spec §4, ADR 0005): per person, the household's owned books of that person's audience and every book
// the person has a status for. An owned book without a status counts as unread ("to read"): the unread pile is what
// the household owns and the person has not read, is not reading and did not stop.
//
// Privacy (docs/security.md): a takeaway is its person's own. Anyone signed in sees anyone's statuses, but a
// takeaway leaves the server only in its own person's library. Adults change their own readings and act for kids;
// nobody changes another adult's.
import { and, eq, inArray } from 'drizzle-orm';
import type { components } from '@shelf/contracts/openapi';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { getPerson, view, type Person } from '../household/people';
import { countedTags, type Reader } from '../knowledge/tags';
import { personSettings } from './settings';

type S = components['schemas'];
export type Status = S['Reading']['status'] & string;
type Feedback = 'loved' | 'meh' | 'not_yet';

/** The kids' themes of spec §7, in its order. */
export const KIDS_THEMES = [
  'Feelings & regulation', 'Worry & anxiety', 'Empathy & kindness', 'Friendship', 'Courage & resilience', 'Self-worth',
  'Loss & healing', 'Family & change', 'Diversity & belonging', 'Body & consent', 'Gender', 'Sensory & neurodiversity',
  'Mindfulness', 'Curiosity & imagination',
] as const;

/** A kids' book has one or two themes (spec §3). */
export const MAX_THEMES = 2;

export class LibraryError extends Error {
  constructor(readonly status: 400 | 403 | 404, message: string) { super(message); }
}

interface Item { book: S['BookRef']; reading: S['Reading']; ideas?: string[]; themes?: string[] }

const ORDER: Record<Status, number> = { reading: 0, to_read: 1, read: 2, abandoned: 3 };

export function bookRef(b: typeof t.book.$inferSelect): S['BookRef'] {
  return {
    id: b.id, title: b.title, authors: JSON.parse(b.authorsJson) as string[], audience: b.audience, isFiction: b.isFiction === 1,
    ...(b.isbn13 ? { isbn13: b.isbn13 } : {}),
  };
}

/** Each book's ideas that count (ADR 0005), merged ideas read under the idea they went into (knowledge/tags.ts). */
export function ideasOf(db: Db, ids: string[], reader?: Reader): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of countedTags(db, ids, reader)) out.set(r.bookId, [...(out.get(r.bookId) ?? []), r.name]);
  return out;
}

export function getLibrary(db: Db, viewerId: string, personId: string): S['Library'] {
  const p = getPerson(db, personId);
  if (!p) throw new LibraryError(404, 'no such person');
  const own = viewerId === p.id;
  const audience = p.role === 'kid' ? 'kids' : 'adult';

  const readings = new Map(db.select().from(t.reading).where(eq(t.reading.personId, p.id)).all().map((r) => [r.bookId, r]));
  const owned = new Set(db.selectDistinct({ id: t.copy.bookId }).from(t.copy).innerJoin(t.book, eq(t.book.id, t.copy.bookId))
    .where(eq(t.book.audience, audience)).all().map((r) => r.id));
  const ids = [...new Set([...owned, ...readings.keys()])];
  const books = ids.length ? db.select().from(t.book).where(inArray(t.book.id, ids)).all() : [];

  const ideas = ideasOf(db, ids);
  // A kids' book has one or two themes (spec §3); it counts under each.
  const themes = new Map<string, string[]>();
  if (ids.length && p.role === 'kid') {
    for (const r of db.select().from(t.bookTheme).where(inArray(t.bookTheme.bookId, ids)).orderBy(t.bookTheme.theme).all()) {
      const now = themes.get(r.bookId) ?? [];
      if (now.length < MAX_THEMES) themes.set(r.bookId, [...now, r.theme]); // never more than two (contract maxItems)
    }
  }
  const items = books.map((b): Item => {
    const r = readings.get(b.id);
    const reading: S['Reading'] = {
      status: r?.status ?? 'to_read',
      feedback: p.role === 'kid' ? r?.feedback ?? null : null,
      takeaway: own ? r?.takeaway ?? null : null,
      finishedAt: r?.finishedAt ?? null,
    };
    return {
      book: bookRef(b), reading,
      ...(p.role === 'kid' ? { themes: themes.get(b.id) ?? [] } : { ideas: ideas.get(b.id) ?? [] }),
    };
  }).sort((a, b) => ORDER[a.reading.status!] - ORDER[b.reading.status!]
    || (b.reading.finishedAt ?? '').localeCompare(a.reading.finishedAt ?? '')
    || a.book.title.localeCompare(b.book.title));

  const count = (st: Status) => items.filter((i) => i.reading.status === st).length;
  const stats: S['Library']['stats'] = {
    read: count('read'), reading: count('reading'),
    unreadPile: items.filter((i) => owned.has(i.book.id) && i.reading.status === 'to_read').length,
    unreadLimit: personSettings(p).unreadLimit,
    // Even the number of someone else's takeaways is theirs.
    ...(own ? { takeaways: items.filter((i) => i.reading.takeaway).length } : {}),
  };
  const out: S['Library'] = { person: view(db, p), books: items, stats };
  if (p.role === 'kid') {
    // The emotional map: books per theme (spec §6 counts a loved book twice when thinning a theme; the bar shows both).
    out.themes = KIDS_THEMES.map((theme) => {
      const inTheme = items.filter((i) => i.themes?.includes(theme));
      return { theme, books: inTheme.length, loved: inTheme.filter((i) => i.reading.feedback === 'loved').length };
    });
  }
  return out;
}

const STATUSES = new Set<Status>(['to_read', 'reading', 'read', 'abandoned']);
const FEEDBACK = new Set<Feedback>(['loved', 'meh', 'not_yet']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const TAKEAWAY_MAX = 280;

interface Update { status?: Status; feedback?: Feedback | null; takeaway?: string | null; finishedAt?: string | null }

/** Validates a body against contracts/openapi.yaml's ReadingUpdate. */
function parse(body: unknown): Update {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LibraryError(400, 'a JSON object is needed');
  const b = body as Record<string, unknown>;
  const out: Update = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === 'status') {
      if (!STATUSES.has(v as Status)) throw new LibraryError(400, 'status: to_read, reading, read or abandoned');
      out.status = v as Status;
    } else if (k === 'feedback') {
      if (v !== null && !FEEDBACK.has(v as Feedback)) throw new LibraryError(400, 'feedback: loved, meh, not_yet or null');
      out.feedback = v as Feedback | null;
    } else if (k === 'takeaway') {
      if (v !== null && typeof v !== 'string') throw new LibraryError(400, 'takeaway: text or null');
      const text = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
      if (text.length > TAKEAWAY_MAX) throw new LibraryError(400, `takeaway: at most ${TAKEAWAY_MAX} characters`);
      out.takeaway = text || null;
    } else if (k === 'finishedAt') {
      if (v !== null && (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(v)))) throw new LibraryError(400, 'finishedAt: a date (YYYY-MM-DD) or null');
      out.finishedAt = v as string | null;
    } else {
      throw new LibraryError(400, `unknown field ${k}`);
    }
  }
  return out;
}

/** Who may change whose reading: your own; a kid's, by any adult. */
function canChange(viewer: Person, p: Person): boolean {
  return viewer.id === p.id || (p.role === 'kid' && viewer.role !== 'kid');
}

export function setReading(db: Db, viewerId: string, personId: string, bookId: string, body: unknown, now = new Date()): S['Reading'] {
  const viewer = getPerson(db, viewerId);
  const p = getPerson(db, personId);
  if (!viewer || !p) throw new LibraryError(404, 'no such person');
  if (!canChange(viewer, p)) throw new LibraryError(403, 'only they change their own reading');
  if (!db.select({ id: t.book.id }).from(t.book).where(eq(t.book.id, bookId)).get()) throw new LibraryError(404, 'no such book');
  const u = parse(body);
  if (p.role === 'kid' && u.takeaway !== undefined) throw new LibraryError(400, 'kids have feedback, not takeaways');
  if (p.role !== 'kid' && u.feedback !== undefined) throw new LibraryError(400, 'feedback is for kids; adults have takeaways');

  const before = db.select().from(t.reading).where(and(eq(t.reading.personId, p.id), eq(t.reading.bookId, bookId))).get();
  // A kid's loved or meh book has been read, whatever its status was.
  const status = u.status ?? (u.feedback === 'loved' || u.feedback === 'meh' ? 'read' : before?.status ?? 'to_read');
  const today = now.toISOString().slice(0, 10);
  // Finished is a fact of `read` only: leaving it clears the date (it feeds the sort and spec §6's `stale`).
  const finishedAt = u.finishedAt !== undefined ? u.finishedAt
    : status === 'read' ? (before?.status === 'read' ? before.finishedAt : today) : null;
  const row = {
    personId: p.id, bookId, status,
    feedback: u.feedback !== undefined ? u.feedback : before?.feedback ?? null,
    takeaway: u.takeaway !== undefined ? u.takeaway : before?.takeaway ?? null,
    finishedAt, updatedAt: now.toISOString(),
  };
  db.insert(t.reading).values(row).onConflictDoUpdate({ target: [t.reading.personId, t.reading.bookId], set: row }).run();
  return { status: row.status, feedback: row.feedback, takeaway: row.takeaway, finishedAt: row.finishedAt };
}
