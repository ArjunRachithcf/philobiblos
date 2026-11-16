// Prices (ADR 0008), Open Library's metadata and covers: the parsers against invented pages and answers (no real
// page or book is in here), the jobs with a stand-in egress client, and POST /jobs/{job}/run's rules.
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { lookup, parseWork, pickSearchDoc } from '../src/books/openlibrary';
import { UNKNOWN_PRICE_C, orellFuessli, parseTiles, pickOffer, textOf, type PriceSource } from '../src/books/prices';
import { loadConfig } from '../src/config';
import * as t from '../src/db/schema';
import { PRICE_PAUSE_MS, booksNeedingPrices, refreshCovers, refreshMetadata, refreshPrices } from '../src/jobs/books';
import { EgressError, type Egress, type Want } from '../src/net/egress';
import { ORIGIN, TEST_SEALING_KEY, household, sessionCookie } from './helpers';

/** A search page as the shop's tiles are described in contracts/connectors.md; titles and ids are made up. */
function page(tiles: { id: string; title: string; author: string; format: string; price?: string; lang?: string; avail?: string }[]) {
  return `<!doctype html><html><head><script>window.secret = "never read"</script><style>.x{}</style></head><body>
    <ul class="results">${tiles.map((x) => `
      <li class="tile"><a href="/shop/home/artikeldetails/${x.id}?pos=1" class="title">${x.title}</a>
        <span class="author">${x.author}</span><span class="format">${x.format}</span>
        ${x.lang ? `<span class="lang">${x.lang}</span>` : ''}${x.price ? `<span class="price">${x.price}</span>` : ''}
        <span class="avail">${x.avail ?? 'Sofort lieferbar'}</span>
        <a href="/shop/home/artikeldetails/${x.id}#reviews">Bewertungen</a></li>`).join('')}
    </ul></body></html>`;
}

/** A stand-in egress client: answers by URL, records what was asked. */
function fakeEgress(answer: (url: string, want: Want) => unknown): Egress & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    post: () => Promise.reject(new EgressError('not-allowed', 'no AI here')),
    push: () => Promise.reject(new EgressError('not-allowed', 'no pushes here')),
    async get(url, want) {
      asked.push(url);
      const a = answer(url, want);
      if (a instanceof Error) throw a;
      if (a == null) throw new EgressError('status', 'not found', 404);
      const body = Buffer.isBuffer(a) ? a : Buffer.from(typeof a === 'string' ? a : JSON.stringify(a));
      return { status: 200, type: 'x', body, url };
    },
  };
}
const noSleep = async () => {};

