// Undoing an invoice typed in or imported (philobiblos#45 item 3): its copies removed, the order lines it delivered put
// back and the order's totals adjusted, only while nothing has changed them since. Every book and amount here is
// invented. Each rule has a test that fails when the rule is changed.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import * as t from '../src/db/schema';
import { markOwned } from '../src/month/plan';
import { EntryError, UNDO_DAYS, recentEntries, recordEntry, undoEntry } from '../src/orders/entries';
import { ORIGIN, TEST_SEALING_KEY, household, sessionCookie } from './helpers';

const NOW = new Date('2026-11-16T10:00:00.000Z');
const LATER = new Date(NOW.getTime() + 3600_000);
const DAY = 86_400_000;
function world() {
  const db = household();
  const iso = NOW.toISOString();
  db.update(t.book).set({ isbn13: '9780000000002' }).where(eq(t.book.id, 'b_tide')).run();
  db.insert(t.book).values([
    { id: 'b_hedgehog', title: 'The Quiet Hedgehog', authorsJson: '["Lena Paulsen"]', isbn13: '9780000000019', audience: 'kids', normKey: 'x', createdAt: iso },
    { id: 'b_value', title: 'Value Beyond Price', authorsJson: '["Mira Okafor"]', audience: 'adult', normKey: 'x', createdAt: iso },
  ]).run();
  db.insert(t.order).values({ id: 'o_nov', month: '2026-11', status: 'quoted', estimateC: 7500, quotedC: 6000, createdAt: iso }).run();
  db.insert(t.orderLine).values([
    { orderId: 'o_nov', bookId: 'b_tide', forPerson: 'p_alex', estimateC: 2500, quotedC: 2000, state: 'quoted' },
    { orderId: 'o_nov', bookId: 'b_hedgehog', forPerson: 'p_kid1', estimateC: 2500 },
    { orderId: 'o_nov', bookId: 'b_value', forPerson: 'p_alex', estimateC: 2500 },
  ]).run();
  return db;
}
type W = ReturnType<typeof world>;
/** Every row an invoice may change (the entry itself left out). */
const state = (db: W) => JSON.stringify(['book', 'copy', 'order', 'orderLine', 'bookOffer', 'reading'].map((k) => db.select().from((t as unknown as Record<string, typeof t.book>)[k]!).all()));
const order = (db: W) => db.select().from(t.order).where(eq(t.order.id, 'o_nov')).get()!;
const line = (db: W, bookId: string) => db.select().from(t.orderLine).where(eq(t.orderLine.bookId, bookId)).get()!;
const invoice = (db: W, lines: unknown[], o: { me?: string; at?: Date; number?: string; date?: string } = {}) =>
  recordEntry(db, o.me ?? 'p_sam', { kind: 'invoice', date: o.date ?? '2026-11-12', ...(o.number ? { number: o.number } : {}), lines }, o.at ?? NOW);
const refused = (f: () => unknown, status: number, msg?: RegExp) => {
  let e: unknown;
  try { f(); } catch (x) { e = x; }
  expect(e, 'refused').toBeInstanceOf(EntryError);
  expect((e as EntryError).status).toBe(status);
  if (msg) expect((e as EntryError).message).toMatch(msg);
};

