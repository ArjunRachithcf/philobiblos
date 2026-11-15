// This month (spec §4, §5) and the order mail (ADR 0007) on the sample seed (seed-sample/, all invented): the picks
// follow packages/scoring within the budget; who may change what; the one-month budget (admins); Compose builds a
// mailto: that never holds a card number and refuses anything that could add headers; the addresses are sealed.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb, type Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { SealError, seal, unseal } from '../src/household/sealed';
import { EMAIL, MAILTO_MAX, mailto, orderText } from '../src/month/order-mail';
import { broadenMonth, currentMonth } from '../src/month/plan';
import { importSeed } from '../src/seed/import';
import { ORIGIN, TEST_SEALING_KEY, sessionCookie } from './helpers';

const SAMPLE = fileURLToPath(new URL('../../../seed-sample', import.meta.url));
const MONTH = '2026-12';
let db: Db;
let built: BuiltApp;
const id: Record<string, string> = {};
const cookie: Record<string, string> = {};

beforeAll(async () => {
  db = openDb(':memory:');
  importSeed(db, SAMPLE, '2026-11-01T00:00:00.000Z');
  for (const p of db.select().from(t.person).all()) id[p.handle!] = p.id;
  for (const h of ['alex', 'partner']) cookie[h] = sessionCookie(db, id[h]!);
  built = await buildApp(loadConfig({ SHELF_MODE: 'standalone', SHELF_DATA_DIR: '/nonexistent', SHELF_SEALING_KEY: TEST_SEALING_KEY }), db);
  await built.app.ready();
});
afterAll(() => built.app.close());

const get = (who: string, url: string) => built.app.inject({ url, headers: { cookie: cookie[who]! } });
const send = (who: string, method: 'PUT' | 'POST' | 'PATCH', url: string, payload: unknown) =>
  built.app.inject({ method, url, payload: JSON.stringify(payload), headers: { cookie: cookie[who]!, origin: ORIGIN, 'content-type': 'application/json' } });
type Plan = { total: number; budget: { min: number; max: number }; budgetIsOverride: boolean; adults: { person: { id: string }; picks: Pick[] }[]; kids: { person: { id: string }; picks: Pick[] }[]; focus: { sentence: string; ideas: string[] }[]; order: { status: string } | null };
type Pick = { candidate: { book: { id: string; title: string; authors?: string[] }; theme?: string | null; price?: number }; move?: string; why: string; idea?: string };
const plan = async (who = 'alex'): Promise<Plan> => (await get(who, `/api/month/${MONTH}`)).json();
const kidPicks = (p: Plan) => p.kids.flatMap((k) => k.picks);

describe('the plan', () => {
  it('adults get their picks with a move, kids one theme and one author each, all within the budget', async () => {
    const p = await plan();
    const alex = p.adults.find((a) => a.person.id === id.alex)!;
    expect(alex.picks.length).toBeGreaterThan(0);
    expect(alex.picks.length).toBeLessThanOrEqual(2);
    for (const pk of alex.picks) expect(pk.move).toBeTruthy();
    const kids = kidPicks(p);
    expect(new Set(kids.map((k) => k.candidate.theme)).size).toBe(kids.length);
    expect(new Set(kids.map((k) => k.candidate.book.authors?.[0])).size).toBe(kids.length);
    expect(p.total).toBeLessThanOrEqual(p.budget.max);
    expect(p.order).toBeNull(); // nothing is kept until someone changes it
    expect(p.focus.every((f) => f.sentence.endsWith('.'))).toBe(true);
  });

  it('a look changes nothing; a bad month is 400', async () => {
    await plan();
    expect(db.select().from(t.order).all()).toEqual([]);
    expect((await get('alex', '/api/month/2026-13')).statusCode).toBe(400);
  });

  it('every third month a Deepen + Connect pick becomes Broaden', () => {
    expect(['2026-09', '2026-10', '2026-11', '2026-12'].map(broadenMonth)).toEqual([true, false, false, true]);
    expect(currentMonth('Europe/Zurich', new Date('2026-11-30T23:30:00Z'))).toBe('2026-12');
  });
});

