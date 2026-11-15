// The Backlog (spec §4, contracts/backlog-query.md) and the budget, on the sample seed (seed-sample/, all invented):
// scores from packages/scoring, the query language, tabs, facets, pages, and who may change what, per route.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { scoreAdult } from '@shelf/scoring';
import { buildApp, type BuiltApp } from '../src/app';
import { allCandidates } from '../src/backlog/backlog';
import { loadConfig } from '../src/config';
import { openDb, type Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { importSeed } from '../src/seed/import';
import { ORIGIN, sessionCookie } from './helpers';

const SAMPLE = fileURLToPath(new URL('../../../seed-sample', import.meta.url));
let db: Db;
let built: BuiltApp;
const id: Record<string, string> = {};
const cookie: Record<string, string> = {};

beforeAll(async () => {
  db = openDb(':memory:');
  importSeed(db, SAMPLE, '2026-11-01T00:00:00.000Z');
  for (const p of db.select().from(t.person).all()) id[p.handle!] = p.id;
  for (const h of ['alex', 'partner', 'kid1']) cookie[h] = sessionCookie(db, id[h]!);
  built = await buildApp(loadConfig({ SHELF_MODE: 'standalone', SHELF_DATA_DIR: '/nonexistent' }), db);
  await built.app.ready();
});
afterAll(() => built.app.close());

type Item = { id: string; book: { id: string; title: string; audience: string }; for: { name: string; role: string }; state: string; closedReason: string | null; move?: string; score?: number; scoreParts: { value: number }[]; price?: number; source: string };
const list = async (q: string, who = 'alex', extra = '') => {
  const r = await built.app.inject({ url: `/api/backlog?q=${encodeURIComponent(q)}${extra}`, headers: { cookie: cookie[who]! } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { items: Item[]; counts: { open: number; closed: number }; facets: Record<string, { value: string; count: number }[]>; nextCursor: string | null; queryErrors: string[] };
};
const post = (who: string, url: string, payload: unknown) => built.app.inject({ method: 'POST', url, payload: payload as object, headers: { cookie: cookie[who]!, origin: ORIGIN } });
const bookId = (title: string) => db.select().from(t.book).where(eq(t.book.title, title)).get()!.id;

describe('the list', () => {
  it('open candidates, best score first; the score is the sum of its parts (packages/scoring)', async () => {
    const page = await list('is:open');
    expect(page.items.length).toBeGreaterThan(3);
    expect(page.items.every((i) => i.state === 'open')).toBe(true);
    const scores = page.items.map((i) => i.score ?? -Infinity);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    for (const i of page.items.filter((x) => x.score != null)) {
      expect(i.score).toBeCloseTo(i.scoreParts.reduce((n, p) => n + p.value, 0), 1);
    }
    expect(page.counts.open).toBe(page.items.length);
    expect(page.queryErrors).toEqual([]);
  });

  it('an adult candidate\'s score and move match scoreAdult on its facts (links to read books)', async () => {
    const vb = (await list('"value beyond price"')).items[0]!;
    // The seed links it to two books Alex has read; on the To buy list.
    expect(vb.scoreParts).toContainEqual({ label: 'Builds on books read', value: 30, kind: 'links' });
    expect(vb.scoreParts).toContainEqual({ label: 'On the To buy list', value: 5, kind: 'source' });
    expect(vb.move).toBe(scoreAdult({ links: 2, bridge: 1, fillsLayer: null, introAndCoreRead: false, staleMonths: 0, newIdea: false, toBuy: true, fromShare: false, waitingDays: 0, untouchedMonths: 0, priceC: 2490, ideasDense: true }).move);
  });

  it('kids\' candidates score with the kids\' formula', async () => {
    const kids = await list('is:open is:kids');
    expect(kids.items.length).toBeGreaterThan(0);
    expect(kids.items.every((i) => i.book.audience === 'kids' && i.for.role === 'kid')).toBe(true);
    expect(kids.items[0]!.scoreParts).toContainEqual({ label: 'Base', value: 20, kind: 'base' });
  });

  it.each([
    ['is:adult', (i: Item) => i.book.audience === 'adult'],
    ['-is:kids', (i: Item) => i.book.audience === 'adult'],
    ['for:me', (i: Item) => i.for.name === 'Alex'],
    ['for:kid2', (i: Item) => i.for.name === 'Kid 2'],
    ['price:<25', (i: Item) => i.price != null && i.price < 2500],
    ['source:instagram', (i: Item) => i.source === 'share'],
    ['source:to-buy', (i: Item) => i.source === 'to_buy'],
    ['author:okafor', (i: Item) => i.book.title === 'Value Beyond Price' || i.book.title === 'The Grand Ledger'],
    ['links:>=2', (i: Item) => ['Value Beyond Price', 'Care at the Centre', 'Before the First Cities', 'The Grand Ledger'].includes(i.book.title)],
  ])('%s', async (q, ok) => {
    const page = await list(q);
    expect(page.items.length, q).toBeGreaterThan(0);
    expect(page.items.every(ok), q).toBe(true);
  });

  it('sorts by title, price and added, both ways; unknown values last', async () => {
    const titles = (await list('sort:title')).items.map((i) => i.book.title);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
    const prices = (await list('sort:price-desc')).items.map((i) => i.price);
    const known = prices.filter((p) => p != null) as number[];
    expect(known).toEqual([...known].sort((a, b) => b - a));
    expect(prices.slice(known.length).every((p) => p == null)).toBe(true);
  });

  it('facets count the tab\'s values; bad qualifiers come back as queryErrors, never an error', async () => {
    const page = await list('is:open nonsense:1 price:cheap');
    expect(page.queryErrors).toHaveLength(2);
    expect(page.facets.for!.map((f) => f.value).sort()).toEqual(['alex', 'kid2']);
    expect(page.facets.source!.reduce((n, f) => n + f.count, 0)).toBe(page.items.length);
  });

  it('pages with cursor and limit', async () => {
    const all = (await list('sort:title')).items.map((i) => i.id);
    const first = await list('sort:title', 'alex', '&limit=2');
    expect(first.items.map((i) => i.id)).toEqual(all.slice(0, 2));
    const second = await list('sort:title', 'alex', `&limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((i) => i.id)).toEqual(all.slice(2, 4));
    expect((await built.app.inject({ url: '/api/backlog?limit=500', headers: { cookie: cookie.alex! } })).statusCode).toBe(400);
  });

  it('a book the household comes to own closes as owned', async () => {
    db.insert(t.copy).values({ id: 'c_test', bookId: bookId('Markets Made Simple'), source: 'manual', acquiredAt: '2026-11-02T00:00:00.000Z' }).run();
    const closed = await list('is:closed reason:owned');
    expect(closed.items.map((i) => i.book.title)).toEqual(['Markets Made Simple']);
    expect((await list('"markets made simple"')).items).toEqual([]);
  });
});

describe('adding by hand (POST /backlog)', () => {
  it('for yourself or a kid; not for another adult', async () => {
    const r = await post('partner', '/api/backlog', { title: 'Fins to Fingers', author: 'Hana Sato' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ for: { name: 'Sam' }, source: 'manual', state: 'open', book: { title: 'Fins to Fingers' } });
    expect((await post('partner', '/api/backlog', { title: 'A New Kite', for: 'kid1' })).statusCode).toBe(201);
    expect((await post('partner', '/api/backlog', { title: 'A Thing', for: 'alex' })).statusCode).toBe(403);
    expect((await post('alex', '/api/backlog', { title: 'A Thing', for: 'partner' })).statusCode).toBe(403);
  });
  it.each([
    [409, 'already there', { title: 'Fins to Fingers', author: 'Hana Sato' }],
    [404, 'an unknown handle', { title: 'X', for: 'nobody' }],
    [400, 'no title', { author: 'X' }],
    [400, 'a bad ISBN', { title: 'X', isbn13: '12345' }],
    [400, 'an unknown field', { title: 'X', note: 'hi' }],
    [400, 'a title too long', { title: 'x'.repeat(301) }],
  ])('%i: %s', async (status, _n, body) => {
    expect((await post('partner', '/api/backlog', body)).statusCode).toBe(status);
  });
});

describe('bulk actions (POST /backlog/bulk)', () => {
  const alexOpen = async () => (await list('is:open for:alex')).items.map((i) => i.id);
  const kidOpen = async () => (await list('is:open for:kid2')).items.map((i) => i.id);

  it('your own and the kids\'; all or nothing when one is another adult\'s', async () => {
    const [mine] = await alexOpen();
    const [kids] = await kidOpen();
    expect((await post('alex', '/api/backlog/bulk', { ids: [mine, kids], action: 'not_for_me' })).json()).toEqual({ changed: 2 });
    expect((await list('is:closed reason:not-for-me')).items.map((i) => i.id).sort()).toEqual([mine, kids].sort());
    const [other] = await alexOpen();
    const [kid2] = await kidOpen();
    expect((await post('partner', '/api/backlog/bulk', { ids: [kid2, other], action: 'not_for_me' })).statusCode).toBe(403);
    expect(await kidOpen()).toContain(kid2); // nothing changed
    expect((await post('alex', '/api/backlog/bulk', { ids: [mine, kids], action: 'reopen' })).statusCode).toBe(200);
  });

  it('a snooze closes a candidate until it ends', async () => {
    const [mine] = await alexOpen();
    expect((await post('alex', '/api/backlog/bulk', { ids: [mine], action: 'snooze', months: 1 })).statusCode).toBe(200);
    expect((await list('is:closed reason:snoozed')).items.map((i) => i.id)).toEqual([mine]);
    const later = new Date(Date.now() + 40 * 86_400_000);
    expect(allCandidates(db, later).find((c) => c.id === mine)!.state).toBe('open');
    await post('alex', '/api/backlog/bulk', { ids: [mine], action: 'reopen' });
  });

  it.each([
    [400, { ids: [], action: 'reopen' }],
    [400, { ids: ['x'], action: 'reopen' }],
    [400, { ids: ['a.b'], action: 'burn' }],
    [404, { ids: ['a.b'], action: 'add_to_month' }],
    [400, { ids: ['a.b'], action: 'snooze', months: 99 }],
    [404, { ids: ['nobody.book'], action: 'reopen' }],
  ])('%i: %j', async (status, body) => {
    expect((await post('alex', '/api/backlog/bulk', body)).statusCode).toBe(status);
  });

  it('a kid\'s session is refused everywhere (403)', async () => {
    expect((await post('kid1', '/api/backlog/bulk', { ids: ['a.b'], action: 'reopen' })).statusCode).toBe(403);
    expect((await post('kid1', '/api/backlog', { title: 'X' })).statusCode).toBe(403);
  });
});

describe('saved filters', () => {
  it('the defaults until you save one; then yours, per person; at most 20', async () => {
    const get = async (who: string) => (await built.app.inject({ url: '/api/backlog/saved-filters', headers: { cookie: cookie[who]! } })).json() as { id: string; name: string; q: string }[];
    expect((await get('alex')).map((f) => f.name)).toEqual(['To buy now', 'Kids', 'Cheap & good', 'From Instagram']);
    expect((await post('alex', '/api/backlog/saved-filters', { name: 'Kites', q: 'theme:courage' })).statusCode).toBe(201);
    expect((await get('alex')).map((f) => f.name)).toEqual(['To buy now', 'Kids', 'Cheap & good', 'From Instagram', 'Kites']);
    expect((await get('partner')).map((f) => f.name)).not.toContain('Kites');
    for (const body of [{ name: '', q: 'x' }, { name: 'x' }, { name: 'x', q: 'y', z: 1 }]) expect((await post('alex', '/api/backlog/saved-filters', body)).statusCode).toBe(400);
    for (let i = 0; i < 15; i++) await post('alex', '/api/backlog/saved-filters', { name: `f${i}`, q: 'is:open' });
    expect((await post('alex', '/api/backlog/saved-filters', { name: 'one more', q: 'is:open' })).statusCode).toBe(409);

    // the cap never locks anyone out: remove one, then save again; rename one
    const call = (who: string, method: 'PATCH' | 'DELETE', fid: string, payload?: unknown) =>
      built.app.inject({ method, url: `/api/backlog/saved-filters/${encodeURIComponent(fid)}`, payload: payload as object, headers: { cookie: cookie[who]!, origin: ORIGIN } });
    const kites = (await get('alex')).find((f) => f.name === 'Kites')!;
    expect((await call('partner', 'DELETE', kites.id)).statusCode).toBe(404); // not yours
    expect((await call('partner', 'PATCH', kites.id, { name: 'Mine now' })).statusCode).toBe(404);
    expect((await call('alex', 'DELETE', kites.id)).statusCode).toBe(204);
    expect((await post('alex', '/api/backlog/saved-filters', { name: 'one more', q: 'is:open' })).statusCode).toBe(201);
    expect((await call('alex', 'PATCH', 'default-1', { name: 'Buy soon' })).statusCode).toBe(204);
    expect((await get('alex'))[0]).toMatchObject({ id: 'default-1', name: 'Buy soon', q: 'is:open is:adult score:>40' });
    for (const body of [{ name: '' }, { name: 'x', q: 'y' }]) expect((await call('alex', 'PATCH', 'default-1', body)).statusCode).toBe(400);
    expect((await call('alex', 'DELETE', 'nope')).statusCode).toBe(404);
  });

  it('a default can be removed or renamed before anything is saved; the rest stay', async () => {
    const get = async () => (await built.app.inject({ url: '/api/backlog/saved-filters', headers: { cookie: cookie.partner! } })).json() as { id: string; name: string }[];
    const del = await built.app.inject({ method: 'DELETE', url: '/api/backlog/saved-filters/default-2', headers: { cookie: cookie.partner!, origin: ORIGIN } });
    expect(del.statusCode).toBe(204);
    expect((await get()).map((f) => f.name)).toEqual(['To buy now', 'Cheap & good', 'From Instagram']);
    // Alex's list is Alex's
    expect((await built.app.inject({ url: '/api/backlog/saved-filters', headers: { cookie: cookie.alex! } })).json().map((f: { name: string }) => f.name)).toContain('Kids');
  });
});

describe('the budget (one shared monthly budget; admins set it)', () => {
  const patch = (who: string, payload: unknown) => built.app.inject({ method: 'PATCH', url: '/api/settings', payload: payload as object, headers: { cookie: cookie[who]!, origin: ORIGIN } });
  const budget = async (who = 'partner') => (await built.app.inject({ url: '/api/settings', headers: { cookie: cookie[who]! } })).json().budget;

  it('everyone sees it; an admin sets it; an adult cannot', async () => {
    expect(await budget()).toEqual({ min: 10000, max: 15000 });
    expect((await patch('alex', { budget: { min: 8000, max: 12000 } })).statusCode).toBe(200);
    expect(await budget()).toEqual({ min: 8000, max: 12000 });
    expect((await patch('partner', { budget: { max: 99900 } })).statusCode).toBe(403);
    expect(await budget()).toEqual({ min: 8000, max: 12000 });
  });

  it.each([
    [{ min: 13000 }], [{ min: -1 }], [{ max: 10.5 }], [{ max: 2_000_000 }], [{ rollover: true }], ['x'],
  ])('400: %j', async (b) => {
    expect((await patch('alex', { budget: b })).statusCode).toBe(400);
    expect(await budget()).toEqual({ min: 8000, max: 12000 });
  });

  it('all or nothing: a bad personal setting keeps the budget as it was', async () => {
    expect((await patch('alex', { budget: { max: 13000 }, person: { unreadLimit: -5 } })).statusCode).toBe(400);
    expect(await budget()).toEqual({ min: 8000, max: 12000 });
  });

  it('still refuses household parts that are not stored yet', async () => {
    expect((await patch('alex', { adultPicks: 3 })).statusCode).toBe(400);
    expect(db.select().from(t.candidate).where(and(eq(t.candidate.personId, id.alex!), eq(t.candidate.origin, 'manual'))).all()).toEqual([]);
  });
});
