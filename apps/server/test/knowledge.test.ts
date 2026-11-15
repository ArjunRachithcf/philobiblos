// Ideas, layers, links and the Brain (ADR 0005) on the sample seed (seed-sample/, all invented): proposals stay
// proposals until a person decides, the reviewer is recorded, merges and renames, the brain's shape, and the privacy
// of proposals written from someone's takeaways (shelf#3). Authorization per route.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb, type Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { PRIVATE_REASON } from '../src/knowledge/knowledge';
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

  it('a proposal from someone\'s takeaways is theirs: others never see its reason, nor decide it', async () => {
    const now = new Date().toISOString();
    db.insert(t.aiRun).values({ id: 'run_sam', job: 'link', provider: 'ollama', model: 'm', promptVersion: 'v1', inputHash: 'h', startedAt: now, takeawaysOf: id.partner }).run();
    const [from, to] = [bookId('Before the First Cities'), bookId('The Long Tide of Markets')];
    db.insert(t.bookLink).values({ fromBook: from, toBook: to, reason: 'what Sam wrote about trade', confidence: 0.9, state: 'proposed', aiRunId: 'run_sam' }).run();

    const samSees = (await get('partner', '/api/proposals')).json().links.find((l: { from: { id: string }; to: { id: string } }) => l.from.id === from && l.to.id === to);
    expect(samSees).toMatchObject({ reason: 'what Sam wrote about trade', fromAi: true });
    expect((await get('alex', '/api/proposals')).body).not.toContain('what Sam wrote');
    // the backlog shows Alex a neutral reason for the same link (it counts: confidence 0.9)
    const backlog = (await get('alex', '/api/backlog?q=%22before%20the%20first%20cities%22')).json();
    expect(JSON.stringify(backlog)).not.toContain('what Sam wrote');
    expect(backlog.items[0].buildsOn).toContainEqual(expect.objectContaining({ reason: PRIVATE_REASON }));
    expect((await send('alex', 'PUT', `/api/links/${from}/${to}`, { state: 'confirmed' })).statusCode).toBe(403);
    expect((await send('partner', 'PUT', `/api/links/${from}/${to}`, { state: 'confirmed' })).json()).toMatchObject({ reason: 'what Sam wrote about trade' });
  });
});

describe('ideas: rename and merge', () => {
  it('renames; a name taken by another idea is 409', async () => {
    const i = ideaId('Care and the commons');
    expect((await send('partner', 'PATCH', `/api/ideas/${i}`, { name: '  Care   and commons ' })).json()).toEqual({ id: i, name: 'Care and commons' });
    expect((await send('partner', 'PATCH', `/api/ideas/${i}`, { name: 'Markets and value' })).statusCode).toBe(409);
    for (const body of [{}, { name: '' }, { name: 'x', mergeInto: 'y' }, { colour: 'red' }]) expect((await send('partner', 'PATCH', `/api/ideas/${i}`, body)).statusCode).toBe(400);
  });

  it('merges: books move to the other idea, the stronger decision wins, the merged idea is gone', async () => {
    const from = ideaId('Care and commons');
    const into = ideaId('Markets and value');
    const before = db.select().from(t.bookIdea).where(eq(t.bookIdea.ideaId, from)).all().map((r) => r.bookId);
    expect(before.length).toBeGreaterThan(0);
    const r = await send('alex', 'PATCH', `/api/ideas/${from}`, { mergeInto: into });
    expect(r.json()).toEqual({ id: into, name: 'Markets and value' });
    expect(db.select().from(t.bookIdea).where(eq(t.bookIdea.ideaId, from)).all()).toEqual([]);
    const after = db.select().from(t.bookIdea).where(eq(t.bookIdea.ideaId, into)).all().map((x) => x.bookId);
    for (const b of before) expect(after).toContain(b);
    expect((await get('alex', `/api/people/${id.alex}/brain`)).json().ideas.map((i: { name: string }) => i.name)).not.toContain('Care and commons');
    expect((await send('alex', 'PATCH', `/api/ideas/${from}`, { name: 'Back' })).statusCode).toBe(404);
    expect((await send('alex', 'PATCH', `/api/ideas/${into}`, { mergeInto: into })).statusCode).toBe(400);
    expect((await send('alex', 'PATCH', `/api/ideas/${into}`, { mergeInto: 'nope' })).statusCode).toBe(404);
  });

  it('a kid\'s session is refused (403)', async () => {
    expect((await send('kid1', 'PATCH', `/api/ideas/${ideaId('Markets and value')}`, { name: 'X' })).statusCode).toBe(403);
    expect((await get('kid1', '/api/proposals')).statusCode).toBe(403);
  });
});