describe('undo: everything the invoice did, and only that', () => {
  it('its copies go, the order lines it delivered are as they were, the order\'s totals and status too; the price learnt before is back', () => {
    const db = world();
    db.insert(t.bookOffer).values({ bookId: 'b_tide', source: 'invoice', priceC: 1500, seenAt: '2026-10-01T00:00:00.000Z' }).run();
    const before = state(db);
    const e = invoice(db, [{ isbn: '9780000000002', qty: 1, price: 1990 }, { isbn: '9780000000019', qty: 2, price: 1690 }], { number: 'R-7' });
    expect(order(db)).toMatchObject({ status: 'invoiced', invoicedC: 1990 + 3380 });
    undoEntry(db, 'p_sam', e.id!, LATER);
    expect(state(db)).toBe(before);
    expect(line(db, 'b_tide')).toMatchObject({ state: 'quoted', quotedC: 2000 });
    expect(order(db)).toMatchObject({ status: 'quoted', invoicedC: null });
    // The entry is gone: its number may be typed again, correctly this time.
    expect(db.select().from(t.orderEntry).all()).toEqual([]);
    invoice(db, [{ isbn: '9780000000002', qty: 1, price: 1890 }], { number: 'R-7' });
  });

  it('a book it added stays (it may be known elsewhere by now), off the pile it put it on; a price it learnt with none before goes', () => {
    const db = world();
    const e = invoice(db, [{ title: 'Small Bear Sleeps', qty: 1, price: 1200, for: 'kid1' }]);
    const bear = db.select().from(t.book).where(eq(t.book.title, 'Small Bear Sleeps')).get()!;
    undoEntry(db, 'p_sam', e.id!, LATER);
    expect(db.select().from(t.book).where(eq(t.book.id, bear.id)).get()).toBeDefined();
    expect(db.select().from(t.copy).all()).toEqual([]);
    expect(db.select().from(t.reading).where(eq(t.reading.bookId, bear.id)).all()).toEqual([]);
    expect(db.select().from(t.bookOffer).where(eq(t.bookOffer.bookId, bear.id)).all()).toEqual([]);
  });

  it('a pile changed since (the kid started it), or one the book was on already, stays as it is', () => {
    const db = world();
    db.insert(t.reading).values({ personId: 'p_kid1', bookId: 'b_hedgehog', status: 'to_read', updatedAt: '2026-11-01T00:00:00.000Z' }).run();
    const e = invoice(db, [{ isbn: '9780000000019', qty: 1, price: 1200, for: 'kid1' }, { title: 'Small Bear Sleeps', qty: 1, price: 1200, for: 'kid1' }]);
    const bear = db.select().from(t.book).where(eq(t.book.title, 'Small Bear Sleeps')).get()!;
    db.update(t.reading).set({ status: 'reading', updatedAt: LATER.toISOString() }).where(eq(t.reading.bookId, bear.id)).run();
    undoEntry(db, 'p_sam', e.id!, LATER);
    expect(db.select().from(t.reading).all().map((r) => [r.bookId === bear.id ? 'bear' : r.bookId, r.status]).sort()).toEqual([['b_hedgehog', 'to_read'], ['bear', 'reading']]);
  });

  it('a price learnt since by another invoice stays', () => {
    const db = world();
    const e = invoice(db, [{ isbn: '9780000000002', qty: 1, price: 1990 }]);
    invoice(db, [{ isbn: '9780000000002', qty: 1, price: 2100 }], { at: LATER });
    undoEntry(db, 'p_sam', e.id!, LATER);
    expect(db.select().from(t.bookOffer).where(eq(t.bookOffer.bookId, 'b_tide')).all()).toMatchObject([{ priceC: 2100 }]);
  });

  it('a tap\'s copy the invoice took is the tap\'s again, and its line marked owned by the tap again', () => {
    const db = world();
    markOwned(db, 'o_nov', 'b_tide', { owned: true }, NOW);
    const before = state(db);
    const e = invoice(db, [{ isbn: '9780000000002', qty: 2, price: 1990 }]);
    expect(db.select().from(t.copy).all()).toHaveLength(2);
    undoEntry(db, 'p_sam', e.id!, LATER);
    expect(state(db)).toBe(before);
    expect(line(db, 'b_tide')).toMatchObject({ state: 'delivered', tappedFrom: 'quoted' });
    expect(line(db, 'b_tide').copyId).not.toBeNull();
  });

  it('another invoice of the same order since: the order\'s invoiced total less this one\'s, still invoiced; the last one undone, as it was', () => {
    const db = world();
    const a = invoice(db, [{ isbn: '9780000000002', qty: 1, price: 1990 }]);
    const b = invoice(db, [{ isbn: '9780000000019', qty: 1, price: 1690 }], { at: LATER });
    undoEntry(db, 'p_sam', a.id!, LATER);
    expect(order(db)).toMatchObject({ status: 'invoiced', invoicedC: 1690 });
    expect(line(db, 'b_tide').state).toBe('quoted');
    expect(line(db, 'b_hedgehog').state).toBe('delivered');
    undoEntry(db, 'p_sam', b.id!, LATER);
    expect(order(db)).toMatchObject({ status: 'quoted', invoicedC: null });
    expect(line(db, 'b_hedgehog').state).toBe('planned');
  });
});

