// The Library (spec §4) on the sample seed (seed-sample/, all invented): who sees what, who changes what, takeaways
// private to their person, and the AI gate for them (ADR 0009).
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb, type Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { purgeTakeawayRuns, readBooksForAi } from '../src/library/ai-context';
import { PRIVATE_REASON } from '../src/knowledge/knowledge';
import { removePerson } from '../src/household/people';
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

  it('a kids\' book with two themes counts under both', async () => {
    const lib = (await get('alex', `/api/people/${id.kid2}/library`)).json();
    const b = lib.books[0];
    const extra = KIDS_THEMES.find((x) => !b.themes.includes(x))!;
    db.insert(t.bookTheme).values({ bookId: b.book.id, theme: extra }).run();
    const after = (await get('alex', `/api/people/${id.kid2}/library`)).json();
    expect(after.books.find((x: { book: { id: string } }) => x.book.id === b.book.id).themes).toEqual([...b.themes, extra].sort());
    const n = (l: { themes: { theme: string; books: number }[] }, th: string) => l.themes.find((x) => x.theme === th)!.books;
    expect(n(after, extra)).toBe(n(lib, extra) + 1);
    expect(n(after, b.themes[0])).toBe(n(lib, b.themes[0]));
    db.delete(t.bookTheme).where(eq(t.bookTheme.theme, extra)).run();
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

  it('leaving read clears the finishing day, whichever way it goes', async () => {
    const url = `/api/people/${id.alex}/reading/${bookId('A Short History of Bread')}`;
    await put('alex', url, { status: 'to_read' });
    for (const status of ['abandoned', 'to_read', 'reading']) {
      expect((await put('alex', url, { status: 'read' })).json().finishedAt).toMatch(/^\d{4}-/);
      expect((await put('alex', url, { status })).json()).toMatchObject({ status, finishedAt: null });
    }
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

  it('turning the AI gate off purges the runs built from your takeaways, and what they proposed', async () => {
    const now = new Date().toISOString();
    const run = (rid: string, of: string | null) => db.insert(t.aiRun).values({ id: rid, job: 'link', provider: 'ollama', model: 'm', promptVersion: 'v1', inputHash: rid, outputJson: '{}', startedAt: now, takeawaysOf: of }).run();
    run('run_sam', id.partner!);
    run('run_plain', null);
    const [a, b2, c] = ['The Long Tide of Markets', 'A Short History of Bread', 'Gardens of the Commons'].map(bookId);
    db.insert(t.bookLink).values([
      { fromBook: a!, toBook: b2!, reason: 'proposed from a takeaway', confidence: 0.6, state: 'proposed', aiRunId: 'run_sam' },
      { fromBook: c!, toBook: a!, reason: 'confirmed by a person', confidence: 0.9, state: 'confirmed', aiRunId: 'run_sam' },
      { fromBook: c!, toBook: b2!, reason: 'no takeaways in it', confidence: 0.6, state: 'proposed', aiRunId: 'run_plain' },
    ]).run();
    expect((await patch('partner', { person: { takeawaysToAi: true } })).statusCode).toBe(200);
    expect((await patch('partner', { person: { takeawaysToAi: false } })).statusCode).toBe(200);
    expect(db.select({ id: t.aiRun.id }).from(t.aiRun).all()).toEqual([{ id: 'run_plain' }]);
    expect(db.select({ reason: t.bookLink.reason, run: t.bookLink.aiRunId }).from(t.bookLink).where(eq(t.bookLink.toBook, a!)).all())
      .toContainEqual({ reason: PRIVATE_REASON, run: null }); // decided, kept, its reason neutral (written from Sam's takeaways)
    expect(db.select().from(t.bookLink).where(eq(t.bookLink.reason, 'proposed from a takeaway')).all()).toEqual([]);
    expect(db.select().from(t.bookLink).where(eq(t.bookLink.reason, 'no takeaways in it')).all()).toHaveLength(1);
    expect(purgeTakeawayRuns(db, id.partner!)).toBe(0);
  });

  it('a removed person\'s runs go with them', () => {
    db.insert(t.person).values({ id: 'p_gone', name: 'Robin', role: 'adult', handle: 'robin' }).run();
    db.insert(t.aiRun).values({ id: 'run_gone', job: 'link', provider: 'ollama', model: 'm', promptVersion: 'v1', inputHash: 'g', startedAt: new Date().toISOString(), takeawaysOf: 'p_gone' }).run();
    db.insert(t.bookIdea).values({ bookId: bookId('Gardens of the Commons'), ideaId: db.select().from(t.idea).get()!.id, layer: 'deep', confidence: 0.5, state: 'proposed', aiRunId: 'run_gone' }).run();
    removePerson(db, 'p_gone', id.alex!);
    expect(db.select().from(t.aiRun).where(eq(t.aiRun.id, 'run_gone')).all()).toEqual([]);
    expect(db.select().from(t.bookIdea).where(eq(t.bookIdea.aiRunId, 'run_gone')).all()).toEqual([]);
  });

  it('the household\'s settings: 403 for an adult, 400 for an admin until they are stored; never a silent 200', async () => {
    expect((await patch('partner', { budget: { minC: 1 } })).statusCode).toBe(403);
    expect((await patch('partner', { person: { unreadLimit: 5 }, adultPicks: 3 })).statusCode).toBe(403);
    expect((await patch('alex', { budget: { minC: 1 } })).statusCode).toBe(400);
  });

  it('your unread limit shows in your library; bad values are refused', async () => {
    expect((await patch('alex', { person: { unreadLimit: 6 } })).statusCode).toBe(200);
    expect((await get('alex', `/api/people/${id.alex}/library`)).json().stats.unreadLimit).toBe(6);
    for (const person of [{ unreadLimit: -1 }, { unreadLimit: 2.5 }, { takeawaysToAi: 'yes' }, { weights: {} }, { nickname: 'x' }, 'x']) {
      expect((await patch('alex', { person })).statusCode, JSON.stringify(person)).toBe(400);
    }
  });
});

describe('the takeaway boundary (architecture)', () => {
  // Only the Library and the AI gate read takeaways; everything else, AI jobs included, goes through
  // library/ai-context.ts. db/schema.ts declares the column; packages/ai/src/provider.ts types what a provider gets.
  const ALLOWED = new Set(['apps/server/src/library/library.ts', 'apps/server/src/library/ai-context.ts', 'apps/server/src/db/schema.ts', 'packages/ai/src/provider.ts']);
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'node_modules' || f === 'dist' ? [] : files(p);
    return /\.tsx?$/.test(f) && !f.endsWith('.gen.ts') ? [p] : [];
  });
  const sources = [join(root, 'apps/server/src'), ...readdirSync(join(root, 'packages')).map((d) => join(root, 'packages', d, 'src'))].flatMap(files);

  // Per rule, the files allowed past it. backlog.ts and knowledge.ts may select named columns (status, feedback, dates) from `reading`,
  // never a whole row (a row holds the takeaway); the first rule keeps the column out of it by name.
  it.each([
    ['the takeaway column or field', /\btakeaway\b/, ALLOWED],
    ['a select from the reading table', /\.from\(t\.reading\)|\bfrom\s+reading\b/i, new Set([...ALLOWED, 'apps/server/src/backlog/backlog.ts', 'apps/server/src/knowledge/knowledge.ts'])],
    ['a whole-row select from the reading table', /select(Distinct)?\(\s*\)\s*\.from\(t\.reading\)|select\s+\*\s+from\s+reading\b/i, ALLOWED],
  ] as const)('nothing else mentions %s', (_n, re, allowed) => {
    expect(sources.length).toBeGreaterThan(20);
    const hits = sources.map((f) => relative(root, f)).filter((f) => !allowed.has(f) && re.test(readFileSync(join(root, f), 'utf8')));
    expect(hits).toEqual([]);
  });

  it('the whole-row rule catches what it should', () => {
    const re = /select(Distinct)?\(\s*\)\s*\.from\(t\.reading\)/;
    expect(re.test('db.select().from(t.reading)')).toBe(true);
    expect(re.test('db.selectDistinct().from(t.reading)')).toBe(true);
    expect(re.test('db.select({ s: t.reading.status }).from(t.reading)')).toBe(false);
  });
});
