// An order or invoice typed in, or imported from a CSV (philobiblos#27 slice 4): the path that works with any shop, or
// none. Every book, number and amount here is invented. Each rule has a test that fails when the rule is changed.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import * as t from '../src/db/schema';
import { bookIsbn } from '../src/books/isbn';
import { CSV_LIMITS, CsvError, parseCsv } from '../src/orders/csv';
import { ENTRY_LIMITS, EntryError, recordEntry } from '../src/orders/entries';
import { refreshMail } from '../src/mail/job';
import type { MediaOutcome } from '../src/media/client';
import { ORIGIN, TEST_SEALING_KEY, household, sessionCookie } from './helpers';
import { CFG, fakeBox, message, resolver, signed } from './mailkit';

const NOW = new Date('2026-11-16T10:00:00.000Z');
/** helpers.ts's household with three books ordered in November 2026, the order composed (drafted). */
function world() {
  const db = household();
  const iso = NOW.toISOString();
  db.update(t.book).set({ isbn13: '9780000000002' }).where(eq(t.book.id, 'b_tide')).run();
  db.insert(t.book).values([
    { id: 'b_hedgehog', title: 'The Quiet Hedgehog', authorsJson: '["Lena Paulsen"]', isbn13: '9780000000019', audience: 'kids', normKey: 'x', createdAt: iso },
    { id: 'b_value', title: 'Value Beyond Price', authorsJson: '["Mira Okafor"]', audience: 'adult', normKey: 'x', createdAt: iso },
  ]).run();
  db.insert(t.order).values({ id: 'o_nov', month: '2026-11', status: 'drafted', estimateC: 7500, createdAt: iso }).run();
  db.insert(t.orderLine).values([
    { orderId: 'o_nov', bookId: 'b_tide', forPerson: 'p_alex', estimateC: 2500 },
    { orderId: 'o_nov', bookId: 'b_hedgehog', forPerson: 'p_kid1', estimateC: 2500 },
    { orderId: 'o_nov', bookId: 'b_value', forPerson: 'p_alex', estimateC: 2500 },
  ]).run();
  return db;
}
type W = ReturnType<typeof world>;
const order = (db: W) => db.select().from(t.order).where(eq(t.order.id, 'o_nov')).get()!;
const lines = (db: W) => Object.fromEntries(db.select().from(t.orderLine).where(eq(t.orderLine.orderId, 'o_nov')).all().map((l) => [l.bookId, l]));
const copies = (db: W) => db.select().from(t.copy).all().map((c) => [c.bookId, c.source, c.orderId, c.priceC, c.acquiredAt]).sort();
const record = (db: W, body: unknown, me = 'p_alex') => recordEntry(db, me, body, NOW);
const refused = (db: W, body: unknown, status: number, msg?: RegExp, me = 'p_alex') => {
  let e: unknown;
  try { record(db, body, me); } catch (x) { e = x; }
  expect(e, 'refused').toBeInstanceOf(EntryError);
  expect((e as EntryError).status).toBe(status);
  if (msg) expect((e as EntryError).message).toMatch(msg);
};
/** Every row of the tables an entry may change: a refused or dry run leaves them as they were. */
const snapshot = (db: W) => JSON.stringify(['book', 'copy', 'order', 'orderLine', 'bookOffer', 'reading', 'orderEntry'].map((k) => db.select().from((t as unknown as Record<string, typeof t.book>)[k]!).all()));

