// Ideas, layers, links and the Brain (ADR 0005) on the sample seed (seed-sample/, all invented): proposals stay
// proposals until a person decides, the reviewer is recorded, merges and renames, the brain's shape, and the privacy
// of proposals written from someone's takeaways (shelf#3). Authorization per route.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb, type Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { proposeBookIdeas, proposeLinks, privateToFor } from '../src/knowledge/from-run';
import { PRIVATE_REASON } from '../src/knowledge/knowledge';
import { purgeTakeawayRuns } from '../src/library/ai-context';
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

const get = (who: string, url: string) => built.app.inject({ url, headers: { cookie: cookie[who]! } });
const send = (who: string, method: 'PUT' | 'PATCH', url: string, payload: unknown) => built.app.inject({ method, url, payload: payload as object, headers: { cookie: cookie[who]!, origin: ORIGIN } });
const bookId = (title: string) => db.select().from(t.book).where(eq(t.book.title, title)).get()!.id;
const ideaId = (name: string) => db.select().from(t.idea).where(eq(t.idea.name, name)).get()!.id;

describe('the brain', () => {
  it('a rejected tag never counts, even on a read book', async () => {
    const book = bookId('A Short History of Bread');
    db.insert(t.idea).values({ id: 'i_rej', name: 'Rejected idea' }).run();
    db.insert(t.bookIdea).values({ bookId: book, ideaId: 'i_rej', layer: 'core', confidence: 1, state: 'rejected' }).run();
    expect((await get('alex', `/api/people/${id.alex}/brain`)).json().ideas.map((i: { name: string }) => i.name)).not.toContain('Rejected idea');
  });

  it('an adult\'s ideas, with read books per layer, the best open candidate per layer, and edges', async () => {
    // The seed's wishlist ideas are guesses (proposed, 0.5): they count once confirmed.
    db.update(t.bookIdea).set({ state: 'confirmed' }).where(and(eq(t.bookIdea.bookId, bookId('The Grand Ledger')), eq(t.bookIdea.ideaId, ideaId('Markets and value')))).run();
    const r = await get('partner', `/api/people/${id.alex}/brain`);
    expect(r.statusCode, r.body).toBe(200);
    const brain = r.json();
    const markets = brain.ideas.find((i: { name: string }) => i.name === 'Markets and value');
    expect(markets).toMatchObject({ readCount: 2, isNew: false, unreadOwned: 0 });
    expect(Object.keys(markets.layers).sort()).toEqual(['core', 'counterpoint', 'deep', 'intro']);
    expect(markets.layers.core.books.map((b: { title: string }) => b.title).sort()).toEqual(['A Short History of Bread', 'The Long Tide of Markets']);
    expect(markets.layers.core.next).toMatchObject({ title: 'The Grand Ledger' });
    expect(markets.layers.deep.next).toBeNull();
    expect(brain.ideas.every((i: { readCount: number }, n: number, a: { readCount: number }[]) => n === 0 || a[n - 1]!.readCount >= i.readCount)).toBe(true);
  });

  it('a book read in two ideas draws an edge between them', async () => {
    const [a, b] = ['Markets and value', 'Care and the commons'].map(ideaId);
    db.insert(t.bookIdea).values({ bookId: bookId('The Long Tide of Markets'), ideaId: b!, layer: 'intro', confidence: 1, state: 'confirmed' }).run();
    const brain = (await get('alex', `/api/people/${id.alex}/brain`)).json();
    expect(brain.edges).toContainEqual({ a: [a, b].sort()[0], b: [a, b].sort()[1], weight: 1, via: ['The Long Tide of Markets'], kind: 'read' });
    db.delete(t.bookIdea).where(and(eq(t.bookIdea.bookId, bookId('The Long Tide of Markets')), eq(t.bookIdea.ideaId, b!))).run();
  });

  it('kids have no brain; unknown people neither (404); a kid\'s session gets 403', async () => {
    expect((await get('alex', `/api/people/${id.kid1}/brain`)).statusCode).toBe(404);
    expect((await get('alex', '/api/people/nobody/brain')).statusCode).toBe(404);
    expect((await get('kid1', `/api/people/${id.alex}/brain`)).statusCode).toBe(403);
  });
});

