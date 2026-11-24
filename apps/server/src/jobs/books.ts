// The jobs that ask the outside about books: prices (ADR 0008), Open Library's metadata and covers. Both go one request at a
// time with a pause between them, look only at books that need it, and stop for the run when the other side refuses.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, isNotNull, isNull, notInArray } from 'drizzle-orm';
import { writeAtomic } from '@philobiblos/contracts/media';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { EgressError, type Egress } from '../net/egress';
import { lookup } from '../books/openlibrary';
import type { PriceSource } from '../books/prices';
import { MediaUnavailable, runMediaJob } from '../media/client';

export const PRICE_PAUSE_MS = 3000;
export const PRICE_FRESH_DAYS = 7;
export const META_PAUSE_MS = 1000;
export const PER_RUN = { prices: 60, metadata: 100, covers: 50 };

/** `deadline`: the monthly refresh's (month/refresh.ts); a run stops there and its retry does the rest. */
export interface JobEnv { now?: () => Date; sleep?: (ms: number) => Promise<void>; deadline?: Date }
export interface Outcome { status: 'done' | 'blocked' | 'failed'; detail: string }
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const refusedBy = (e: unknown) => e instanceof EgressError && (e.reason === 'off' || e.reason === 'not-allowed' || (e.reason === 'status' && (e.status === 403 || e.status === 429)));
const why = (e: unknown) => (e instanceof EgressError ? e.message : 'unexpected answer');

/** Books worth a price: candidates the household does not own, without an offer from this source in the last 7 days. */
export function booksNeedingPrices(db: Db, source: string, now: Date, asks: PriceSource['asks'] = 'title') {
  const owned = db.selectDistinct({ id: t.copy.bookId }).from(t.copy).all().map((r) => r.id);
  const ids = [...new Set(db.select({ id: t.candidate.bookId }).from(t.candidate).all().map((r) => r.id))].filter((id) => !owned.includes(id));
  if (!ids.length) return [];
  const cutoff = new Date(now.getTime() - PRICE_FRESH_DAYS * 86_400_000).toISOString();
  const fresh = new Set(db.select({ id: t.bookOffer.bookId, seen: t.bookOffer.seenAt }).from(t.bookOffer)
    .where(and(eq(t.bookOffer.source, source), inArray(t.bookOffer.bookId, ids))).all().filter((o) => o.seen >= cutoff).map((o) => o.id));
  // A source that asks by ISBN has nothing to ask about a book without one.
  return db.select().from(t.book).where(inArray(t.book.id, ids.filter((id) => !fresh.has(id)))).all().filter((b) => asks !== 'isbn' || b.isbn13)
    .sort((a, b) => a.id.localeCompare(b.id)).slice(0, PER_RUN.prices);
}

export async function refreshPrices(db: Db, source: PriceSource, env: JobEnv = {}): Promise<Outcome> {
  const now = env.now ?? (() => new Date());
  const sleep = env.sleep ?? realSleep;
  const books = booksNeedingPrices(db, source.id, now(), source.asks);
  let found = 0, missing = 0, errors = 0;
  for (const [i, b] of books.entries()) {
    if (i > 0) await sleep(PRICE_PAUSE_MS);
    if (env.deadline && now() >= env.deadline) return { status: 'failed', detail: `stopped at the time limit after ${i} of ${books.length}` };
    let offer;
    try {
      offer = await source.find({ title: b.title, authors: JSON.parse(b.authorsJson) as string[], isbn13: b.isbn13 });
    } catch (e) {
      if (refusedBy(e)) return { status: 'blocked', detail: `stopped after ${i} of ${books.length}: ${why(e)}` };
      errors++;
      continue;
    }
    const seenAt = now().toISOString();
    if (offer) {
      found++;
      const v = { externalId: offer.externalId, priceC: offer.priceC, availability: offer.availability, seenAt };
      db.insert(t.bookOffer).values({ bookId: b.id, source: source.id, ...v }).onConflictDoUpdate({ target: [t.bookOffer.bookId, t.bookOffer.source], set: v }).run();
    } else {
      // Not found this time: a price seen before stays, only the date moves (so the next week asks again, not today).
      missing++;
      db.insert(t.bookOffer).values({ bookId: b.id, source: source.id, seenAt }).onConflictDoUpdate({ target: [t.bookOffer.bookId, t.bookOffer.source], set: { seenAt } }).run();
    }
  }
  return { status: errors && !found && !missing ? 'failed' : 'done', detail: `${books.length} looked up: ${found} found, ${missing} not found, ${errors} failed` };
}