describe('ISBNs: the check digit holds, or it is no ISBN', () => {
  it('an ISBN-13 with its check digit, spaced or hyphenated; an ISBN-10 as its ISBN-13', () => {
    expect(bookIsbn('9780000000002')).toBe('9780000000002');
    expect(bookIsbn('978-0-00-000001-9')).toBe('9780000000019');
    expect(bookIsbn(' 979 1 0000 0000 8 ')).toBe('9791000000008');
    expect(bookIsbn('0-306-40615-2')).toBe('9780306406157');
    expect(bookIsbn('080442957X')).toBe('9780804429573');
  });
  it('a wrong check digit, another product\'s EAN, or anything else is null', () => {
    expect(bookIsbn('9780000000003')).toBeNull();
    expect(bookIsbn('9780000000012')).toBeNull();
    expect(bookIsbn('0306406153')).toBeNull();
    expect(bookIsbn('4006381333931')).toBeNull(); // a valid EAN-13, not a book's
    expect(bookIsbn('X804429570')).toBeNull();
    expect(bookIsbn('97800000000020')).toBeNull();
    expect(bookIsbn('978O000000002')).toBeNull();
    expect(bookIsbn('')).toBeNull();
  });
});

describe('CSV: RFC 4180, bounded and linear', () => {
  it('a header and rows; quoted fields with commas, quotes and the delimiter; CRLF; a BOM; a last line without its newline', () => {
    expect(parseCsv('\ufefftitle,author\r\n"Tide, The","Okafor ""M."""\r\nB,C')).toEqual([['title', 'author'], ['Tide, The', 'Okafor "M."'], ['B', 'C']]);
  });
  it('the delimiter is the header\'s: semicolons and tabs too; blank lines, and lines of empty cells, are skipped', () => {
    expect(parseCsv('title;price\n\nA;18,90\n;\n;;\n')).toEqual([['title', 'price'], ['A', '18,90']]);
    expect(parseCsv('title\tprice\nA\t18.90\n')).toEqual([['title', 'price'], ['A', '18.90']]);
  });
  it('refuses an unclosed quote, text after a closing quote, too many rows, columns, characters or a cell too long', () => {
    const bad = (s: string, m: RegExp) => expect(() => parseCsv(s)).toThrow(m);
    bad('title\n"open', /quote/);
    bad('title\n"a"b', /quote/);
    bad('title,author\na"b,c', /quote/);
    bad('title,author\na"b",c', /a quote inside a cell/);
    bad(`title\n${'a\n'.repeat(CSV_LIMITS.rows)}`, /rows/);
    bad(`${Array.from({ length: CSV_LIMITS.columns + 1 }, (_, i) => `c${i}`).join(',')}\n`, /columns/);
    bad(`title\n${'a'.repeat(CSV_LIMITS.cell + 1)}`, /cell/);
    bad('t'.repeat(CSV_LIMITS.chars + 1), /characters/);
    // Within every other limit (rows, columns, cells), but longer than the file may be.
    const wide = (c: string) => Array.from({ length: CSV_LIMITS.columns }, () => c.repeat(32)).join(',');
    bad([wide('h'), ...Array.from({ length: CSV_LIMITS.rows - 1 }, () => wide('v'))].join('\n'), /characters/);
    expect(() => parseCsv('a\n"x')).toThrow(CsvError);
  });
  it('linear on hostile text: the largest file allowed of quotes and delimiters reads in well under a second', () => {
    const t0 = performance.now();
    for (const s of ['"'.repeat(CSV_LIMITS.chars), ','.repeat(CSV_LIMITS.cell) , `a\n${'"",'.repeat(CSV_LIMITS.chars / 3 - 1)}`]) {
      try { parseCsv(s); } catch { /* refused is fine; only the time counts */ }
    }
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('an invoice typed in: copies, as a verified invoice would make them', () => {
  it('lines by ISBN, by title and author; each copy owned at its price; the composed order\'s lines delivered and invoiced; the prices learnt', () => {
    const db = world();
    const r = record(db, { kind: 'invoice', number: 'R-1001', date: '2026-11-12', lines: [
      { isbn: '978-0-00-000000-2', qty: 1, price: 1990 },
      { title: 'the quiet hedgehog', author: 'Paulsen', qty: 2, price: 1690 },
    ] });
    expect(r).toMatchObject({ kind: 'invoice', dryRun: false, number: 'R-1001', total: 1990 + 2 * 1690, lines: [{ row: 1, bookId: 'b_tide', new: false }, { row: 2, bookId: 'b_hedgehog', new: false, qty: 2 }] });
    expect(copies(db)).toEqual([
      ['b_hedgehog', 'manual', 'o_nov', 1690, '2026-11-12T00:00:00.000Z'], ['b_hedgehog', 'manual', 'o_nov', 1690, '2026-11-12T00:00:00.000Z'],
      ['b_tide', 'manual', 'o_nov', 1990, '2026-11-12T00:00:00.000Z'],
    ]);
    expect(lines(db)).toMatchObject({ b_tide: { state: 'delivered' }, b_hedgehog: { state: 'delivered' }, b_value: { state: 'planned' } });
    expect(order(db)).toMatchObject({ status: 'invoiced', invoicedC: 1990 + 3380 });
    expect(db.select().from(t.bookOffer).where(eq(t.bookOffer.bookId, 'b_hedgehog')).get()).toMatchObject({ source: 'invoice', priceC: 1690 });
    const kept = db.select().from(t.orderEntry).all();
    expect(kept).toMatchObject([{ id: r.id, kind: 'invoice', source: 'typed', number: 'R-1001', personId: 'p_alex', totalC: 5370 }]);
    // Only structured fields: book ids, quantities and amounts, never the text typed.
    expect(kept[0]!.linesJson).not.toMatch(/Quiet|Paulsen|9780000000002/i);
  });

  it('a book nobody has yet is added (for a kid: a kids\' book on their pile); no date is today', () => {
    const db = world();
    const r = record(db, { kind: 'invoice', lines: [
      { title: 'A Map of Small Rivers', author: 'Ada Reed', isbn: '9780000000026', qty: 1, price: 2250 },
      { title: 'Small Bear Sleeps', qty: 1, price: 1200, for: 'kid1' },
    ] });
    expect(r.lines.map((l) => l.new)).toEqual([true, true]);
    const rivers = db.select().from(t.book).where(eq(t.book.isbn13, '9780000000026')).get()!;
    expect(rivers).toMatchObject({ title: 'A Map of Small Rivers', authorsJson: '["Ada Reed"]', audience: 'adult' });
    const bear = db.select().from(t.book).where(eq(t.book.title, 'Small Bear Sleeps')).get()!;
    expect(bear.audience).toBe('kids');
    expect(db.select().from(t.reading).where(eq(t.reading.bookId, bear.id)).all()).toMatchObject([{ personId: 'p_kid1', status: 'to_read' }]);
    expect(db.select().from(t.copy).where(eq(t.copy.bookId, rivers.id)).get()).toMatchObject({ source: 'manual', orderId: null, acquiredAt: NOW.toISOString() });
    expect(order(db).status).toBe('drafted'); // neither book was in an order
  });

  it('a title that names several books, without an author or ISBN to tell them apart, is refused, never a third book', () => {
    const db = world();
    db.insert(t.book).values({ id: 'b_tide2', title: 'The Long Tide of Markets', authorsJson: '["Ola Brandt"]', audience: 'kids', normKey: 'x', createdAt: NOW.toISOString() }).run();
    const s = snapshot(db);
    refused(db, { kind: 'invoice', lines: [{ title: 'The Long Tide of Markets', qty: 1, price: 1000 }] }, 400, /row 1.*several books/);
    expect(snapshot(db)).toBe(s);
    record(db, { kind: 'invoice', lines: [{ title: 'The Long Tide of Markets', author: 'Ola Brandt', qty: 1, price: 1000 }] });
    expect(db.select().from(t.copy).where(eq(t.copy.bookId, 'b_tide2')).all()).toHaveLength(1);
  });

  it('two lines of the same new book are one book with two copies', () => {
    const db = world();
    record(db, { kind: 'invoice', lines: [{ title: 'Paper Boats', qty: 1, price: 900 }, { title: 'Paper boats', qty: 1, price: 900 }] });
    const b = db.select().from(t.book).where(eq(t.book.title, 'Paper Boats')).all();
    expect(b).toHaveLength(1);
    expect(db.select().from(t.copy).where(eq(t.copy.bookId, b[0]!.id)).all()).toHaveLength(2);
  });

  it('an invoice number counts once per shop: the same shop again (any case) is 409; another shop\'s, or one with no shop, counts', () => {
    const db = world();
    const inv = (number: string, shop?: string) => ({ kind: 'invoice', number, ...(shop ? { shop } : {}), lines: [{ isbn: '9780000000002', qty: 1, price: 1990 }] });
    expect(record(db, inv('R-1001', 'Corner Books')).shop).toBe('Corner Books');
    refused(db, inv('r-1001', 'corner books'), 409, /recorded already/);
    refused(db, inv(' R-1001 ', 'Corner Books'), 409, /recorded already/);
    record(db, inv('R-1001', 'Riverside Books'));
    record(db, inv('R-1001'));
    refused(db, inv('r-1001'), 409, /recorded already/);
    record(db, { kind: 'invoice', lines: [{ isbn: '9780000000002', qty: 1, price: 1990 }] });
    expect(copies(db)).toHaveLength(4);
  });

  it('an enabled connector\'s id names its shop (any case); a label never takes the id of a connector that is not enabled', () => {
    const db = world();
    expect(record(db, { kind: 'invoice', number: '1', shop: 'Quillmere', lines: [{ isbn: '9780000000002', qty: 1, price: 1990 }] }).shop).toBe('quillmere');
    db.delete(t.connectorEnabled).run();
    expect(record(db, { kind: 'invoice', number: '2', shop: 'Quillmere', lines: [{ isbn: '9780000000002', qty: 1, price: 1990 }] }).shop).toBe('Quillmere');
  });

  it('typed for another shop, or for none: the connector\'s mail of that number still counts', async () => {
    for (const shop of ['Corner Books', undefined]) {
      const db = world();
      record(db, { kind: 'invoice', number: '99001122', ...(shop ? { shop } : {}), lines: [{ isbn: '9780000000002', qty: 1, price: 1990 }] });
      await mailInvoice(db, '99001122');
      expect(copies(db).filter((c) => c[1] === 'invoice')).toHaveLength(1);
      const row = db.select().from(t.mailSeen).where(eq(t.mailSeen.kind, 'invoice')).get()!;
      expect(JSON.parse(row.parsedJson!).duplicateOf).toBeUndefined();
    }
  });

  it('typed for the connector\'s shop, then its mail: read, counted once', async () => {
    const db = world();
    record(db, { kind: 'invoice', number: '99001122', shop: 'quillmere', lines: [{ isbn: '9780000000002', qty: 1, price: 1990 }] });
    const before = copies(db);
    await mailInvoice(db, '99001122');
    expect(copies(db)).toEqual(before);
    const row = db.select().from(t.mailSeen).where(eq(t.mailSeen.kind, 'invoice')).get()!;
    expect(JSON.parse(row.parsedJson!)).toMatchObject({ duplicateOf: expect.stringMatching(/^entry:/) });
  });

  it('its mail, then typed for the connector\'s shop: 409; for another shop it counts', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    refused(db, { kind: 'invoice', number: '99001122', shop: 'quillmere', lines: [{ isbn: '9780000000002', qty: 1, price: 1990 }] }, 409, /bookshop's mail/);
    record(db, { kind: 'invoice', number: '99001122', shop: 'Corner Books', lines: [{ isbn: '9780000000002', qty: 1, price: 1990 }] });
  });
});

const PDF = Buffer.from('%PDF-1.4\n% invented, read only by the fake worker below\n');
const rows = (): MediaOutcome => ({ id: 'j', ok: true, kind: 'pdf.text', pages: 1, truncated: false, rows: [
  ['9780000000002', 'The Long Tide of Markets', '1 ST', '19.90', '19.90 CHF', '2.6 %'], ['Total', '19.90 CHF'],
] });
async function mailInvoice(db: W, number: string) {
  const raw = await signed(message({ id: `inv-${number}`, from: 'rechnung@quillmere.example', subject: `Ihre Quillmere-Rechnung Nr. ${number}`, body: 'Guten Tag, Ihre Rechnung finden Sie im Anhang.', pdf: PDF }));
  await refreshMail(db, CFG, { open: async () => fakeBox([{ uid: 1, raw }]), resolver, pdfText: async () => rows() });
}

describe('a quote typed in: the shop\'s answer to the month\'s order', () => {
  it('lines quoted at their price or unavailable; the order\'s total is the quote\'s and it is quoted; the prices learnt', () => {
    const db = world();
    const r = record(db, { kind: 'quote', month: '2026-11', lines: [
      { isbn: '9780000000002', price: 1990 },
      { title: 'Value Beyond Price', available: false },
    ] });
    expect(r).toMatchObject({ kind: 'quote', month: '2026-11', orderId: 'o_nov', total: 1990 });
    expect(lines(db)).toMatchObject({ b_tide: { state: 'quoted', quotedC: 1990 }, b_value: { state: 'unavailable', quotedC: null }, b_hedgehog: { state: 'planned' } });
    expect(order(db)).toMatchObject({ status: 'quoted', quotedC: 1990 });
    expect(db.select().from(t.bookOffer).where(eq(t.bookOffer.bookId, 'b_tide')).get()).toMatchObject({ source: 'quote', priceC: 1990 });
    expect(db.select().from(t.orderEntry).get()).toMatchObject({ kind: 'quote', orderId: 'o_nov', number: null });
  });

  it('a correction for one book: the answer\'s total is the order\'s, and the delivery a mail quote gave stays', () => {
    const db = world();
    db.update(t.orderLine).set({ state: 'quoted', quotedC: 2000, delivery: '3 – 4 days' }).where(eq(t.orderLine.bookId, 'b_tide')).run();
    db.update(t.orderLine).set({ state: 'quoted', quotedC: 1500, delivery: '1 – 2 weeks' }).where(eq(t.orderLine.bookId, 'b_value')).run();
    db.update(t.order).set({ status: 'quoted', quotedC: 3500 }).where(eq(t.order.id, 'o_nov')).run();
    const r = record(db, { kind: 'quote', month: '2026-11', lines: [{ title: 'Value Beyond Price', price: 1600 }] });
    expect(r.total).toBe(3600);
    expect(order(db).quotedC).toBe(3600);
    expect(lines(db)).toMatchObject({ b_tide: { delivery: '3 – 4 days' }, b_value: { delivery: '1 – 2 weeks', quotedC: 1600 } });
  });

  it('a line that names no book of that order, or one book twice, is refused (400), and nothing changes', () => {
    const db = world();
    const s = snapshot(db);
    refused(db, { kind: 'quote', month: '2026-11', lines: [{ isbn: '9780000000002', price: 1990 }, { title: 'The Grand Ledger', price: 1500 }] }, 400, /row 2.*no book of the order/);
    refused(db, { kind: 'quote', month: '2026-11', lines: [{ isbn: '9780000000002', price: 1990 }, { title: 'The Long Tide of Markets', price: 1990 }] }, 400, /row 2.*twice/);
    expect(snapshot(db)).toBe(s);
  });

  it('only for a composed order: none that month is 404; one not sent yet, or invoiced, is 409', () => {
    const db = world();
    const q = { kind: 'quote', month: '2026-11', lines: [{ isbn: '9780000000002', price: 1990 }] };
    refused(db, { ...q, month: '2026-10' }, 404);
    db.update(t.order).set({ status: 'picked' }).where(eq(t.order.id, 'o_nov')).run();
    refused(db, q, 409, /compose/i);
    db.update(t.order).set({ status: 'invoiced' }).where(eq(t.order.id, 'o_nov')).run();
    refused(db, q, 409);
    db.update(t.order).set({ status: 'quoted' }).where(eq(t.order.id, 'o_nov')).run();
    record(db, q);
  });

  it('an available line needs its price; an unavailable one has none', () => {
    const db = world();
    refused(db, { kind: 'quote', month: '2026-11', lines: [{ isbn: '9780000000002' }] }, 400, /price/);
    refused(db, { kind: 'quote', month: '2026-11', lines: [{ isbn: '9780000000002', available: false, price: 100 }] }, 400, /price/);
  });
});

describe('a CSV imported: the same entry as typed', () => {
  it('an invoice\'s rows, its columns in any order and case; columns it does not read are ignored and named', () => {
    const a = world(), b = world();
    const typed = record(a, { kind: 'invoice', number: 'R-7', lines: [{ isbn: '9780000000002', qty: 1, price: 1990 }, { title: 'The Quiet Hedgehog', author: 'Lena Paulsen', qty: 2, price: 1690 }] });
    const csv = record(b, { kind: 'invoice', number: 'R-7', csv: 'Qty;Price;ISBN;Title;Author;Shelf\n1;19.90;978-0-00-000000-2;;;x\n2;16,90;;The Quiet Hedgehog;Lena Paulsen;y\n' });
    expect(csv.lines).toEqual(typed.lines);
    expect(csv.total).toBe(typed.total);
    expect(csv.ignoredColumns).toEqual(['shelf']);
    expect(copies(b)).toEqual(copies(a));
    expect(b.select().from(t.orderEntry).get()!.source).toBe('csv');
  });

  it('a quote\'s rows with available yes or no', () => {
    const db = world();
    record(db, { kind: 'quote', month: '2026-11', csv: 'isbn,price,available\n9780000000002,19.90,yes\n9780000000019,,no\n' });
    expect(lines(db)).toMatchObject({ b_tide: { state: 'quoted', quotedC: 1990 }, b_hedgehog: { state: 'unavailable' } });
  });

  it('a column of another kind\'s is ignored too: a quote has no qty and no for', () => {
    const db = world();
    const r = record(db, { kind: 'quote', month: '2026-11', csv: 'isbn,price,qty,for\n9780000000002,19.90,3,kid1\n' });
    expect(r.ignoredColumns).toEqual(['qty', 'for']);
    expect(r.lines).toMatchObject([{ qty: null, for: null }]);
  });

  it('a row it cannot read is refused with its row number, and nothing changes', () => {
    const db = world();
    const s = snapshot(db);
    refused(db, { kind: 'invoice', csv: 'isbn,qty,price\n9780000000002,1,19.90\n9780000000002,1,19.9.0\n' }, 400, /row 2.*price/);
    refused(db, { kind: 'invoice', csv: 'isbn,qty,price\n9780000000002,1,1\'990\n' }, 400, /row 1.*price/);
    refused(db, { kind: 'invoice', csv: 'qty,price\n1,19.90\n' }, 400, /title or isbn/);
    refused(db, { kind: 'invoice', csv: 'title,title\nA,B\n' }, 400, /twice/);
    refused(db, { kind: 'invoice', csv: 'title,qty,price\n"A\n' }, 400, /quote/);
    refused(db, { kind: 'invoice', csv: 'title,qty,price\n' }, 400, /no rows/);
    expect(snapshot(db)).toBe(s);
  });
});

describe('a dry run: what would happen, and nothing changes', () => {
  it('the same answer as the entry, with no id, and every table as it was', () => {
    const db = world();
    const s = snapshot(db);
    const body = { kind: 'invoice', number: 'R-9', lines: [{ isbn: '9780000000002', qty: 1, price: 1990 }, { title: 'Paper Boats', qty: 1, price: 900 }] };
    const dry = record(db, { ...body, dryRun: true });
    expect(snapshot(db)).toBe(s);
    expect(dry).toMatchObject({ dryRun: true, total: 2890, lines: [{ bookId: 'b_tide', new: false }, { bookId: null, new: true, title: 'Paper Boats' }] });
    expect(dry.id).toBeUndefined();
    // A second row of the book the dry run would add names no id either (it would not exist).
    const twice = record(db, { kind: 'invoice', dryRun: true, lines: [{ title: 'Paper Boats', qty: 1, price: 900 }, { title: 'Paper Boats', qty: 1, price: 900 }] });
    expect(twice.lines.map((l) => [l.bookId, l.new])).toEqual([[null, true], [null, false]]);
    const real = record(db, body);
    expect(real.lines.map((l) => l.new)).toEqual([false, true]);
    expect(real.total).toBe(dry.total);
  });
});

describe('what is refused before anything changes', () => {
  const inv = (line: Record<string, unknown>, more: Record<string, unknown> = {}) => ({ kind: 'invoice', lines: [{ title: 'A Book', qty: 1, price: 1000, ...line }], ...more });
  it.each([
    ['not an object', [], /object/],
    ['an unknown field', { ...inv({}), store: 'x' }, /store/],
    ['an unknown kind', { kind: 'order', lines: [{ title: 'A', qty: 1, price: 1 }] }, /kind/],
    ['both lines and a CSV', { ...inv({}), csv: 'title\nA' }, /lines or csv/],
    ['neither', { kind: 'invoice' }, /lines or csv/],
    ['no lines', { kind: 'invoice', lines: [] }, /lines/],
    ['too many lines', { kind: 'invoice', lines: Array.from({ length: ENTRY_LIMITS.lines + 1 }, () => ({ title: 'A', qty: 1, price: 1 })) }, /lines/],
    ['an unknown field on a line', inv({ shelf: 'x' }), /shelf/],
    ['a quantity of 0', inv({ qty: 0 }), /qty/],
    ['a quantity over the limit', inv({ qty: ENTRY_LIMITS.qty + 1 }), /qty/],
    ['a quantity that is no whole number', inv({ qty: 1.5 }), /qty/],
    ['a price below 0', inv({ price: -1 }), /price/],
    ['a price that is no whole number of hundredths', inv({ price: 19.9 }), /price/],
    ['a price over the ceiling', inv({ price: ENTRY_LIMITS.price + 1 }), /price/],
    ['an invoice line without a price', inv({ price: undefined }), /price/],
    ['an ISBN whose check digit is wrong', inv({ isbn: '9780000000003' }), /ISBN/],
    ['an EAN that is no book\'s', inv({ isbn: '4006381333931' }), /ISBN/],
    ['a title too long', inv({ title: 'a'.repeat(301) }), /title/],
    ['a title with a run of 12 digits (a card or account number)', inv({ title: 'Paid with 4111 1111 1111 1111' }), /title/],
    ['a title with a control character', inv({ title: 'A\u0007Book' }), /title/],
    ['an author with a line break', inv({ author: 'A\nB' }), /author/],
    ['a title with U+FFFD (a file that was not UTF-8)', inv({ title: 'Die Br\ufffdcke' }), /UTF-8/],
    ['a shop with U+FFFD', inv({}, { shop: 'B\ufffdcher' }), /UTF-8/],
    ['a CSV header with U+FFFD', { kind: 'invoice', csv: 'title;qty;price;B\ufffdcher\nA;1;1\n' }, /UTF-8/],
    ['a CSV cell with U+FFFD', { kind: 'invoice', csv: 'title;author;qty;price\nDie Br\ufffdcke;J\ufffdrg M\ufffdller;1;19,90\n' }, /row 1.*UTF-8/],
    ['a shop too long', inv({}, { shop: 's'.repeat(81) }), /shop/],
    ['a quote with a shop', { kind: 'quote', month: '2026-11', shop: 'x', lines: [{ isbn: '9780000000002', price: 1990 }] }, /shop/],
    ['a line with neither title nor ISBN', inv({ title: undefined }), /title or isbn/i],
    ['an ISBN alone that names no book', inv({ title: undefined, isbn: '9780000000026' }), /title/],
    ['a quote line with a quantity', { kind: 'quote', month: '2026-11', lines: [{ isbn: '9780000000002', price: 1990, qty: 1 }] }, /qty/],
    ['an invoice with a month', inv({}, { month: '2026-11' }), /month/],
    ['a quote without its month', { kind: 'quote', lines: [{ isbn: '9780000000002', price: 1990 }] }, /month/],
    ['a quote with a date', { kind: 'quote', month: '2026-11', date: '2026-11-01', lines: [{ isbn: '9780000000002', price: 1990 }] }, /date/],
    ['a date in the future', inv({}, { date: '2026-11-18' }), /date/],
    ['a date that is no day', inv({}, { date: '2026-02-30' }), /date/],
    ['a number with a run of 12 digits', inv({}, { number: '411111111111' }), /number/],
    ['a number with a character it cannot hold', inv({}, { number: 'R<1>' }), /number/],
    ['a CSV too long', { kind: 'invoice', csv: 'x'.repeat(CSV_LIMITS.chars + 1) }, /characters/],
    ['dryRun that is no boolean', inv({}, { dryRun: 'yes' }), /dryRun/],
  ])('%s: 400', (_n, body, msg) => {
    const db = world();
    const s = snapshot(db);
    refused(db, body, 400, msg as RegExp);
    expect(snapshot(db)).toBe(s);
  });

  it('a book for another adult is 403 (yourself or a kid); a handle nobody has is 404', () => {
    const db = world();
    refused(db, inv({ for: 'partner' }), 403);
    refused(db, inv({ for: 'nobody' }), 404);
    record(db, inv({ for: 'me' }));
  });

  it('a household with no currency yet records no amounts (409)', () => {
    const db = world();
    db.update(t.householdSettings).set({ currency: null }).run();
    refused(db, inv({}), 409, /currency/);
  });
});

describe('POST /orders/entries', () => {
  let built: BuiltApp;
  let db: W;
  beforeAll(async () => {
    db = world();
    built = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY }), db);
    await built.app.ready();
  });
  afterAll(() => built.app.close());
  const post = (who: string, payload: unknown, origin = ORIGIN) => built.app.inject({ method: 'POST', url: '/api/orders/entries', payload: JSON.stringify(payload), headers: { cookie: sessionCookie(db, who), origin, 'content-type': 'application/json' } });
  const body = { kind: 'invoice', lines: [{ title: 'Paper Boats', qty: 1, price: 900 }] };

  it('an adult records it (201); a dry run answers 200 and records nothing', async () => {
    const dry = await post('p_sam', { ...body, dryRun: true });
    expect(dry.statusCode).toBe(200);
    expect(db.select().from(t.orderEntry).all()).toEqual([]);
    const res = await post('p_sam', body);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: 'invoice', total: 900, lines: [{ new: true }] });
    expect(db.select().from(t.orderEntry).all()).toHaveLength(1);
  });

  it('GET /orders/shops: the enabled connectors any adult may name an invoice\'s shop by', async () => {
    const res = await built.app.inject({ url: '/api/orders/shops', headers: { cookie: sessionCookie(db, 'p_sam') } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ shops: [{ id: 'quillmere', name: expect.any(String) }] });
  });

  it('a kid has no access; another origin is refused', async () => {
    expect((await post('p_kid1', body)).statusCode).toBe(403);
    expect((await post('p_sam', body, 'https://evil.example')).statusCode).toBe(403);
    expect(db.select().from(t.orderEntry).all()).toHaveLength(1);
  });

  it('what is refused answers its status with Philobiblos\'s words', async () => {
    const res = await post('p_sam', { kind: 'invoice', lines: [{ title: 'A', qty: 0, price: 1 }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/row 1.*qty/);
  });
});