describe('changing the picks', () => {
  it('you change your own and the kids\'; another adult\'s are theirs (403)', async () => {
    const p = await plan();
    const sams = p.adults.find((a) => a.person.id === id.partner)!.picks;
    const mine = p.adults.find((a) => a.person.id === id.alex)!.picks;
    if (sams[0]) expect((await send('alex', 'POST', `/api/month/${MONTH}/picks`, { remove: [{ bookId: sams[0].candidate.book.id, for: id.partner }] })).statusCode).toBe(403);
    const r = await send('alex', 'POST', `/api/month/${MONTH}/picks`, { remove: [{ bookId: mine[0]!.candidate.book.id, for: id.alex }] });
    expect(r.statusCode, r.body).toBe(200);
    const after: Plan = r.json();
    expect(after.adults.find((a) => a.person.id === id.alex)!.picks.map((x) => x.candidate.book.id)).not.toContain(mine[0]!.candidate.book.id);
    expect(after.order?.status).toBe('picked');
    // back again, by hand
    expect((await send('alex', 'POST', `/api/month/${MONTH}/picks`, { add: [{ bookId: mine[0]!.candidate.book.id, for: id.alex }] })).json().adults
      .find((a: { person: { id: string } }) => a.person.id === id.alex).picks.map((x: Pick) => x.candidate.book.id)).toContain(mine[0]!.candidate.book.id);
  });

  it.each([
    [400, {}], [400, { add: 'x' }], [400, { recompute: 'yes' }], [400, { swap: [] }],
    [404, { add: [{ bookId: 'nope', for: 'ALEX' }] }],
  ])('%i: %j', async (status, body) => {
    const b = JSON.parse(JSON.stringify(body).replace('ALEX', id.alex!));
    expect((await send('alex', 'POST', `/api/month/${MONTH}/picks`, b)).statusCode).toBe(status);
  });

  it('recompute starts again from the scoring', async () => {
    const r = await send('partner', 'POST', `/api/month/${MONTH}/picks`, { recompute: true });
    expect(r.statusCode).toBe(200);
    expect(r.json().total).toBeLessThanOrEqual(r.json().budget.max);
  });
});