describe('the order an earlier invoice delivered to stays invoiced', () => {
  it('a free invoice (0) delivered a line before: with nothing left of this one\'s total, the order is still invoiced', () => {
    const db = world();
    invoice(db, [{ isbn: '9780000000019', qty: 1, price: 0 }]);
    expect(order(db)).toMatchObject({ status: 'invoiced', invoicedC: 0 });
    const e = invoice(db, [{ isbn: '9780000000002', qty: 1, price: 1990 }], { at: LATER });
    undoEntry(db, 'p_sam', e.id!, LATER);
    expect(order(db)).toMatchObject({ status: 'invoiced', invoicedC: 0 });
  });
});

describe('undo is refused, and changes nothing, once something it made has changed', () => {
  const cases: [string, (db: W) => void, RegExp][] = [
    ['a copy removed', (db) => { db.delete(t.copy).where(eq(t.copy.bookId, 'b_hedgehog')).run(); }, /copies/],
    ['a copy changed', (db) => { db.update(t.copy).set({ priceC: 1 }).where(eq(t.copy.bookId, 'b_tide')).run(); }, /copies/],
    ['its order line changed', (db) => { db.update(t.orderLine).set({ state: 'rolled_over' }).where(eq(t.orderLine.bookId, 'b_tide')).run(); }, /order/],
    ['its order closed', (db) => { db.update(t.order).set({ status: 'closed' }).run(); }, /order/],
    ['its order\'s invoiced total below its own', (db) => { db.update(t.order).set({ invoicedC: 100 }).run(); }, /order/],
  ];
  for (const [what, change, msg] of cases) {
    it(what, () => {
      const db = world();
      const e = invoice(db, [{ isbn: '9780000000002', qty: 1, price: 1990 }, { isbn: '9780000000019', qty: 1, price: 1690 }]);
      change(db);
      const before = state(db);
      refused(() => undoEntry(db, 'p_sam', e.id!, LATER), 409, msg);
      expect(state(db)).toBe(before);
      expect(db.select().from(t.orderEntry).all()).toHaveLength(1);
    });
  }

  it('the tap\'s copy it took, changed since', () => {
    const db = world();
    markOwned(db, 'o_nov', 'b_tide', { owned: true }, NOW);
    const e = invoice(db, [{ isbn: '9780000000002', qty: 1, price: 1990 }]);
    db.update(t.copy).set({ priceC: 5 }).run();
    refused(() => undoEntry(db, 'p_sam', e.id!, LATER), 409, /copies/);
  });
});