describe('the price page, read as text', () => {
  it('script and style are dropped; entities decoded', () => {
    expect(textOf('<p>A &amp; B</p><script>x()</script><style>p{}</style>&nbsp;C')).toBe('A & B C');
  });

  it('picks the English print edition whose title matches, with its price and availability', () => {
    const html = page([
      { id: 'A1000000001', title: 'The Long Tide of Markets', author: 'Mira Okafor', format: 'eBook (ePUB)', price: 'Fr. 12.00' },
      { id: 'A1000000002', title: 'The Long Tide of Markets', author: 'Mira Okafor', format: 'Buch (Gebundene Ausgabe)', lang: 'Deutsch', price: 'Fr. 39.90' },
      { id: 'A1000000003', title: 'The Long Tide of Markets', author: 'Mira Okafor', format: 'Buch (Taschenbuch)', lang: 'Englisch', price: 'Fr. 24.90', avail: 'Lieferbar in 2-3 Tagen' },
      { id: 'A1000000004', title: 'The Long Tide of Markets Workbook', author: 'Mira Okafor', format: 'Buch (Taschenbuch)', lang: 'Englisch', price: 'Fr. 9.90' },
    ]);
    const tiles = parseTiles(html);
    expect(tiles.map((x) => x.externalId)).toEqual(['A1000000001', 'A1000000002', 'A1000000003', 'A1000000004']);
    expect(pickOffer(tiles, 'The Long Tide of Markets', ['Mira Okafor'])).toEqual({ externalId: 'A1000000003', priceC: 2490, availability: 'Lieferbar in 2-3 Tagen' });
  });

  it('another author, or no print edition: no offer', () => {
    const html = page([{ id: 'A2000000001', title: 'The Grand Ledger', author: 'Someone Else', format: 'Buch (Taschenbuch)', price: 'Fr. 20.00' }]);
    expect(pickOffer(parseTiles(html), 'The Grand Ledger', ['Mira Okafor'])).toBeNull();
    expect(pickOffer(parseTiles(page([{ id: 'A2000000002', title: 'The Grand Ledger', author: 'Mira Okafor', format: 'Hörbuch (CD)', price: 'Fr. 20.00' }])), 'The Grand Ledger', ['Mira Okafor'])).toBeNull();
  });

  it('a hostile page: no links to the shop\'s articles, huge or broken, gives nothing', () => {
    expect(parseTiles('<a href="https://evil.example/shop/home/artikeldetails/A1">x</a>')).toEqual([]);
    expect(parseTiles('<'.repeat(3_000_000))).toEqual([]);
    expect(textOf('a <b>c</b> <script>x()</script>d<style>p{}</style>e <unclosed')).toBe('a c d e');
    expect(parseTiles('<a href="/shop/home/artikeldetails/A1234567"')).toHaveLength(1);
  });

  it.each([
    ['80 KB of <', () => '<'.repeat(80_000)],
    ['an unclosed script', () => `<script>${'<'.repeat(500_000)}`],
    ['many unclosed tags and scripts', () => '<script <style <a '.repeat(50_000)],
  ])('linear on hostile input: %s', (_n, make) => {
    const html = make();
    const t = Date.now();
    textOf(html);
    expect(Date.now() - t).toBeLessThan(200);
  });

  it('a page with 2 MB of < between two tiles, or thousands of unclosed article links, parses in well under a second', () => {
    const link = (id: string) => `<a href="/shop/home/artikeldetails/${id}">The Grand Ledger</a> Buch (Taschenbuch) Fr. 18.50`;
    for (const html of [link('A5000000001') + '<'.repeat(2 << 20) + link('A5000000002'), 'href="/shop/home/artikeldetails/A1234567'.repeat(30_000)]) {
      const t = Date.now();
      parseTiles(html);
      expect(Date.now() - t).toBeLessThan(1000);
    }
  });

  it('the source asks the shop\'s search page, title and first author, and nothing else', async () => {
    const e = fakeEgress(() => page([{ id: 'A3000000001', title: 'The Grand Ledger', author: 'Mira Okafor', format: 'Buch (Taschenbuch)', price: 'Fr. 18.50' }]));
    expect(await orellFuessli(e).find({ title: 'The Grand Ledger', authors: ['Mira Okafor'] })).toMatchObject({ priceC: 1850 });
    expect(e.asked).toEqual(['https://www.orellfuessli.ch/suche?sq=The+Grand+Ledger+Mira+Okafor']);
  });
});

describe('Open Library\'s words reach the screen as text only', () => {
  it('no web code renders HTML from data: no dangerouslySetInnerHTML, innerHTML or outerHTML but the icons', () => {
    const web = fileURLToPath(new URL('../../web/src/', import.meta.url));
    const files = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
    // The one exception: the design system's icons (ui.tsx), SVG from its own fixed set by name, never from data.
    const hits = files(web).flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML/.test(l)).map((l) => `${relative(web, f)}: ${l.trim()}`));
    expect(hits).toEqual(["ui.tsx: return <span aria-hidden=\"true\" style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: window.I(name, className) }} />;"]);
  });
});