describe('the month\'s budget', () => {
  it('admins set it for this month; the kids\' picks refill within it; null goes back', async () => {
    expect((await send('partner', 'PUT', `/api/month/${MONTH}/budget`, { min: 0, max: 5000 })).statusCode).toBe(403);
    const adultsBefore = (await plan()).adults.map((a) => a.picks.map((x) => x.candidate.book.id));
    const low: Plan = (await send('alex', 'PUT', `/api/month/${MONTH}/budget`, { min: 0, max: 1 })).json();
    expect(low.budgetIsOverride).toBe(true);
    expect(kidPicks(low)).toEqual([]); // nothing fits
    expect(low.adults.map((a) => a.picks.map((x) => x.candidate.book.id))).toEqual(adultsBefore); // adults' stay
    const back: Plan = (await send('alex', 'PUT', `/api/month/${MONTH}/budget`, null)).json();
    expect(back.budgetIsOverride).toBe(false);
    expect(kidPicks(back).length).toBeGreaterThan(0);
    for (const bad of [{ min: 5, max: 1 }, { min: -1, max: 1 }, { min: 1 }, { min: 0, max: 1, rollover: 1 }, 'x']) {
      expect((await send('alex', 'PUT', `/api/month/${MONTH}/budget`, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe('Compose (ADR 0007)', () => {
  it('needs the bookshop\'s address (admins set it, sealed); then a mailto with the order, no card number', async () => {
    expect((await send('alex', 'POST', '/api/orders', { month: MONTH })).statusCode).toBe(409);
    expect((await send('partner', 'PATCH', '/api/settings', { order: { bookshopEmail: 'orders@bookshop.example' } })).statusCode).toBe(403);
    for (const bad of ['orders@bookshop.example?cc=x@y.z', 'a@b.example\r\nBcc: x@y.z', 'a@b.example,c@d.example', 'no-at-sign']) {
      expect((await send('alex', 'PATCH', '/api/settings', { order: { bookshopEmail: bad } })).statusCode, bad).toBe(400);
    }
    expect((await send('alex', 'PATCH', '/api/settings', { order: { bookshopEmail: 'orders@bookshop.example', deliveryAddress: 'Alex Example\nExample Street 1\n8000 Zurich' } })).statusCode).toBe(200);
    const r = await send('partner', 'POST', '/api/orders', { month: MONTH });
    expect(r.statusCode, r.body).toBe(201);
    const o = r.json();
    expect(o.status).toBe('drafted');
    expect(o.composeUrl).toMatch(/^mailto:orders@bookshop\.example\?subject=Book%20order%2C%20December%202026&body=/);
    expect(o.composeText).toContain('Example Street 1');
    expect(o.composeText).toContain('prices and delivery times');
    expect(o.composeText).not.toMatch(/\b(?:\d[ -]?){13,19}\b/); // nothing shaped like a card number
    expect(o.composeText).not.toMatch(/card number|cvc|cvv/i);
    expect(o.lines.length).toBeGreaterThan(0);
    expect((await get('alex', `/api/orders/${o.id}`)).json()).toMatchObject({ id: o.id, status: 'drafted' });
    // a change after Compose: compose again
    expect((await send('alex', 'POST', `/api/month/${MONTH}/picks`, { recompute: true })).json().order.status).toBe('picked');
  });

  it('once the bookshop has it, the picks are fixed (409)', async () => {
    db.update(t.order).set({ status: 'quoted' }).where(eq(t.order.month, MONTH)).run();
    expect((await send('alex', 'POST', `/api/month/${MONTH}/picks`, { recompute: true })).statusCode).toBe(409);
    expect((await send('alex', 'PUT', `/api/month/${MONTH}/budget`, null)).statusCode).toBe(409);
    expect((await send('alex', 'POST', '/api/orders', { month: MONTH })).statusCode).toBe(409);
  });

  it('a backlog row goes to this month\'s picks (add_to_month)', async () => {
    const month = currentMonth('Europe/Zurich');
    const p: Plan = (await get('alex', `/api/month/${month}`)).json();
    // not this month's, nor one the bookshop already has (December's, above: never picked twice)
    const dec: Plan = await plan();
    const picked = new Set([...p.adults, ...dec.adults].flatMap((a) => a.picks).map((x) => x.candidate.book.id));
    const open = (await get('alex', '/api/backlog?q=is%3Aopen%20for%3Ame')).json().items.find((c: { book: { id: string } }) => !picked.has(c.book.id));
    const r = await send('alex', 'POST', '/api/backlog/bulk', { ids: [open.id], action: 'add_to_month' });
    expect(r.statusCode, r.body).toBe(200);
    expect((await get('alex', `/api/month/${month}`)).json().adults.find((a: { person: { id: string } }) => a.person.id === id.alex).picks.map((x: Pick) => x.candidate.book.id)).toContain(open.book.id);
  });
});

describe('the order mail (pure)', () => {
  it('only one plain address; nothing that adds headers or recipients', () => {
    expect(EMAIL.test('orders@bookshop.example')).toBe(true);
    for (const bad of ['a@b.example?bcc=c@d.example', 'a@b.example%0ABcc', 'a b@c.example', 'a@b', '<a@b.example>', 'a@b.example&body=x']) expect(EMAIL.test(bad), bad).toBe(false);
    expect(() => mailto('a@b.example?x', 's', 'b')).toThrow();
  });

  it('a long order keeps the link short and says so; the text holds it all', () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({ title: `A Rather Long Book Title Number ${i}`, authors: ['Some Author'], isbn13: '9780000000000' }));
    const { subject, body } = orderText({ month: '2026-12', lines, deliveryAddress: null, signedBy: 'Alex' });
    const m = mailto('orders@bookshop.example', subject, body);
    expect(m.complete).toBe(false);
    expect(m.url.length).toBeLessThanOrEqual(MAILTO_MAX);
    expect(body).toContain('40. A Rather Long Book Title Number 39');
    const short = mailto('orders@bookshop.example', subject, orderText({ month: '2026-12', lines: lines.slice(0, 2), deliveryAddress: null, signedBy: 'Alex' }).body);
    expect(short.complete).toBe(true);
    expect(decodeURIComponent(short.url)).toContain('\r\n');
  });
});

describe('sealed values', () => {
  it('a wrong key, or a value moved to another name, does not open', () => {
    const key = Buffer.from(TEST_SEALING_KEY, 'base64');
    seal(db, key, 'probe_a', 'hello');
    expect(unseal(db, key, 'probe_a')).toBe('hello');
    expect(() => unseal(db, Buffer.alloc(32, 1), 'probe_a')).toThrow(SealError);
    const row = db.select().from(t.sealedSecret).where(eq(t.sealedSecret.key, 'probe_a')).get()!;
    db.insert(t.sealedSecret).values({ ...row, key: 'probe_b' }).run();
    expect(() => unseal(db, key, 'probe_b')).toThrow();
    seal(db, key, 'probe_a', null);
    expect(unseal(db, key, 'probe_a')).toBeNull();
  });
});
