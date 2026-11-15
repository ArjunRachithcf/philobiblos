// The Library (spec §4) on the sample seed (seed-sample/, all invented): who sees what, who changes what, takeaways
// private to their person, and the AI gate for them (ADR 0009).
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb, type Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { readBooksForAi } from '../src/library/ai-context';
import { KIDS_THEMES } from '../src/library/library';
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
  for (const h of ['alex', 'partner']) cookie[h] = sessionCookie(db, id[h]!);
  built = await buildApp(loadConfig({ SHELF_MODE: 'standalone', SHELF_DATA_DIR: '/nonexistent' }), db);
  await built.app.ready();
});
afterAll(() => built.app.close());

const get = (who: string, url: string) => built.app.inject({ url, headers: { cookie: cookie[who]! } });
const put = (who: string, url: string, payload: unknown) => built.app.inject({ method: 'PUT', url, payload: payload as object, headers: { cookie: cookie[who]!, origin: ORIGIN } });
const bookId = (title: string) => db.select().from(t.book).where(eq(t.book.title, title)).get()!.id;

describe('the seed import', () => {
  it('keeps the seed\'s handles', () => {
    expect(Object.keys(id).sort()).toEqual(['alex', 'kid1', 'kid2', 'partner']);
  });
});

describe('a library', () => {
  it('an adult\'s: the owned adult books (read for the first adult, from the seed), their ideas and stats', async () => {
    const lib = (await get('alex', `/api/people/${id.alex}/library`)).json();
    expect(lib.person).toMatchObject({ name: 'Alex' });
    const tide = lib.books.find((b: { book: { title: string } }) => b.book.title === 'The Long Tide of Markets');
    expect(tide).toMatchObject({ reading: { status: 'read' }, ideas: ['Markets and value'] });
    expect(lib.books.every((b: { book: { audience: string } }) => b.book.audience === 'adult')).toBe(true);
    expect(lib.stats).toMatchObject({ read: lib.books.length, reading: 0, unreadPile: 0, unreadLimit: 4, takeaways: 0 });
  });

  it('another adult\'s: what the household owns and they have not read is their unread pile', async () => {
    const lib = (await get('alex', `/api/people/${id.partner}/library`)).json();
    expect(lib.books.length).toBeGreaterThan(0);
    expect(lib.books.every((b: { reading: { status: string } }) => b.reading.status === 'to_read')).toBe(true);
    expect(lib.stats.unreadPile).toBe(lib.books.length);
  });

  it('a kid\'s: the owned kids\' books, feedback and the emotional map of all fourteen themes', async () => {
    const lib = (await get('alex', `/api/people/${id.kid2}/library`)).json();
    expect(lib.books.length).toBeGreaterThan(0);
    expect(lib.books.every((b: { book: { audience: string } }) => b.book.audience === 'kids')).toBe(true);
    expect(lib.themes.map((x: { theme: string }) => x.theme)).toEqual([...KIDS_THEMES]);
    expect(lib.themes.reduce((n: number, x: { books: number }) => n + x.books, 0)).toBeGreaterThan(0);
  });

  it('an unknown person is 404', async () => {
    expect((await get('alex', '/api/people/nobody/library')).statusCode).toBe(404);
  });
});