describe('the prices job', () => {
  const NOW = new Date('2026-11-16T10:00:00Z');
  const source = (find: PriceSource['find']): PriceSource => ({ id: 'orellfuessli', find });

  it('looks up candidates the household does not own, one every 3 s, and keeps what it found', async () => {
    const db = household();
    const pauses: number[] = [];
    const out = await refreshPrices(db, source(async () => ({ externalId: 'A4000000001', priceC: 2290, availability: 'Lieferbar' })), { now: () => NOW, sleep: async (ms) => { pauses.push(ms); } });
    const books = db.select().from(t.bookOffer).all();
    expect(out.status).toBe('done');
    expect(books.length).toBeGreaterThan(0);
    expect(books.every((o) => o.priceC === 2290 && o.seenAt === NOW.toISOString())).toBe(true);
    expect(pauses.every((p) => p === PRICE_PAUSE_MS)).toBe(true);
    // Fresh for 7 days: asked again only after that.
    expect(booksNeedingPrices(db, 'orellfuessli', new Date(NOW.getTime() + 6 * 86_400_000))).toEqual([]);
    expect(booksNeedingPrices(db, 'orellfuessli', new Date(NOW.getTime() + 8 * 86_400_000)).length).toBe(books.length);
  });

  it('not found this time: a price seen before stays', async () => {
    const db = household();
    db.insert(t.bookOffer).values({ bookId: 'b_tide', source: 'orellfuessli', externalId: 'A5', priceC: 1990, seenAt: '2026-01-01T00:00:00Z' }).run();
    await refreshPrices(db, source(async () => null), { now: () => NOW, sleep: noSleep });
    expect(db.select().from(t.bookOffer).where(eq(t.bookOffer.bookId, 'b_tide')).get()).toMatchObject({ priceC: 1990, seenAt: NOW.toISOString() });
  });

  it('when the shop refuses Philobiblos (403, 429), the run stops at once and nothing changes', async () => {
    for (const status of [403, 429]) {
      const db = household();
      let calls = 0;
      const out = await refreshPrices(db, source(async () => { calls++; throw new EgressError('status', `www.orellfuessli.ch answered ${status}`, status); }), { now: () => NOW, sleep: noSleep });
      expect(out).toMatchObject({ status: 'blocked' });
      expect(out.detail).toContain(String(status));
      expect(calls).toBe(1);
      expect(db.select().from(t.bookOffer).all()).toEqual([]);
    }
  });

  it('an unknown price counts as CHF 25 in the month, and the screen says it is unknown', async () => {
    expect(UNKNOWN_PRICE_C).toBe(2500);
    const db = household();
    const { app } = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY }), db);
    const cookie = sessionCookie(db, 'p_alex');
    const month = (await app.inject({ url: '/api/month', headers: { cookie } })).json();
    type Pick = { candidate: { price?: number } };
    const picks: Pick[] = [...month.adults, ...month.kids].flatMap((g: { picks: Pick[] }) => g.picks);
    expect(picks.length).toBeGreaterThan(0);
    // No offers in this household: every pick's price is unknown, shown as such, and counted as CHF 25.
    expect(picks.every((p) => p.candidate.price === undefined)).toBe(true);
    expect(month.total).toBe(picks.length * UNKNOWN_PRICE_C);
    const web = readFileSync(new URL('../../web/src/pages/ThisMonth.tsx', import.meta.url), 'utf8');
    expect(web).toContain("'Price unknown'");
    expect(readFileSync(new URL('../../web/src/pages/Backlog.tsx', import.meta.url), 'utf8')).toContain("'Price unknown'");
  });
});