describe('who may undo, what and until when', () => {
  it('whoever recorded it, or an admin; never another adult (403)', () => {
    const db = world();
    const e = invoice(db, [{ isbn: '9780000000002', qty: 1, price: 1990 }]);
    refused(() => undoEntry(db, 'p_del', e.id!, LATER), 403);
    undoEntry(db, 'p_alex', e.id!, LATER);
    const f = invoice(db, [{ isbn: '9780000000002', qty: 1, price: 1990 }]);
    undoEntry(db, 'p_sam', f.id!, LATER);
  });

  it(`for ${UNDO_DAYS} days after it was recorded; then 409`, () => {
    const db = world();
    const e = invoice(db, [{ isbn: '9780000000002', qty: 1, price: 1990 }]);
    refused(() => undoEntry(db, 'p_sam', e.id!, new Date(NOW.getTime() + UNDO_DAYS * DAY + 1)), 409, /days/);
    undoEntry(db, 'p_sam', e.id!, new Date(NOW.getTime() + UNDO_DAYS * DAY));
  });

  it('only an invoice (a quote is corrected by typing it again); one recorded before undo existed is 409; an unknown one 404', () => {
    const db = world();
    const q = recordEntry(db, 'p_sam', { kind: 'quote', month: '2026-11', lines: [{ isbn: '9780000000002', price: 1900 }] }, NOW);
    refused(() => undoEntry(db, 'p_sam', q.id!, LATER), 409, /quote/);
    const e = invoice(db, [{ isbn: '9780000000002', qty: 1, price: 1990 }]);
    db.update(t.orderEntry).set({ undoJson: null }).where(eq(t.orderEntry.id, e.id!)).run();
    refused(() => undoEntry(db, 'p_sam', e.id!, LATER), 409, /before/);
    refused(() => undoEntry(db, 'p_sam', 'nope', LATER), 404);
  });

  it('the recent invoices, newest first, each saying whether you may undo it', () => {
    const db = world();
    const old = invoice(db, [{ isbn: '9780000000002', qty: 1, price: 1990 }], { at: new Date(NOW.getTime() - (UNDO_DAYS + 1) * DAY), date: '2026-11-01' });
    const a = invoice(db, [{ isbn: '9780000000002', qty: 1, price: 1990 }], { me: 'p_alex', number: 'A-1' });
    const s = invoice(db, [{ isbn: '9780000000019', qty: 2, price: 1690 }], { at: LATER });
    expect(recentEntries(db, 'p_sam', LATER)).toMatchObject([
      { id: s.id, number: null, total: 3380, copies: 2, by: { id: 'p_sam' }, canUndo: true },
      { id: a.id, number: 'A-1', total: 1990, copies: 1, by: { id: 'p_alex' }, canUndo: false },
    ]);
    expect(recentEntries(db, 'p_alex', LATER).map((x) => x.canUndo)).toEqual([true, true]);
    expect(recentEntries(db, 'p_sam', LATER).map((x) => x.id)).not.toContain(old.id);
  });
});

describe('POST /orders/entries/{id}/undo, GET /orders/entries', () => {
  let built: BuiltApp;
  let db: W;
  let id: string;
  beforeAll(async () => {
    db = world();
    id = invoice(db, [{ isbn: '9780000000002', qty: 1, price: 1990 }], { at: new Date() }).id!;
    built = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY }), db);
    await built.app.ready();
  });
  afterAll(() => built.app.close());
  const undo = (who: string, origin = ORIGIN, at = id) => built.app.inject({ method: 'POST', url: `/api/orders/entries/${at}/undo`, headers: { cookie: sessionCookie(db, who), origin } });

  it('a kid has no access; another origin is refused; another adult is 403; nothing changes', async () => {
    expect((await undo('p_kid1')).statusCode).toBe(403);
    expect((await undo('p_sam', 'https://evil.example')).statusCode).toBe(403);
    expect((await undo('p_del')).statusCode).toBe(403);
    expect(db.select().from(t.copy).all()).toHaveLength(1);
    expect((await built.app.inject({ url: '/api/orders/entries', headers: { cookie: sessionCookie(db, 'p_kid1') } })).statusCode).toBe(403);
  });

  it('the recent list, then the one who recorded it undoes it (204); again is 404', async () => {
    const list = await built.app.inject({ url: '/api/orders/entries', headers: { cookie: sessionCookie(db, 'p_sam') } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ entries: [{ id, canUndo: true }] });
    expect((await undo('p_sam')).statusCode).toBe(204);
    expect(db.select().from(t.copy).all()).toEqual([]);
    expect((await undo('p_sam')).statusCode).toBe(404);
  });
});