describe('proposals and reviews', () => {
  it('a proposed idea counts only once a person confirms it; the reviewer is recorded', async () => {
    const [b, i] = [bookId('Value Beyond Price'), ideaId('Markets and value')];
    const row = () => db.select().from(t.bookIdea).where(and(eq(t.bookIdea.bookId, b), eq(t.bookIdea.ideaId, i))).get()!;
    expect(row().state).toBe('proposed');
    const listed = (await get('alex', '/api/proposals')).json();
    expect(listed.ideas.some((x: { book: { id: string }; idea: { id: string } }) => x.book.id === b && x.idea.id === i)).toBe(true);
    const r = await send('alex', 'PUT', `/api/books/${b}/ideas/${i}`, { layer: 'deep' });
    expect(r.json()).toEqual({ state: 'confirmed', layer: 'deep' });
    expect(row()).toMatchObject({ state: 'confirmed', layer: 'deep', reviewedBy: id.alex });
    expect((await get('alex', '/api/proposals')).json().ideas.some((x: { book: { id: string } }) => x.book.id === b)).toBe(false);
  });

  it('a link: confirm, reject, change your mind', async () => {
    const [from, to] = [bookId('Value Beyond Price'), bookId('The Long Tide of Markets')];
    db.update(t.bookLink).set({ state: 'proposed' }).where(and(eq(t.bookLink.fromBook, from), eq(t.bookLink.toBook, to))).run();
    expect((await send('partner', 'PUT', `/api/links/${from}/${to}`, { state: 'rejected' })).json()).toMatchObject({ state: 'rejected' });
    expect((await send('alex', 'PUT', `/api/links/${from}/${to}`, { state: 'confirmed' })).json()).toMatchObject({ state: 'confirmed', reason: 'the same author\'s sequel' });
    expect(db.select().from(t.bookLink).where(and(eq(t.bookLink.fromBook, from), eq(t.bookLink.toBook, to))).get()).toMatchObject({ state: 'confirmed', reviewedBy: id.alex });
  });

  it.each([
    ['PUT', '/api/links/x/y', { state: 'confirmed' }, 404],
    ['PUT', 'LINK', { state: 'maybe' }, 400],
    ['PUT', 'LINK', {}, 400],
    ['PUT', 'LINK', { state: 'confirmed', extra: 1 }, 400],
    ['PUT', 'IDEA', { layer: 'top' }, 400],
    ['PUT', '/api/books/x/ideas/y', { state: 'confirmed' }, 404],
  ] as const)('%s %s %j → %i', async (method, url, body, status) => {
    const real = url === 'LINK' ? `/api/links/${bookId('Value Beyond Price')}/${bookId('The Long Tide of Markets')}`
      : url === 'IDEA' ? `/api/books/${bookId('Value Beyond Price')}/ideas/${ideaId('Markets and value')}` : url;
    expect((await send('alex', method, real, body)).statusCode).toBe(status);
  });

  it('a proposal from someone\'s takeaways is theirs: others never see its reason, nor find it (404)', async () => {
    const now = new Date().toISOString();
    db.insert(t.aiRun).values({ id: 'run_sam', job: 'link', provider: 'ollama', model: 'm', promptVersion: 'v1', inputHash: 'h', startedAt: now, takeawaysOf: id.partner }).run();
    const [from, to] = [bookId('Before the First Cities'), bookId('The Long Tide of Markets')];
    db.insert(t.bookLink).values({ fromBook: from, toBook: to, reason: 'what Sam wrote about trade', confidence: 0.9, state: 'proposed', aiRunId: 'run_sam', privateTo: id.partner }).run();

    const samSees = (await get('partner', '/api/proposals')).json().links.find((l: { from: { id: string }; to: { id: string } }) => l.from.id === from && l.to.id === to);
    expect(samSees).toMatchObject({ reason: 'what Sam wrote about trade', fromAi: true, onlyYou: true });
    expect((await get('alex', '/api/proposals')).body).not.toContain('what Sam wrote');
    const backlog = (await get('alex', '/api/backlog?q=%22before%20the%20first%20cities%22')).json();
    expect(JSON.stringify(backlog)).not.toContain('what Sam wrote');
    expect(backlog.items[0].buildsOn).toContainEqual(expect.objectContaining({ reason: PRIVATE_REASON }));
    // for Alex it does not exist: the same answer as a link that is not there
    const r = await send('alex', 'PUT', `/api/links/${from}/${to}`, { state: 'confirmed' });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual((await send('alex', 'PUT', '/api/links/x/y', { state: 'confirmed' })).json());
  });

  it('the repro: Sam confirms, then turns the AI gate off; the reason never reaches Alex', async () => {
    const [from, to] = [bookId('Before the First Cities'), bookId('The Long Tide of Markets')];
    expect((await send('partner', 'PUT', `/api/links/${from}/${to}`, { state: 'confirmed' })).json()).toMatchObject({ reason: 'what Sam wrote about trade' });
    expect((await send('partner', 'PATCH', '/api/settings', { person: { takeawaysToAi: true } })).statusCode).toBe(200);
    expect((await send('partner', 'PATCH', '/api/settings', { person: { takeawaysToAi: false } })).statusCode).toBe(200);
    const row = db.select().from(t.bookLink).where(and(eq(t.bookLink.fromBook, from), eq(t.bookLink.toBook, to))).get()!;
    expect(row).toMatchObject({ state: 'confirmed', aiRunId: null, privateTo: id.partner, reason: PRIVATE_REASON });
    const backlog = await get('alex', '/api/backlog?q=%22before%20the%20first%20cities%22');
    expect(backlog.body).not.toContain('what Sam wrote');
    expect((await send('alex', 'PUT', `/api/links/${from}/${to}`, { state: 'rejected' })).statusCode).toBe(404);
  });
});