describe('Open Library', () => {
  it('a work: description as text or { value }, cut to length; subjects deduplicated, at most 20', () => {
    expect(parseWork({ description: { value: 'x'.repeat(5000) }, subjects: ['Economics', 'Economics', 42, 'Tides'] })).toEqual({ description: 'x'.repeat(2000), subjects: ['Economics', 'Tides'], coverId: null });
    expect(parseWork({ description: 'Short.', subjects: Array.from({ length: 30 }, (_, i) => `S${i}`), covers: [123] })).toMatchObject({ subjects: expect.arrayContaining(['S0']), coverId: '123' });
    expect(parseWork({ description: 'Short.', subjects: Array.from({ length: 30 }, (_, i) => `S${i}`) }).subjects).toHaveLength(20);
    expect(parseWork({ description: ['not', 'text'], covers: [-1] })).toEqual({ description: null, subjects: [], coverId: null });
  });

  it('a search: only a work key, the same title and the author\'s surname count', () => {
    const docs = [
      { key: '/works/OL1W', title: 'The Long Tide of Markets: A Workbook', author_name: ['Mira Okafor'] },
      { key: '/authors/OL2A', title: 'The Long Tide of Markets', author_name: ['Mira Okafor'] },
      { key: '/works/OL3W', title: 'The Long Tide of Markets', author_name: ['A. Nother'] },
      { key: '/works/OL4W', title: 'The Long Tide of Markets', author_name: ['Mira Okafor'] },
    ];
    expect(pickSearchDoc(docs, 'The Long Tide of Markets', 'Mira Okafor')?.key).toBe('/works/OL4W');
    expect(pickSearchDoc('nope', 'x', undefined)).toBeNull();
  });

  it('by ISBN, then the work; a work key that is not one is never followed', async () => {
    const e = fakeEgress((u) => (u.endsWith('/isbn/9780000000002.json') ? { works: [{ key: '/works/OL9W' }], covers: [77] }
      : u.endsWith('/works/OL9W.json') ? { description: 'About tides.', subjects: ['Tides'] } : null));
    expect(await lookup(e, { title: 'X', authors: [], isbn13: '9780000000002' })).toEqual({ externalId: '/works/OL9W', description: 'About tides.', subjects: ['Tides'], coverId: '77' });
    const evil = fakeEgress((u) => (u.includes('/isbn/') ? { works: [{ key: '/../../admin' }] } : u.includes('search.json') ? { docs: [] } : null));
    expect(await lookup(evil, { title: 'X', authors: [], isbn13: '9780000000002' })).toBeNull();
    expect(evil.asked.every((u) => u.startsWith('https://openlibrary.org/'))).toBe(true);
    expect(evil.asked.some((u) => u.includes('admin'))).toBe(false);
  });

  it('the metadata job keeps what it found, and what it did not (asked again only by hand)', async () => {
    const db = household();
    const e = fakeEgress((u) => (u.includes('search.json') ? { docs: [{ key: '/works/OL5W', title: 'The Long Tide of Markets', author_name: ['Mira Okafor'], cover_i: 5 }] }
      : u.endsWith('/works/OL5W.json') ? { subjects: ['Markets'] } : null));
    expect((await refreshMetadata(db, e, { sleep: noSleep })).status).toBe('done');
    const rows = db.select().from(t.bookMeta).all();
    expect(rows.find((r) => r.bookId === 'b_tide')).toMatchObject({ status: 'found', externalId: '/works/OL5W', coverId: '5', subjectsJson: '["Markets"]' });
    expect(rows.find((r) => r.bookId === 'b_ledger')).toMatchObject({ status: 'not_found' });
    const asked = e.asked.length;
    await refreshMetadata(db, e, { sleep: noSleep });
    expect(e.asked.length).toBe(asked);
    await refreshMetadata(db, e, { sleep: noSleep, again: true });
    expect(e.asked.length).toBeGreaterThan(asked);
  });
});