describe('statuses and takeaways', () => {
  const tide = () => bookId('The Long Tide of Markets');

  it('you mark your own book; read sets the finishing day', async () => {
    const r = await put('partner', `/api/people/${id.partner}/reading/${tide()}`, { status: 'read' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: 'read', finishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), takeaway: null });
  });

  it('a takeaway is yours alone: nobody else sees it, or how many you have', async () => {
    const r = await put('partner', `/api/people/${id.partner}/reading/${tide()}`, { takeaway: '  Prices   leave out\nmost of what matters. ' });
    expect(r.json().takeaway).toBe('Prices leave out most of what matters.');
    const mine = (await get('partner', `/api/people/${id.partner}/library`)).json();
    expect(mine.books.find((b: { book: { id: string } }) => b.book.id === tide()).reading.takeaway).toBe('Prices leave out most of what matters.');
    expect(mine.stats.takeaways).toBe(1);
    const seen = await get('alex', `/api/people/${id.partner}/library`);
    expect(seen.body).not.toContain('Prices leave out');
    expect(seen.json().stats.takeaways).toBeUndefined();
    expect(seen.json().books.find((b: { book: { id: string } }) => b.book.id === tide()).reading).toMatchObject({ status: 'read', takeaway: null });
  });

  it('nobody changes another adult\'s reading, an admin neither', async () => {
    expect((await put('alex', `/api/people/${id.partner}/reading/${tide()}`, { status: 'abandoned' })).statusCode).toBe(403);
    expect((await put('alex', `/api/people/${id.partner}/reading/${tide()}`, { takeaway: 'x' })).statusCode).toBe(403);
  });

  it('adults act for kids: feedback, never a takeaway; a loved book has been read', async () => {
    const kidsBook = (await get('partner', `/api/people/${id.kid2}/library`)).json().books[0].book.id;
    const r = await put('partner', `/api/people/${id.kid2}/reading/${kidsBook}`, { feedback: 'loved' });
    expect(r.json()).toMatchObject({ status: 'read', feedback: 'loved' });
    const lib = (await get('alex', `/api/people/${id.kid2}/library`)).json();
    expect(lib.themes.reduce((n: number, x: { loved: number }) => n + x.loved, 0)).toBe(1);
    expect((await put('partner', `/api/people/${id.kid2}/reading/${kidsBook}`, { takeaway: 'x' })).statusCode).toBe(400);
  });

  it.each([
    ['feedback for an adult', { feedback: 'loved' }],
    ['an unknown field', { status: 'read', rating: 5 }],
    ['an unknown status', { status: 'done' }],
    ['a takeaway over 280 characters', { takeaway: 'x'.repeat(281) }],
    ['a bad date', { finishedAt: '2026-13-45' }],
    ['not an object', [1]],
  ])('400: %s', async (_n, body) => {
    expect((await put('alex', `/api/people/${id.alex}/reading/${tide()}`, body)).statusCode).toBe(400);
  });

  it('404 for an unknown book', async () => {
    expect((await put('alex', `/api/people/${id.alex}/reading/nope`, { status: 'read' })).statusCode).toBe(404);
  });
});

describe('your settings and the AI gate', () => {
  const patch = (who: string, payload: unknown) => built.app.inject({ method: 'PATCH', url: '/api/settings', payload: payload as object, headers: { cookie: cookie[who]!, origin: ORIGIN } });

  it('no AI reads a takeaway until its person turns that on; it is per person', async () => {
    const before = readBooksForAi(db, id.partner!);
    expect(before.length).toBeGreaterThan(0);
    expect(JSON.stringify(before)).not.toContain('Prices leave out');
    expect((await get('partner', '/api/settings')).json().person).toMatchObject({ takeawaysToAi: false, takeaways: true, unreadLimit: 4 });

    expect((await patch('partner', { person: { takeawaysToAi: true } })).statusCode).toBe(200);
    expect(readBooksForAi(db, id.partner!).find((b) => b.title === 'The Long Tide of Markets')).toMatchObject({ takeaway: 'Prices leave out most of what matters.', ideas: ['Markets and value'] });
    // Alex's setting is Alex's: still off.
    expect((await get('alex', '/api/settings')).json().person.takeawaysToAi).toBe(false);
    expect((await patch('partner', { person: { takeawaysToAi: false } })).statusCode).toBe(200);
    expect(JSON.stringify(readBooksForAi(db, id.partner!))).not.toContain('Prices leave out');
    expect(readBooksForAi(db, id.kid2!)).toEqual([]);
  });

  it('your unread limit shows in your library; bad values are refused', async () => {
    expect((await patch('alex', { person: { unreadLimit: 6 } })).statusCode).toBe(200);
    expect((await get('alex', `/api/people/${id.alex}/library`)).json().stats.unreadLimit).toBe(6);
    for (const person of [{ unreadLimit: -1 }, { unreadLimit: 2.5 }, { takeawaysToAi: 'yes' }, { weights: {} }, { nickname: 'x' }, 'x']) {
      expect((await patch('alex', { person })).statusCode, JSON.stringify(person)).toBe(400);
    }
  });
});