describe('ideas: rename and merge', () => {
  it('renames; a name taken by another idea is 409', async () => {
    const i = ideaId('Care and the commons');
    expect((await send('partner', 'PATCH', `/api/ideas/${i}`, { name: '  Care   and commons ' })).json()).toEqual({ id: i, name: 'Care and commons' });
    expect((await send('partner', 'PATCH', `/api/ideas/${i}`, { name: 'Markets and value' })).statusCode).toBe(409);
    for (const body of [{}, { name: '' }, { name: 'x', mergeInto: 'y' }, { colour: 'red' }]) expect((await send('partner', 'PATCH', `/api/ideas/${i}`, body)).statusCode).toBe(400);
  });

  it('merges: the rows stay as they were, read under the idea they went into; logged; an admin undoes it', async () => {
    const from = ideaId('Care and commons');
    const into = ideaId('Markets and value');
    const rowsBefore = db.select().from(t.bookIdea).where(eq(t.bookIdea.ideaId, from)).all();
    expect(rowsBefore.length).toBeGreaterThan(0);
    const r = await send('partner', 'PATCH', `/api/ideas/${from}`, { mergeInto: into });
    expect(r.json()).toEqual({ id: into, name: 'Markets and value' });
    expect(db.select().from(t.bookIdea).where(eq(t.bookIdea.ideaId, from)).all()).toEqual(rowsBefore); // nothing decided
    const lib = (await get('alex', `/api/people/${id.alex}/library`)).json();
    const gardens = lib.books.find((b: { book: { title: string } }) => b.book.title === 'Gardens of the Commons');
    expect(gardens.ideas).toEqual(['Markets and value']);
    expect((await get('alex', `/api/people/${id.alex}/brain`)).json().ideas.map((i: { name: string }) => i.name)).not.toContain('Care and commons');
    expect((await send('alex', 'PATCH', `/api/ideas/${from}`, { name: 'Back' })).statusCode).toBe(404);
    expect((await send('alex', 'PATCH', `/api/ideas/${into}`, { mergeInto: into })).statusCode).toBe(400);
    expect((await send('alex', 'PATCH', `/api/ideas/${into}`, { mergeInto: 'nope' })).statusCode).toBe(404);

    const log = (await get('alex', '/api/ideas/merges')).json();
    expect(log[0]).toMatchObject({ idea: { id: from, name: 'Care and commons' }, into: { id: into }, mergedBy: 'Sam', undone: false });
    const undo = (who: string) => built.app.inject({ method: 'POST', url: `/api/ideas/merges/${log[0].id}/undo`, headers: { cookie: cookie[who]!, origin: ORIGIN } });
    expect((await undo('partner')).statusCode).toBe(403); // admins undo
    expect((await undo('alex')).json()).toEqual({ id: from, name: 'Care and commons' });
    expect((await undo('alex')).statusCode).toBe(409);
    expect((await get('alex', `/api/people/${id.alex}/library`)).json().books.find((b: { book: { title: string } }) => b.book.title === 'Gardens of the Commons').ideas).toEqual(['Care and commons']);
  });

  it('a merge re-points the ideas already merged into it (and the undo points them back)', async () => {
    const [x, y, z] = ['Idea X', 'Idea Y', 'Idea Z'].map((name) => { const i = `i_${name.slice(-1)}`; db.insert(t.idea).values({ id: i, name }).run(); return i; });
    const book = bookId('A Short History of Bread');
    db.insert(t.bookIdea).values({ bookId: book, ideaId: x!, layer: 'deep', confidence: 1, state: 'confirmed' }).run();
    await send('alex', 'PATCH', `/api/ideas/${x}`, { mergeInto: y });
    await send('alex', 'PATCH', `/api/ideas/${y}`, { mergeInto: z });
    expect(db.select().from(t.idea).where(eq(t.idea.id, x!)).get()!.mergedInto).toBe(z);
    const ideas = () => (get('alex', `/api/people/${id.alex}/library`)).then((r) => r.json().books.find((b: { book: { id: string } }) => b.book.id === book).ideas);
    expect(await ideas()).toContain('Idea Z');
    const last = (await get('alex', '/api/ideas/merges')).json()[0];
    await built.app.inject({ method: 'POST', url: `/api/ideas/merges/${last.id}/undo`, headers: { cookie: cookie.alex!, origin: ORIGIN } });
    expect(db.select().from(t.idea).where(eq(t.idea.id, x!)).get()!.mergedInto).toBe(y);
    expect(await ideas()).toContain('Idea Y');
  });

  it('when a book has rows on both merged ideas, the stronger decision is the book\'s (confirmed > proposed > rejected)', async () => {
    const [a, b, c] = ['Rank A', 'Rank B', 'Rank C'].map((name, n) => { const i = `i_rank${n}`; db.insert(t.idea).values({ id: i, name }).run(); return i; });
    const book = bookId('Notes on Unpaid Work');
    db.insert(t.bookIdea).values([
      { bookId: book, ideaId: a!, layer: 'core', confidence: 0.5, state: 'confirmed' },
      { bookId: book, ideaId: b!, layer: 'deep', confidence: 1, state: 'rejected' },
    ]).run();
    await send('alex', 'PATCH', `/api/ideas/${b}`, { mergeInto: a });
    const names = async () => (await get('alex', `/api/people/${id.alex}/library`)).json().books.find((x: { book: { id: string } }) => x.book.id === book).ideas;
    expect(await names()).toContain('Rank A'); // confirmed beats rejected, whatever the confidence
    // and the other way round: a rejected row merged onto it never undoes a confirmed one
    db.insert(t.bookIdea).values({ bookId: book, ideaId: c!, layer: 'core', confidence: 1, state: 'rejected' }).run();
    await send('alex', 'PATCH', `/api/ideas/${a}`, { mergeInto: c });
    expect(await names()).toContain('Rank C');
  });

  it('a merge never decides a private proposal: it stays its owner\'s, waiting', async () => {
    const [p1, p2] = ['Private A', 'Private B'].map((name, n) => { const i = `i_priv${n}`; db.insert(t.idea).values({ id: i, name }).run(); return i; });
    const book = bookId('Gardens of the Commons');
    db.insert(t.bookIdea).values([
      { bookId: book, ideaId: p1!, layer: 'core', confidence: 0.6, state: 'proposed', privateTo: id.partner },
      { bookId: book, ideaId: p2!, layer: 'core', confidence: 1, state: 'confirmed', reviewedBy: id.alex },
    ]).run();
    await send('alex', 'PATCH', `/api/ideas/${p1}`, { mergeInto: p2 });
    expect(db.select().from(t.bookIdea).where(and(eq(t.bookIdea.bookId, book), eq(t.bookIdea.ideaId, p1!))).get()).toMatchObject({ state: 'proposed', privateTo: id.partner, reviewedBy: null });
    const sam = (await get('partner', '/api/proposals')).json().ideas;
    expect(sam).toContainEqual(expect.objectContaining({ idea: { id: p1, name: 'Private B' }, book: expect.objectContaining({ id: book }) }));
    expect((await get('alex', '/api/proposals')).json().ideas.some((x: { idea: { id: string } }) => x.idea.id === p1)).toBe(false);
  });

  it('a kid\'s session is refused (403)', async () => {
    expect((await send('kid1', 'PATCH', `/api/ideas/${ideaId('Markets and value')}`, { name: 'X' })).statusCode).toBe(403);
    expect((await get('kid1', '/api/proposals')).statusCode).toBe(403);
  });
});