describe('covers', () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const withMeta = () => {
    const db = household();
    db.insert(t.bookMeta).values({ bookId: 'b_tide', source: 'openlibrary', coverId: '42', status: 'found', fetchedAt: '2026-11-16T00:00:00Z' }).run();
    db.insert(t.bookMeta).values({ bookId: 'b_ledger', source: 'openlibrary', coverId: '../../etc', status: 'found', fetchedAt: '2026-11-16T00:00:00Z' }).run();
    return db;
  };

  it('only the media worker\'s fresh JPEG is kept, never the original; a cover id that is not a number is never asked for', async () => {
    const db = withMeta();
    const dataDir = mkdtempSync(join(tmpdir(), 'philobiblos-covers-'));
    const original = Buffer.from('original bytes, EXIF and all');
    const e = fakeEgress((u, want) => (want === 'image' && u === 'https://covers.openlibrary.org/b/id/42-L.jpg?default=false' ? original : null));
    const handed: Buffer[] = [];
    const out = await refreshCovers(db, e, { dataDir, workDir: '/work' }, { sleep: noSleep, media: async (_r, kind, input) => { expect(kind).toBe('image.reencode'); handed.push(Buffer.from(input)); return { id: 'x', ok: true, kind: 'image.reencode', width: 1, height: 1, format: 'jpeg', bytes: 4, image: JPEG }; } });
    expect(out.status).toBe('done');
    expect(e.asked).toEqual(['https://covers.openlibrary.org/b/id/42-L.jpg?default=false']);
    expect(handed).toEqual([original]);
    expect(readFileSync(join(dataDir, 'covers', 'b_tide.jpg'))).toEqual(JPEG);
    expect(db.select().from(t.book).where(eq(t.book.id, 'b_tide')).get()?.coverPath).toBe('covers/b_tide.jpg');
  });

  it('a cover the worker refuses is not kept; without a worker the run stops', async () => {
    const db = withMeta();
    const dataDir = mkdtempSync(join(tmpdir(), 'philobiblos-covers-'));
    const e = fakeEgress(() => Buffer.from('x'));
    await refreshCovers(db, e, { dataDir, workDir: '/work' }, { sleep: noSleep, media: async () => ({ id: 'x', ok: false, error: 'not_this_type' }) });
    expect(existsSync(join(dataDir, 'covers', 'b_tide.jpg'))).toBe(false);
    expect((await refreshCovers(db, e, { dataDir, workDir: null }, { sleep: noSleep })).status).toBe('blocked');
  });
});

describe('POST /jobs/{job}/run', () => {
  const app = async (find: PriceSource['find']) => {
    const db = household();
    const runs: Promise<void>[] = [];
    const built = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY, PHILOBIBLOS_EGRESS: 'off' }), db,
      { jobs: { prices: { id: 'orellfuessli', find }, env: { sleep: noSleep }, started: (_j, d) => runs.push(d) } });
    return { db, app: built.app, runs, admin: { cookie: sessionCookie(db, 'p_alex'), origin: ORIGIN }, adult: { cookie: sessionCookie(db, 'p_sam'), origin: ORIGIN } };
  };

  it('admins only; one run of a job at a time; logged in job_run', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const a = await app(async () => { await gate; return null; });
    expect((await a.app.inject({ method: 'POST', url: '/api/jobs/prices/run', headers: a.adult })).statusCode).toBe(403);
    const first = await a.app.inject({ method: 'POST', url: '/api/jobs/prices/run', headers: a.admin });
    expect(first.statusCode).toBe(202);
    expect((await a.app.inject({ method: 'POST', url: '/api/jobs/prices/run', headers: a.admin })).statusCode).toBe(409);
    expect((await a.app.inject({ method: 'POST', url: '/api/jobs/nope/run', headers: a.admin })).statusCode).toBe(404);
    release();
    await Promise.all(a.runs);
    expect(a.db.select().from(t.jobRun).where(eq(t.jobRun.id, first.json().id)).get()).toMatchObject({ job: 'prices', status: 'done' });
  });

  it('with egress off, the outside jobs stop at once and say why', async () => {
    const a = await app(async () => null);
    const r = await a.app.inject({ method: 'POST', url: '/api/jobs/metadata/run', headers: a.admin });
    await Promise.all(a.runs);
    expect(a.db.select().from(t.jobRun).where(eq(t.jobRun.id, r.json().id)).get()).toMatchObject({ status: 'blocked', detail: expect.stringContaining('PHILOBIBLOS_EGRESS=off') });
  });
});
