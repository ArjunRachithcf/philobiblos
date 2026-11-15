import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDb } from '../src/db/open';
import * as t from '../src/db/schema';
import { importSeed, norm, parsePriceC, parseSeedDate } from '../src/seed/import';

const sample = fileURLToPath(new URL('../../../seed-sample', import.meta.url));
const NOW = '2026-11-15T12:00:00.000Z';

describe('seed importer on seed-sample/', () => {
  const db = openDb(':memory:');
  const first = importSeed(db, sample, NOW);

  it('imports every kind of row', () => {
    expect(first).toMatchObject({ people: 4, copies: 8, readings: 8, shares: 2 });
    for (const k of ['books', 'offers', 'candidates', 'links', 'ideas', 'bookIdeas', 'themes'] as const) expect(first[k]).toBeGreaterThan(0);
  });

  it('is idempotent', () => {
    const again = importSeed(db, sample, NOW);
    expect({ ...again, skipped: 0, notes: [] }).toEqual({ people: 0, books: 0, copies: 0, readings: 0, offers: 0, candidates: 0, links: 0, ideas: 0, bookIdeas: 0, themes: 0, shares: 0, skipped: 0, notes: [] });
  });

  it('one candidate per title, To buy wins over a second edition', () => {
    const b = db.select().from(t.book).where(eq(t.book.title, 'Markets Made Simple')).all();
    expect(b).toHaveLength(1);
    const cand = db.select().from(t.candidate).where(eq(t.candidate.bookId, b[0]!.id)).all();
    expect(cand.map((c) => c.origin)).toEqual(['to_buy']);
    // the eBook's offer is not kept
    expect(db.select().from(t.bookOffer).where(eq(t.bookOffer.bookId, b[0]!.id)).all().map((o) => o.externalId)).toEqual(['A0000000007']);
  });

  it('kids\' books go to the youngest kid, with their theme', () => {
    const kid = db.select().from(t.person).where(eq(t.person.name, 'Kid 2')).get()!;
    const kite = db.select().from(t.book).where(eq(t.book.title, 'The Brave Little Kite')).get()!;
    expect(kite.audience).toBe('kids');
    const c = db.select().from(t.candidate).where(eq(t.candidate.bookId, kite.id)).all();
    expect(c.map((x) => x.personId)).toEqual([kid.id]);
    expect(db.select().from(t.bookTheme).where(eq(t.bookTheme.bookId, kite.id)).all().map((x) => x.theme)).toEqual(['Courage & resilience']);
  });

  it('owned books are not candidates; links point at owned books and are confirmed', () => {
    const ownedIds = new Set(db.select().from(t.copy).all().map((x) => x.bookId));
    for (const c of db.select().from(t.candidate).all()) expect(ownedIds.has(c.bookId)).toBe(false);
    const links = db.select().from(t.bookLink).all();
    expect(links.every((l) => ownedIds.has(l.toBook) && l.state === 'confirmed')).toBe(true);
  });

  it('a share for each post', () => {
    expect(db.select().from(t.share).all().map((s) => s.url).sort()).toEqual([
      'https://www.instagram.com/p/SAMPLEPOST1/', 'https://www.instagram.com/p/SAMPLEPOST2/',
    ]);
  });

  it('fiction is marked from its category', () => {
    expect(db.select().from(t.book).where(eq(t.book.title, 'The Glass Orchard')).get()!.isFiction).toBe(1);
  });

  it('reports what it cannot import', () => {
    expect(first.notes.join(' ')).toMatch(/redundancies/);
  });
});

describe('helpers', () => {
  it('parsePriceC', () => {
    expect(parsePriceC('Fr.25.90')).toBe(2590);
    expect(parsePriceC('Fr. 221.00')).toBe(22100);
    expect(parsePriceC('Fr.19.9')).toBe(1990);
    expect(parsePriceC('')).toBeNull();
  });
  it('parseSeedDate', () => {
    expect(parseSeedDate('15.11.26', NOW)).toBe('2026-11-15T00:00:00.000Z');
    expect(parseSeedDate('nope', NOW)).toBe(NOW);
  });
  it('norm', () => {
    expect(norm('Okafor, M: Value Beyond Price (Paperback)')).toBe('valuebeyondprice');
  });
});