/** Books without Open Library's facts yet (or all of them, `again`), oldest first. */
export function booksNeedingMeta(db: Db, again = false) {
  const known = again ? [] : db.select({ id: t.bookMeta.bookId }).from(t.bookMeta).all().map((r) => r.id);
  return db.select().from(t.book).where(known.length ? notInArray(t.book.id, known) : undefined).orderBy(t.book.createdAt, t.book.id).limit(PER_RUN.metadata).all();
}

export async function refreshMetadata(db: Db, egress: Egress, env: JobEnv & { again?: boolean } = {}): Promise<Outcome> {
  const now = env.now ?? (() => new Date());
  const sleep = env.sleep ?? realSleep;
  const books = booksNeedingMeta(db, env.again);
  let found = 0, missing = 0, errors = 0;
  for (const [i, b] of books.entries()) {
    if (i > 0) await sleep(META_PAUSE_MS);
    let meta;
    try {
      meta = await lookup(egress, { title: b.title, authors: JSON.parse(b.authorsJson) as string[], isbn13: b.isbn13 });
    } catch (e) {
      if (refusedBy(e)) return { status: 'blocked', detail: `stopped after ${i} of ${books.length}: ${why(e)}` };
      errors++;
      continue;
    }
    const row = meta
      ? { source: 'openlibrary', externalId: meta.externalId, description: meta.description, subjectsJson: JSON.stringify(meta.subjects), coverId: meta.coverId, status: 'found' as const, fetchedAt: now().toISOString() }
      : { source: 'openlibrary', externalId: null, description: null, subjectsJson: '[]', coverId: null, status: 'not_found' as const, fetchedAt: now().toISOString() };
    if (meta) found++; else missing++;
    db.insert(t.bookMeta).values({ bookId: b.id, ...row }).onConflictDoUpdate({ target: t.bookMeta.bookId, set: row }).run();
  }
  return { status: errors && !found && !missing ? 'failed' : 'done', detail: `${books.length} looked up: ${found} found, ${missing} not found, ${errors} failed` };
}

/** Covers Open Library has and the household doesn't yet: downloaded, re-encoded by the media worker, kept in data/covers. */
export function booksNeedingCovers(db: Db) {
  return db.select({ id: t.book.id, coverId: t.bookMeta.coverId }).from(t.book).innerJoin(t.bookMeta, eq(t.bookMeta.bookId, t.book.id))
    .where(and(isNull(t.book.coverPath), isNotNull(t.bookMeta.coverId))).orderBy(t.book.id).limit(PER_RUN.covers).all()
    .filter((r): r is { id: string; coverId: string } => COVER_ID.test(r.coverId ?? ''));
}

const COVER_ID = /^\d{1,12}$/;

/**
 * Each cover is fetched (an image, 5 MB at most, from covers.openlibrary.org and the archive's hosts it redirects to)
 * and handed to the media worker; only the worker's fresh JPEG is kept, never the original. Without a worker, nothing.
 */
export async function refreshCovers(db: Db, egress: Egress, o: { dataDir: string; workDir: string | null }, env: JobEnv & { media?: typeof runMediaJob } = {}): Promise<Outcome> {
  const sleep = env.sleep ?? realSleep;
  const media = env.media ?? runMediaJob;
  const books = booksNeedingCovers(db);
  const dir = join(o.dataDir, 'covers');
  let saved = 0, refused = 0, errors = 0;
  for (const [i, b] of books.entries()) {
    if (i > 0) await sleep(META_PAUSE_MS);
    let image: Buffer;
    try {
      image = (await egress.get(`https://covers.openlibrary.org/b/id/${b.coverId}-L.jpg?default=false`, 'image')).body;
    } catch (e) {
      if (refusedBy(e)) return { status: 'blocked', detail: `stopped after ${i} of ${books.length}: ${why(e)}` };
      errors++;
      continue;
    }
    let r;
    try { r = await media(o.workDir, 'image.reencode', image); } catch (e) {
      if (e instanceof MediaUnavailable) return { status: 'blocked', detail: `stopped after ${i} of ${books.length}: ${e.message}` };
      throw e;
    }
    if (!r.ok || !r.image) { refused++; continue; }
    mkdirSync(dir, { recursive: true, mode: 0o750 });
    writeAtomic(join(dir, `${b.id}.jpg`), r.image);
    db.update(t.book).set({ coverPath: `covers/${b.id}.jpg` }).where(eq(t.book.id, b.id)).run();
    saved++;
  }
  return { status: errors && !saved && !refused ? 'failed' : 'done', detail: `${books.length} covers: ${saved} kept, ${refused} refused by the media worker, ${errors} failed` };
}