describe('writing from an AI run (shelf#3)', () => {
  const run = (rid: string, of: string | null) => db.insert(t.aiRun).values({ id: rid, job: 'link', provider: 'ollama', model: 'm', promptVersion: 'v1', inputHash: rid, startedAt: new Date().toISOString(), takeawaysOf: of }).run();

  it('private_to comes from the run: whose takeaways it read, or nobody\'s; an unknown run is refused', () => {
    run('run_w_sam', id.partner!);
    run('run_w_plain', null);
    expect(privateToFor(db, 'run_w_sam')).toBe(id.partner);
    expect(privateToFor(db, 'run_w_plain')).toBeNull();
    expect(() => privateToFor(db, 'nope')).toThrow(/unknown AI run/);
    const [a, b, c] = ['Gardens of the Commons', 'A Short History of Bread', 'The Grand Ledger'].map(bookId);
    expect(proposeLinks(db, 'run_w_sam', [{ fromBook: a!, toBook: b!, reason: 'from Sam\'s notes', confidence: 0.9 }])).toBe(1);
    expect(proposeLinks(db, 'run_w_plain', [{ fromBook: a!, toBook: c!, reason: 'from the catalogue', confidence: 0.9 }])).toBe(1);
    const row = (to: string) => db.select().from(t.bookLink).where(and(eq(t.bookLink.fromBook, a!), eq(t.bookLink.toBook, to))).get();
    expect(row(b!)).toMatchObject({ state: 'proposed', aiRunId: 'run_w_sam', privateTo: id.partner });
    expect(row(c!)).toMatchObject({ state: 'proposed', aiRunId: 'run_w_plain', privateTo: null });
    // an existing row is never overwritten (a decision stays a decision)
    expect(proposeLinks(db, 'run_w_plain', [{ fromBook: a!, toBook: b!, reason: 'again', confidence: 1 }])).toBe(0);
    expect(row(b!)).toMatchObject({ privateTo: id.partner, reason: 'from Sam\'s notes' });
  });

  it('a private book idea: others get 404 reviewing it, the same as one that is not there; its person decides', async () => {
    db.insert(t.idea).values({ id: 'i_w_priv', name: 'Written from notes' }).run();
    const book = bookId('Gardens of the Commons');
    expect(proposeBookIdeas(db, 'run_w_sam', [{ bookId: book, ideaId: 'i_w_priv', layer: 'deep', confidence: 0.9 }])).toBe(1);
    for (const body of [{ state: 'confirmed' }, { state: 'rejected' }, { layer: 'core' }]) {
      const r = await send('alex', 'PUT', `/api/books/${book}/ideas/i_w_priv`, body);
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual((await send('alex', 'PUT', `/api/books/${book}/ideas/i_none`, body)).json());
    }
    expect(db.select().from(t.bookIdea).where(and(eq(t.bookIdea.bookId, book), eq(t.bookIdea.ideaId, 'i_w_priv'))).get()).toMatchObject({ state: 'proposed', layer: 'deep', reviewedBy: null });
    expect((await send('partner', 'PUT', `/api/books/${book}/ideas/i_w_priv`, { state: 'rejected' })).statusCode).toBe(200);
  });

  it('the purge deletes undecided links private to the person, even when no run of theirs is left', () => {
    const [a, b, c] = ['A Short History of Bread', 'Gardens of the Commons', 'The Grand Ledger'].map(bookId);
    db.insert(t.bookLink).values([
      { fromBook: a!, toBook: b!, reason: 'undecided, private', confidence: 0.9, state: 'proposed', privateTo: id.partner },
      { fromBook: a!, toBook: c!, reason: 'decided, private', confidence: 0.9, state: 'confirmed', privateTo: id.partner, reviewedBy: id.partner },
    ]).run();
    purgeTakeawayRuns(db, id.partner!);
    const row = (to: string) => db.select().from(t.bookLink).where(and(eq(t.bookLink.fromBook, a!), eq(t.bookLink.toBook, to))).get();
    expect(row(b!)).toBeUndefined();
    expect(row(c!)).toMatchObject({ state: 'confirmed', privateTo: id.partner, reason: PRIVATE_REASON });
    // and the link proposed by the purged run went with it; the plain run's stays
    expect(db.select().from(t.bookLink).where(eq(t.bookLink.reason, 'from Sam\'s notes')).all()).toEqual([]);
    expect(db.select().from(t.bookLink).where(eq(t.bookLink.aiRunId, 'run_w_plain')).all()).toHaveLength(1);
  });

  it('nothing else in src/ inserts a link or a book idea (the seed writes decided rows, without a run)', () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url));
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.ts$/.test(f) ? [join(dir, f)] : []);
    const re = /insert\(\s*(t\.)?book(Link|Idea)\b|insert\s+into\s+book_(link|idea)\b/i;
    const hits = files(root).map((f) => relative(root, f)).filter((f) => re.test(readFileSync(join(root, f), 'utf8')));
    expect(hits.sort()).toEqual(['knowledge/from-run.ts', 'seed/import.ts']);
    expect(readFileSync(join(root, 'seed/import.ts'), 'utf8')).not.toMatch(/aiRunId|privateTo/);
  });
});
