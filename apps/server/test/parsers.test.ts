// The bookshop's mails read into fields, and what they change (ADR 0007, contracts/connectors.md). Every mail and
// invoice row here is invented (names, titles, numbers); the keys are the test's own (mailkit.ts). Each rule has a
// test that fails when the rule is changed.
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as t from '../src/db/schema';
import { seal } from '../src/household/sealed';
import { applyMail, matchBook, monthOfSubject, unmatchedLines } from '../src/mail/effects';
import { PARSER_VERSION, PDF_TRIES, refreshMail, type MailDeps } from '../src/mail/job';
import * as parse from '../src/mail/parse';
import { addressParts, htmlLines, openVerified, type VerifiedMail } from '../src/mail/read';
import { markOwned } from '../src/month/plan';
import { SEALED } from '../src/routes/month';
import type { MediaOutcome } from '../src/media/client';
import { MediaUnavailable } from '../src/media/client';
import { TEST_SEALING_KEY, household } from './helpers';
import { CFG, CONNECTORS, HOUSEHOLD, RULES, SEALERS, SHOPS, fakeBox, message, resolver, signed } from './mailkit';

// The parsers with the invented example bookshop's rules (connectors/quillmere/connector.yaml).
const { PARSERS } = parse;
const classify = (from: string, subject: string | null) => parse.classify(RULES, from, subject);
const ownLines = (text: string) => parse.ownLines(text, RULES);
const parseQuote = (text: string, address: string[]) => parse.parseQuote(text, address, RULES);
const parseShop = (kind: 'online_order' | 'click_collect', n: string, text: string, address: string[]) => parse.parseShop(kind, n, text, address, RULES);
const parseInvoice = (n: string, rows: string[][], truncated: boolean, address: string[]) => parse.parseInvoice(n, rows, truncated, address, RULES);

const QUOTE = [
  'Dear customer,', '', 'Thank you for your order. Here are the prices:', '',
  'Author: Mira Okafor', 'Title: The Long Tide of Markets', 'ISBN: 9780000000002', 'Price: CHF 19.90', 'Delivery due: 3 – 4 days', '',
  'Paulsen, The Quiet Hedgehog', 'ISBN: 978-0-00-000001-9', 'Price. CHF 16.90', 'delivery due: 2-3 days', '',
  '- Okafor, Value Beyond Price, not in stock / backorder',
  '- Reed, A Map of Small Rivers, CHF 22.50, delivery time 1-3 days', '',
  'Total: CHF 59.30', '', 'Kind regards', 'English Bookshop', '',
  'On Mon, 2 Nov 2026 at 10:00, A Reader <shelf.household@example.org> wrote:',
  '> 1. The Long Tide of Markets, Mira Okafor', '> Premium Card number: 4111 1111 1111 1111',
].join('\r\n');

const NOW = '2026-11-16T10:00:00.000Z';
/** The household of helpers.ts with three books ordered in November 2026 (composed: drafted). */
function world() {
  const db = household();
  db.update(t.book).set({ isbn13: '9780000000002' }).where(eq(t.book.id, 'b_tide')).run();
  db.insert(t.book).values([
    { id: 'b_hedgehog', title: 'The Quiet Hedgehog', authorsJson: '["Lena Paulsen"]', isbn13: '9780000000019', audience: 'kids', normKey: 'x', createdAt: NOW },
    { id: 'b_value', title: 'Value Beyond Price', authorsJson: '["Mira Okafor"]', audience: 'adult', normKey: 'x', createdAt: NOW },
  ]).run();
  db.insert(t.order).values({ id: 'o_nov', month: '2026-11', status: 'drafted', estimateC: 7500, createdAt: NOW }).run();
  db.insert(t.orderLine).values([
    { orderId: 'o_nov', bookId: 'b_tide', forPerson: 'p_alex', estimateC: 2500 },
    { orderId: 'o_nov', bookId: 'b_hedgehog', forPerson: 'p_kid1', estimateC: 2500 },
    { orderId: 'o_nov', bookId: 'b_value', forPerson: 'p_alex', estimateC: 2500 },
  ]).run();
  return db;
}
const order = (db: ReturnType<typeof world>) => db.select().from(t.order).where(eq(t.order.id, 'o_nov')).get()!;
const lines = (db: ReturnType<typeof world>) => Object.fromEntries(db.select().from(t.orderLine).where(eq(t.orderLine.orderId, 'o_nov')).all().map((l) => [l.bookId, l]));
const kept = (db: ReturnType<typeof world>, id: string) => db.select().from(t.mailSeen).where(eq(t.mailSeen.messageId, id)).get()!;
const run = (db: ReturnType<typeof world>, box: ReturnType<typeof fakeBox>, deps: MailDeps = {}, cfg = CFG) => refreshMail(db, cfg, { open: async () => box, resolver, ...deps });

describe('quotes: the three layouts, and only the bookshop\'s own lines', () => {
  it('blocks, "Surname, Title" with an ISBN line, and one line per book; the quoted request below is never read', () => {
    const p = parseQuote(QUOTE, []);
    expect(p).toMatchObject({ kind: 'bookshop_quote', parser: PARSERS.quote });
    if (p.kind !== 'bookshop_quote') throw new Error('a quote');
    expect(p.lines).toEqual([
      { title: 'The Long Tide of Markets', author: 'Mira Okafor', ean: '9780000000002', priceC: 1990, delivery: '3 – 4 days', available: true },
      { title: 'The Quiet Hedgehog', author: 'Paulsen', ean: '9780000000019', priceC: 1690, delivery: '2-3 days', available: true },
      { title: 'Value Beyond Price', author: 'Okafor', ean: null, priceC: null, delivery: 'not in stock / backorder', available: false },
      { title: 'A Map of Small Rivers', author: 'Reed', ean: null, priceC: 2250, delivery: '1-3 days', available: true },
    ]);
    expect(JSON.stringify(p)).not.toMatch(/4111|Premium/);
  });

  it('a block written on one line with " / " is the same block', () => {
    const p = parseQuote('Author: Mira Okafor / Title: The Long Tide of Markets / ISBN: 9780000000002 / Price: CHF 19.90 / Delivery due: 3 – 4 days', []);
    expect(p).toMatchObject({ kind: 'bookshop_quote', lines: [{ title: 'The Long Tide of Markets', priceC: 1990, delivery: '3 – 4 days' }] });
  });

  it('"Surname, Title" with a blank line before its ISBN line is the same layout (PR #14 review, round 2)', () => {
    expect(parseQuote('Paulsen, The Quiet Hedgehog\n\nISBN: 9780000000019\nPrice. CHF 16.90', [])).toMatchObject({ kind: 'bookshop_quote', lines: [{ title: 'The Quiet Hedgehog', author: 'Paulsen', priceC: 1690 }] });
  });

  it('a quoted EAN that is no ISBN never matches by its title (PR #14 review, round 2)', async () => {
    const db = world();
    const body = 'Author: Mira Okafor\nTitle: The Long Tide of Markets\nISBN: 4001234567890\nPrice: CHF 19.90';
    await run(db, fakeBox([{ uid: 1, raw: await signed(message({ id: 'q30', subject: 'Re: Book order, November 2026', body })) }]));
    expect(lines(db).b_tide!.state).toBe('planned');
    expect(unmatchedLines(db).map((l) => l.title)).toEqual(['The Long Tide of Markets']);
  });

  it('a status line under a block marks the book unavailable', () => {
    const p = parseQuote('Title: Value Beyond Price\nAuthor: Mira Okafor\nCurrently not in stock', []);
    expect(p).toMatchObject({ kind: 'bookshop_quote', lines: [{ title: 'Value Beyond Price', available: false, priceC: null }] });
  });

  it.each([
    ['an Outlook header block without ">"', 'From: A Reader <shelf.household@example.org>\nSent: Monday\n- Okafor, The Grand Ledger, CHF 99.00'],
    ['a German reply line', 'Am 2. Nov. 2026 um 10:00 schrieb A Reader:\n- Okafor, The Grand Ledger, CHF 99.00'],
    ['an underscore rule', '________________________________\n- Okafor, The Grand Ledger, CHF 99.00'],
  ])('below %s, nothing is read (the household\'s own request)', (_n, quoted) => {
    const p = parseQuote(`- Okafor, Value Beyond Price, CHF 18.90, delivery time 1-3 days\n\n${quoted}`, []);
    expect(p).toMatchObject({ kind: 'bookshop_quote', lines: [{ title: 'Value Beyond Price' }] });
  });

  it('a ">" line is never read, even without a reply marker above it', () => {
    expect(parseQuote('- Okafor, Value Beyond Price, CHF 18.90\n> - Okafor, The Grand Ledger, CHF 99.00', [])).toMatchObject({ lines: [{ title: 'Value Beyond Price' }] });
  });

  it.each([
    ['a price Philobiblos cannot place', 'Title: Value Beyond Price\nPrice: CHF 18.90\nSpecial offer this week: CHF 5.00 off', 'a price Philobiblos cannot place'],
    ['a book without a price or a status', 'Author: Mira Okafor\nTitle: Value Beyond Price\nDelivery due: 3 days', 'a book with neither a price nor a status'],
    ['two prices for one book', 'Title: Value Beyond Price\nPrice: CHF 18.90\nPrice: CHF 9.90', 'two price lines for one book'],
    ['an ISBN that is not one', 'Title: Value Beyond Price\nISBN: 12345\nPrice: CHF 18.90', 'an ISBN Philobiblos cannot read'],
    ['a block with no title', 'Author: Mira Okafor\nPrice: CHF 18.90', 'a book without a title'],
    ['a bullet with an amount it cannot read', '- Value Beyond Price CHF 18.90', 'a price Philobiblos cannot place'],
    ['no books at all', 'Dear customer,\nwe will be in touch.', 'no books'],
  ])('fails closed on %s: unknown layout, with the parser\'s version', (_n, text, reason) => {
    expect(parseQuote(text, [])).toEqual({ kind: 'unknown_layout', parser: PARSERS.quote, expected: 'bookshop_quote', reason });
  });

  it('"We have now ordered…": a confirmation, with its order number', () => {
    expect(parseQuote('Dear customer,\nWe have now ordered the books for you.\nOrder number: 7712345\nKind regards', [])).toEqual({ kind: 'bookshop_confirm', parser: PARSERS.confirm, orderNumber: '7712345' });
  });

  it('every string field passes safeField: the delivery address or a card-like number is dropped', () => {
    const address = addressParts('A Reader\nSomewhere Street 1\n8000 Exampletown');
    const p = parseQuote('Title: Delivered to Somewhere Str. 1\nPrice: CHF 18.90\nDelivery due: card 4111 1111 1111 1111', address);
    expect(p).toMatchObject({ kind: 'bookshop_quote', lines: [{ title: null, delivery: null, priceC: 1890 }] });
  });
});

describe('the shop\'s order mails and invoices', () => {
  it('recognised by their signed subject (and the English Bookshop by its sender); anything else is "other"', () => {
    expect(classify('x@quillmere.example', 'Ihre Quillmere Bestellung (4400123)')).toEqual({ kind: 'online_order', number: '4400123' });
    expect(classify('x@quillmere.example', 'Wir bearbeiten Ihre Bestellung (4400124)')).toEqual({ kind: 'click_collect', number: '4400124' });
    expect(classify('x@quillmere.example', 'Ihre Quillmere-Rechnung Nr. 99001122')).toEqual({ kind: 'invoice', number: '99001122' });
    expect(classify('english-orders@quillmere.example', 'Re: Book order, November 2026')).toEqual({ kind: 'quote_or_confirm' });
    expect(classify('newsletter@quillmere.example', 'Re: Book order, November 2026')).toEqual({ kind: 'other' });
    // A number that is not one run of 4 to 11 digits (spaced, or very long) fails closed, never "other" (round 2).
    expect(classify('x@quillmere.example', 'Ihre Quillmere-Rechnung Nr. 1234 5678')).toEqual({ kind: 'number_unreadable', expected: 'invoice' });
    expect(classify('x@quillmere.example', `Wir bearbeiten Ihre Bestellung (${'9'.repeat(41)})`)).toEqual({ kind: 'number_unreadable', expected: 'click_collect' });
  });

  it('click & collect and online orders: one line per article; non-books skipped', () => {
    const text = 'Guten Tag\nBuch The Quiet Hedgehog von Lena Paulsen EAN: 9780000000019 | Fr. 16.90\nSpielwaren Wooden Train Set von Toyworks | Fr. 39.00\nTaschenbuch Value Beyond Price von Mira Okafor | 2 x Fr. 18.90\nTotal Fr. 92.70';
    expect(parseShop('click_collect', '4400124', text, [])).toEqual({ kind: 'click_collect', parser: PARSERS.collect, orderNumber: '4400124', lines: [
      { title: 'The Quiet Hedgehog', author: 'Lena Paulsen', ean: '9780000000019', qty: 1, priceC: 1690 },
      { title: 'Value Beyond Price', author: 'Mira Okafor', ean: null, qty: 2, priceC: 1890 },
    ] });
    expect(parseShop('online_order', '4400123', 'Kalender Wall Calendar von Someone | Fr. 12.00', [])).toMatchObject({ kind: 'unknown_layout', reason: 'no articles' });
  });

  it('an article of a kind Philobiblos does not know, or an amount it cannot place: fails closed', () => {
    expect(parseShop('online_order', '1', 'Gutschein Gift card von Shop | Fr. 50.00', [])).toMatchObject({ kind: 'unknown_layout', parser: PARSERS.online, reason: 'a price Philobiblos cannot place' });
    expect(parseShop('online_order', '1', 'Buch The Quiet Hedgehog von Lena Paulsen Fr. 16.90', [])).toMatchObject({ kind: 'unknown_layout' });
  });

  const ROWS = [
    ['Rechnung Nr. 99001122'], ['Kundennummer', '5550001'],
    ['9780000000002', 'The Long Tide of Markets', '1 ST', '19.90', '19.90 CHF', '2.6 %'],
    ['9780000000019', 'The Quiet Hedgehog', '2', 'ST', '16.90', '10 %', '30.42', 'CHF', '2.6%'],
    ['9780000000026', 'A Map of Small Rivers', '1 ST', '22.50', '22.50 CHF', '2.6 %'],
    ['Versandkosten', '0.00 CHF'], ['Total', '72.82 CHF'],
  ];

  it('invoice rows: EAN, title, quantity, price, discount, total, VAT; the stated total is their sum', () => {
    expect(parseInvoice('99001122', ROWS, false, [])).toEqual({ kind: 'invoice', parser: PARSERS.invoice, invoiceNumber: '99001122', totalC: 7282, lines: [
      { ean: '9780000000002', title: 'The Long Tide of Markets', qty: 1, priceC: 1990, discountPct: null, totalC: 1990, vatPct: 2.6 },
      { ean: '9780000000019', title: 'The Quiet Hedgehog', qty: 2, priceC: 1690, discountPct: 10, totalC: 3042, vatPct: 2.6 },
      { ean: '9780000000026', title: 'A Map of Small Rivers', qty: 1, priceC: 2250, discountPct: null, totalC: 2250, vatPct: 2.6 },
    ] });
  });

  it.each([
    ['a total that is not the rows\' sum', ROWS.map((r) => (r[0] === 'Total' ? ['Total', '99.99 CHF'] : r)), false, 'the stated total is not the sum of the rows'],
    ['a book row it cannot read', [...ROWS.slice(0, 2), ['9780000000002', 'The Long Tide of Markets', '19.90']], false, 'a book row Philobiblos cannot read'],
    ['a PDF cut short by the worker\'s limits', ROWS, true, 'the PDF was cut short'],
    ['no book rows', [['Rechnung'], ['Total', '0.00 CHF']], false, 'no book rows'],
  ])('fails closed on %s', (_n, rows, truncated, reason) => {
    expect(parseInvoice('99001122', rows, truncated, [])).toEqual({ kind: 'unknown_layout', parser: PARSERS.invoice, expected: 'invoice', reason });
  });

  it('bounded and linear: long hostile text costs little, and too many lines or a huge line with an amount is refused', () => {
    const t0 = Date.now();
    expect(parseQuote(`${'- , '.repeat(240)}CHF 1.00\n`.repeat(4000), [])).toMatchObject({ kind: 'unknown_layout' });
    expect(parseQuote(`Title: ${'a'.repeat(990)}\n`.repeat(4000), [])).toMatchObject({ kind: 'unknown_layout' });
    expect(parseShop('online_order', '1', `Buch ${' von '.repeat(190)} | Fr. 1.00\n`.repeat(4000), [])).toMatchObject({ kind: 'unknown_layout' });
    expect(parseInvoice('1', Array.from({ length: 20_000 }, () => ['9780000000002', ...Array(80).fill('ST')]), false, [])).toMatchObject({ kind: 'unknown_layout' });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(ownLines('x\n'.repeat(5001))).toBeNull();
  });

  it('linear where the review found it quadratic: 5,000 lines of " / " pieces, and HTML with unclosed tags (PR #14 review)', () => {
    let t0 = Date.now();
    expect(parseQuote(`${' / title x'.repeat(99)}\n`.repeat(5000), [])).toMatchObject({ kind: 'unknown_layout' });
    expect(Date.now() - t0).toBeLessThan(1500);
    t0 = Date.now();
    expect(htmlLines('<br '.repeat(1_000_000))).toBe('');
    expect(htmlLines('<br>'.repeat(1_000_000)).length).toBe(1_000_000);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(htmlLines('a<br>b</p>c<brx>d<BR/>e')).toBe('a\nb\nc d\ne');
    expect(ownLines(`CHF 1.00 ${'x'.repeat(1001)}`)).toBeNull();
  });
});

describe('matching lines to books', () => {
  const books = [
    { id: 'a', title: 'The Quiet Hedgehog', authors: ['Lena Paulsen'], isbn13: '9780000000019' },
    { id: 'b', title: 'Value Beyond Price', authors: ['Mira Okafor'], isbn13: null },
    { id: 'c', title: 'Twin Title', authors: ['Ada Reed'], isbn13: null },
    { id: 'd', title: 'Twin Title', authors: ['Ben Reed'], isbn13: null },
  ];
  it('by EAN first, whatever the title says', () => expect(matchBook(books, { ean: '9780000000019', title: 'Hedgehog Board Edition', author: 'Someone' })).toBe('a'));
  it('then by normalised title and author: the full name, "Surname, First" or a surname alone', () => {
    expect(matchBook(books, { ean: null, title: 'VALUE beyond price!', author: 'Mira Okafor' })).toBe('b');
    expect(matchBook(books, { ean: null, title: 'Value Beyond Price', author: 'Okafor, Mira' })).toBe('b');
    expect(matchBook(books, { ean: null, title: 'Value Beyond Price', author: 'Okafor' })).toBe('b');
  });
  it('another author, or two books that fit: no match (the Inbox)', () => {
    expect(matchBook(books, { ean: null, title: 'Value Beyond Price', author: 'Someone Else' })).toBeNull();
    expect(matchBook(books, { ean: null, title: 'Twin Title', author: 'Reed' })).toBeNull();
    expect(matchBook(books, { ean: null, title: 'Twin Title', author: 'Ada Reed' })).toBe('c');
  });
  it('the month a reply names, as Compose writes it', () => {
    expect(monthOfSubject('AW: Re: Book order, November 2026')).toBe('2026-11');
    expect(monthOfSubject('Book order November 2026')).toBeNull();
  });
});

describe('effects, only from verified mail', () => {
  it('a quote: lines quoted or unavailable, the order\'s total is the quote, the thread kept, prices learnt; the rest to the Inbox', async () => {
    const db = world();
    const mail = await signed(message({ id: 'q1', subject: 'Re: Book order, November 2026', body: QUOTE }));
    expect((await run(db, fakeBox([{ uid: 1, raw: mail }]))).detail).toBe('1 new: 1 verified, 0 not verified, 0 seen before');
    expect(order(db)).toMatchObject({ status: 'quoted', quotedC: 1990 + 1690, mailThreadRef: '<q1@quillmere.example>' });
    expect(lines(db)).toMatchObject({
      b_tide: { state: 'quoted', quotedC: 1990, delivery: '3 – 4 days' },
      b_hedgehog: { state: 'quoted', quotedC: 1690 },
      b_value: { state: 'unavailable', quotedC: null },
    });
    expect(db.select().from(t.bookOffer).where(eq(t.bookOffer.source, 'quote')).all().map((o) => [o.bookId, o.priceC]).sort()).toEqual([['b_hedgehog', 1690], ['b_tide', 1990]]);
    expect(kept(db, '<q1@quillmere.example>')).toMatchObject({ kind: 'bookshop_quote', accepted: 1, parserVersion: `${PARSER_VERSION}/${PARSERS.quote}` });
    expect(unmatchedLines(db)).toEqual([{ mail: '<q1@quillmere.example>', kind: 'bookshop_quote', index: 3, title: 'A Map of Small Rivers', author: 'Reed', ean: null }]);
    expect(kept(db, '<q1@quillmere.example>').parsedJson).not.toMatch(/4111|Premium|Dear customer/);
  });

  it('a quote matches only the order\'s own books: a title in the library but not on the order stays unmatched (PR #14 review)', async () => {
    const db = world();
    const body = '- Okafor, Value Beyond Price, CHF 18.90\n- Okafor, The Grand Ledger, CHF 30.00';
    await run(db, fakeBox([{ uid: 1, raw: await signed(message({ id: 'q9', subject: 'Re: Book order, November 2026', body })) }]));
    expect(unmatchedLines(db).map((l) => l.title)).toEqual(['The Grand Ledger']);
    expect(db.select().from(t.bookOffer).where(eq(t.bookOffer.bookId, 'b_ledger')).all()).toEqual([]);
    expect(order(db).quotedC).toBe(1890);
  });

  it('a quote that names another month, or none, ties to no order: nothing changes, every line to the Inbox', async () => {
    const db = world();
    await run(db, fakeBox([{ uid: 1, raw: await signed(message({ id: 'q2', subject: 'Re: Book order, December 2026', body: QUOTE })) }]));
    expect(order(db)).toMatchObject({ status: 'drafted', quotedC: null, mailThreadRef: null });
    expect(unmatchedLines(db)).toHaveLength(4);
  });

  it.each(['picked', 'invoiced', 'closed'] as const)('an order that is %s (not with the bookshop for a quote) is never quoted', async (status) => {
    const db = world();
    db.update(t.order).set({ status }).where(eq(t.order.id, 'o_nov')).run();
    await run(db, fakeBox([{ uid: 1, raw: await signed(message({ id: `q-${status}`, subject: 'Re: Book order, November 2026', body: QUOTE })) }]));
    expect(order(db)).toMatchObject({ status, quotedC: null });
    expect(Object.values(lines(db)).map((l) => l.state)).toEqual(['planned', 'planned', 'planned']);
  });

  it('a confirmation in the thread of a quote ties to that order by its signed In-Reply-To: drafted becomes quoted', async () => {
    const db = world();
    db.update(t.order).set({ mailThreadRef: '<q0@quillmere.example>' }).where(eq(t.order.id, 'o_nov')).run();
    const mail = await signed(message({ id: 'c1', subject: 'Your books', extra: 'In-Reply-To: <q0@quillmere.example>', body: 'We have now ordered your books.\nOrder number: 7712345' }));
    await run(db, fakeBox([{ uid: 1, raw: mail }]));
    expect(order(db)).toMatchObject({ status: 'quoted', mailThreadRef: '<q0@quillmere.example> <c1@quillmere.example>' });
    expect(JSON.parse(kept(db, '<c1@quillmere.example>').parsedJson!)).toMatchObject({ orderNumber: '7712345', orderId: 'o_nov' });
  });

  it('the same quote, not verified (unsigned), or from another sender of the bookshop: nothing changes', async () => {
    const db = world();
    await run(db, fakeBox([
      { uid: 1, raw: message({ id: 'q3', subject: 'Re: Book order, November 2026', body: QUOTE }) },
      { uid: 2, raw: await signed(message({ id: 'q4', from: 'newsletter@quillmere.example', subject: 'Re: Book order, November 2026', body: QUOTE })) },
    ]));
    expect(order(db)).toMatchObject({ status: 'drafted', quotedC: null });
    expect(Object.values(lines(db)).map((l) => l.state)).toEqual(['planned', 'planned', 'planned']);
    expect(kept(db, '<q4@quillmere.example>')).toMatchObject({ kind: 'other', accepted: 1 });
  });

  it('applyMail refuses anything that did not come from openVerified', () => {
    const db = world();
    const fake = { auth: { accepted: true, via: 'dkim', reason: 'trust me', fromDomain: 'quillmere.example', messageId: '<x@y>', from: 'english-orders@quillmere.example' }, content: { subject: 'Re: Book order, November 2026', date: null, messageId: null, inReplyTo: null, pdfs: 0 }, text: QUOTE, tooLong: false, pdfs: [], threadRef: null } as unknown as VerifiedMail;
    expect(() => db.transaction((tx) => applyMail(tx, fake, parseQuote(QUOTE, []), { key: 'x', now: NOW }))).toThrow(/only to a verified mail/);
    expect(order(db).status).toBe('drafted');
  });

  it('an online order or click & collect: matched lines recorded, the others to the Inbox; no order is changed', async () => {
    const db = world();
    const mail = await signed(message({ id: 'cc1', from: 'shop@quillmere.example', subject: 'Wir bearbeiten Ihre Bestellung (4400124)', body: 'Buch The Quiet Hedgehog von Lena Paulsen EAN: 9780000000019 | Fr. 16.90\nBuch A Map of Small Rivers von Tamsin Reed | Fr. 22.50' }));
    await run(db, fakeBox([{ uid: 1, raw: mail }]));
    expect(JSON.parse(kept(db, '<cc1@quillmere.example>').parsedJson!)).toMatchObject({ orderNumber: '4400124', lines: [{ bookId: 'b_hedgehog' }, { bookId: null }] });
    expect(unmatchedLines(db).map((l) => l.title)).toEqual(['A Map of Small Rivers']);
    expect(order(db).status).toBe('drafted');
  });
});

const PDF = Buffer.from('%PDF-1.4\n% invented, read only by the fake worker below\n');
const invoiceRows = (): MediaOutcome => ({ id: 'j', ok: true, kind: 'pdf.text', pages: 1, truncated: false, rows: [
  ['Kundennummer', '5550001'],
  ['9780000000002', 'The Long Tide of Markets', '1 ST', '19.90', '19.90 CHF', '2.6 %'],
  ['9780000000019', 'The Quiet Hedgehog', '2 ST', '16.90', '33.80 CHF', '2.6 %'],
  ['9780000000026', 'A Map of Small Rivers', '1 ST', '22.50', '22.50 CHF', '2.6 %'],
  ['Total', '76.20 CHF'],
] });
const invoice = (id: string, number = '99001122') => signed(message({ id, from: 'rechnung@quillmere.example', subject: `Ihre Quillmere-Rechnung Nr. ${number}`, body: 'Guten Tag, Ihre Rechnung finden Sie im Anhang.', pdf: PDF }));

describe('invoices: copies, through the media worker only', () => {
  it('each copy owned, the order lines delivered and the order invoiced; unmatched rows to the Inbox; no PDF text kept', async () => {
    const db = world();
    db.update(t.order).set({ status: 'quoted' }).where(eq(t.order.id, 'o_nov')).run();
    const worker: Uint8Array[] = [];
    await run(db, fakeBox([{ uid: 1, raw: await invoice('i1') }]), { pdfText: async (pdf) => { worker.push(pdf); return invoiceRows(); } });
    expect(worker.map((b) => Buffer.from(b).subarray(0, 5).toString())).toEqual(['%PDF-']);
    const copies = db.select().from(t.copy).where(eq(t.copy.source, 'invoice')).all();
    expect(copies.map((c) => [c.bookId, c.orderId, c.priceC]).sort()).toEqual([['b_hedgehog', 'o_nov', 1690], ['b_hedgehog', 'o_nov', 1690], ['b_tide', 'o_nov', 1990]]);
    expect(copies[0]!.acquiredAt).toBe('2026-11-16T08:00:00.000Z');
    expect(order(db)).toMatchObject({ status: 'invoiced', invoicedC: 1990 + 3380 });
    expect(lines(db)).toMatchObject({ b_tide: { state: 'delivered' }, b_hedgehog: { state: 'delivered' }, b_value: { state: 'planned' } });
    expect(unmatchedLines(db).map((l) => l.ean)).toEqual(['9780000000026']);
    const row = kept(db, '<i1@quillmere.example>');
    expect(row).toMatchObject({ kind: 'invoice', accepted: 1 });
    expect(row.parsedJson).not.toMatch(/Kundennummer|5550001|%PDF/);
  });

  it('a book marked owned by a tap when the parcel came, then the shop\'s invoice read: the tap\'s copy is the invoice\'s, never a second (philobiblos#47)', async () => {
    const db = world();
    markOwned(db, 'o_nov', 'b_tide', { owned: true }, new Date(NOW));
    const tapped = lines(db).b_tide!.copyId!;
    await run(db, fakeBox([{ uid: 1, raw: await invoice('i1t') }]), { pdfText: async () => invoiceRows() });
    const tide = db.select().from(t.copy).where(eq(t.copy.bookId, 'b_tide')).all();
    expect(tide.map((c) => [c.id, c.source, c.orderId, c.priceC, c.acquiredAt])).toEqual([[tapped, 'invoice', 'o_nov', 1990, NOW]]); // the parcel's arrival kept
    expect(lines(db).b_tide).toMatchObject({ state: 'delivered', copyId: null, tappedFrom: null });
    expect(order(db)).toMatchObject({ status: 'invoiced', invoicedC: 1990 + 3380 });
    expect(() => markOwned(db, 'o_nov', 'b_tide', { owned: false })).toThrow(/invoice/);
  });

  it('the same invoice again under another Message-ID: read, never counted twice', async () => {
    const db = world();
    const box = fakeBox([{ uid: 1, raw: await invoice('i2') }, { uid: 2, raw: await invoice('i3') }]);
    await run(db, box, { pdfText: async () => invoiceRows() });
    expect(db.select().from(t.copy).where(eq(t.copy.source, 'invoice')).all()).toHaveLength(3);
    expect(JSON.parse(kept(db, '<i3@quillmere.example>').parsedJson!)).toMatchObject({ duplicateOf: '<i2@quillmere.example>' });
  });

  it('no worker yet: the mail waits (only where it is kept); the next run reads it again by its UID and applies it', async () => {
    const db = world();
    const box = fakeBox([{ uid: 4, raw: await invoice('i4') }]);
    await run(db, box, { pdfText: async () => { throw new MediaUnavailable(); } });
    expect(kept(db, '<i4@quillmere.example>')).toMatchObject({ kind: 'pending_pdf', accepted: 1 });
    expect(JSON.parse(kept(db, '<i4@quillmere.example>').parsedJson!)).toMatchObject({ uid: 4, uidValidity: 7, tries: 1 });
    expect(db.select().from(t.copy).where(eq(t.copy.source, 'invoice')).all()).toEqual([]);
    box.read.length = 0;
    expect((await run(db, box, { pdfText: async () => invoiceRows() })).detail).toBe('0 new: 0 verified, 0 not verified, 0 seen before; 1 read again');
    expect(box.read).toEqual([4]);
    expect(kept(db, '<i4@quillmere.example>').kind).toBe('invoice');
    expect(db.select().from(t.copy).where(eq(t.copy.source, 'invoice')).all()).toHaveLength(3);
  });

  it('read again, every check runs again: a mail changed in the mailbox since is refused and changes nothing', async () => {
    const db = world();
    const msgs = [{ uid: 4, raw: await invoice('i5') }];
    const box = fakeBox(msgs);
    await run(db, box, { pdfText: async () => { throw new MediaUnavailable(); } });
    msgs[0]!.raw = Buffer.from(msgs[0]!.raw.toString().replace('Ihre Rechnung finden', 'Ihre Rechnung: zahlen Sie hier'));
    await run(db, box, { pdfText: async () => invoiceRows() });
    expect(db.select().from(t.copy).where(eq(t.copy.source, 'invoice')).all()).toEqual([]);
    expect(kept(db, '<i5@quillmere.example>')).toMatchObject({ kind: 'pending_pdf' });
    expect(JSON.parse(kept(db, '<i5@quillmere.example>').authJson!)).toMatchObject({ accepted: false, reason: expect.stringMatching(/^read again: /) });
  });

  it('read again, another genuine mail at that UID: refused for good, nothing applied', async () => {
    const db = world();
    const msgs = [{ uid: 4, raw: await invoice('i6') }];
    const box = fakeBox(msgs);
    await run(db, box, { pdfText: async () => { throw new MediaUnavailable(); } });
    msgs[0]!.raw = await invoice('i7', '99001199');
    await run(db, box, { pdfText: async () => invoiceRows() });
    expect(kept(db, '<i6@quillmere.example>')).toMatchObject({ kind: 'reread_refused', accepted: 1 });
    expect(db.select().from(t.copy).where(eq(t.copy.source, 'invoice')).all()).toEqual([]);
  });

  it('read again only under the same UIDVALIDITY: a renumbered folder is never read by an old UID', async () => {
    const db = world();
    await run(db, fakeBox([{ uid: 4, raw: await invoice('i8') }]), { pdfText: async () => { throw new MediaUnavailable(); } });
    const renumbered = fakeBox([{ uid: 4, raw: await invoice('i9', '99001100') }], 8);
    // The window is read afresh (UID 4 there is another mail, read as a new one); the old row's UID is not asked for.
    await run(db, renumbered, { pdfText: async () => invoiceRows() });
    expect(renumbered.read).toEqual([4]);
    // Its old place is gone: given up for the re-read (the window still reads it in full if it is there).
    expect(kept(db, '<i8@quillmere.example>')).toMatchObject({ kind: 'reread_refused' });
    expect(JSON.parse(kept(db, '<i8@quillmere.example>').authJson!).reason).toMatch(/renumbered/);
    expect(kept(db, '<i9@quillmere.example>')).toMatchObject({ kind: 'invoice' });
  });

  it('a waiting mail met again under its new UID (a renumbered folder) is read in full and applied', async () => {
    const db = world();
    await run(db, fakeBox([{ uid: 4, raw: await invoice('i10') }]), { pdfText: async () => { throw new MediaUnavailable(); } });
    await run(db, fakeBox([{ uid: 11, raw: await invoice('i10') }], 8), { pdfText: async () => invoiceRows() });
    expect(kept(db, '<i10@quillmere.example>')).toMatchObject({ kind: 'invoice' });
    expect(JSON.parse(kept(db, '<i10@quillmere.example>').parsedJson!)).toMatchObject({ uid: 11, uidValidity: 8 });
    expect(db.select().from(t.copy).where(eq(t.copy.source, 'invoice')).all()).toHaveLength(3);
  });

  it('a PDF the worker never reads: tried a few times, then given up as an unknown layout (nothing applied)', async () => {
    const db = world();
    const box = fakeBox([{ uid: 4, raw: await invoice('i11') }]);
    for (let i = 0; i < PDF_TRIES; i++) await run(db, box, { pdfText: async () => ({ id: '', ok: false, error: 'busy' }) });
    expect(kept(db, '<i11@quillmere.example>')).toMatchObject({ kind: 'unknown_layout' });
    expect(JSON.parse(kept(db, '<i11@quillmere.example>').parsedJson!)).toMatchObject({ reason: 'the media worker did not read the PDF' });
    expect(db.select().from(t.copy).where(eq(t.copy.source, 'invoice')).all()).toEqual([]);
  });

  it('mails that can no longer be read again never hold the slots: a renumbered or a vanished one is given up, the rest go on (PR #14 review)', async () => {
    const db = world();
    const box = fakeBox([{ uid: 50, raw: await invoice('i20') }]);
    await run(db, box, { pdfText: async () => { throw new MediaUnavailable(); } });
    // Behind it in the table: 20 rows from an old UIDVALIDITY and 20 whose mail has left the mailbox.
    const pending = (id: string, uid: number, uidValidity: number) => ({ messageId: `<${id}@quillmere.example>`, kind: 'pending_pdf', parsedJson: JSON.stringify({ uid, uidValidity, tries: 1 }), parserVersion: PARSER_VERSION, seenAt: NOW, authJson: '{}', accepted: 1 });
    const rows = [...Array.from({ length: 20 }, (_, i) => pending(`old${i}`, i + 1, 6)), ...Array.from({ length: 20 }, (_, i) => pending(`gone${i}`, 100 + i, 7))];
    db.delete(t.mailSeen).where(eq(t.mailSeen.messageId, '<i20@quillmere.example>')).run();
    db.insert(t.mailSeen).values([...rows, pending('i20', 50, 7)]).run();
    await run(db, box, { pdfText: async () => invoiceRows() });
    await run(db, box, { pdfText: async () => invoiceRows() });
    expect(kept(db, '<i20@quillmere.example>').kind).toBe('invoice');
    expect(db.select().from(t.copy).where(eq(t.copy.source, 'invoice')).all()).toHaveLength(3);
    for (const id of ['<old0@quillmere.example>', '<gone0@quillmere.example>']) {
      expect(kept(db, id)).toMatchObject({ kind: 'reread_refused' });
      expect(JSON.parse(kept(db, id).parsedJson!).tries).toBe(2);
    }
    expect(JSON.parse(kept(db, '<gone0@quillmere.example>').authJson!).reason).toMatch(/no longer in the mailbox/);
  });

  it('an invoice row with an EAN no book has is never matched by its title to a book with another ISBN (PR #14 review)', async () => {
    const db = world();
    db.update(t.order).set({ status: 'quoted' }).where(eq(t.order.id, 'o_nov')).run();
    const rows = (): MediaOutcome => ({ id: 'j', ok: true, kind: 'pdf.text', pages: 1, truncated: false, rows: [
      ['9781111111111', 'The Long Tide of Markets', '1 ST', '19.90', '19.90 CHF', '2.6 %'], ['Total', '19.90 CHF'],
    ] });
    await run(db, fakeBox([{ uid: 1, raw: await invoice('i21') }]), { pdfText: async () => rows() });
    expect(db.select().from(t.copy).where(eq(t.copy.source, 'invoice')).all()).toEqual([]);
    expect(lines(db).b_tide!.state).toBe('planned');
    expect(unmatchedLines(db).map((l) => l.ean)).toEqual(['9781111111111']);
  });

  it('an invoice row whose EAN is no ISBN (a toy, a game) is never a book, even with a book\'s title (PR #14 review, round 2)', async () => {
    const db = world();
    db.update(t.order).set({ status: 'quoted' }).where(eq(t.order.id, 'o_nov')).run();
    const rows = (): MediaOutcome => ({ id: 'j', ok: true, kind: 'pdf.text', pages: 1, truncated: false, rows: [
      ['4001234567890', 'The Long Tide of Markets', '1 ST', '19.90', '19.90 CHF', '2.6 %'], ['Total', '19.90 CHF'],
    ] });
    await run(db, fakeBox([{ uid: 1, raw: await invoice('i23') }]), { pdfText: async () => rows() });
    expect(db.select().from(t.copy).where(eq(t.copy.source, 'invoice')).all()).toEqual([]);
    expect(lines(db).b_tide!.state).toBe('planned');
    expect(unmatchedLines(db)).toEqual([{ mail: '<i23@quillmere.example>', kind: 'invoice', index: 0, title: 'The Long Tide of Markets', author: null, ean: null }]);
  });

  it('a waiting mail given up by the re-read (its folder renumbered) is read in full when the window meets it later (PR #14 review, round 2)', async () => {
    const db = world();
    await run(db, fakeBox([{ uid: 4, raw: await invoice('i24') }]), { pdfText: async () => { throw new MediaUnavailable(); } });
    await run(db, fakeBox([], 8), { pdfText: async () => invoiceRows() });
    expect(kept(db, '<i24@quillmere.example>').kind).toBe('reread_refused');
    await run(db, fakeBox([{ uid: 5, raw: await invoice('i24') }], 8), { pdfText: async () => invoiceRows() });
    expect(kept(db, '<i24@quillmere.example>').kind).toBe('invoice');
    expect(db.select().from(t.copy).where(eq(t.copy.source, 'invoice')).all()).toHaveLength(3);
  });

  it('an invoice number too long to keep (12 digits) fails closed as an unknown layout, never "other" (PR #14 review)', async () => {
    const db = world();
    await run(db, fakeBox([{ uid: 1, raw: await invoice('i22', '990011223344') }]), { pdfText: async () => invoiceRows() });
    expect(kept(db, '<i22@quillmere.example>')).toMatchObject({ kind: 'unknown_layout' });
    expect(JSON.parse(kept(db, '<i22@quillmere.example>').parsedJson!)).toMatchObject({ expected: 'invoice', reason: 'its order or invoice number is not 4 to 11 digits' });
    expect(db.select().from(t.copy).where(eq(t.copy.source, 'invoice')).all()).toEqual([]);
  });

  it('an unknown layout keeps its version stamp and is read again only under another parser version', async () => {
    const db = world();
    const box = fakeBox([{ uid: 2, raw: await signed(message({ id: 'u1', subject: 'Re: Book order, November 2026', body: 'Dear customer,\nSpecial offer: CHF 5.00 off' })) }]);
    await run(db, box);
    expect(kept(db, '<u1@quillmere.example>')).toMatchObject({ kind: 'unknown_layout', parserVersion: `${PARSER_VERSION}/${PARSERS.quote}` });
    box.read.length = 0;
    await run(db, box);
    expect(box.read).toEqual([]);
    db.update(t.mailSeen).set({ parserVersion: 'm3d-0/quote-0' }).where(eq(t.mailSeen.messageId, '<u1@quillmere.example>')).run();
    await run(db, box);
    expect(box.read).toEqual([2]);
  });

  it('a mail M3 (c) read before the parsers existed ("unclassified") is read again and applied', async () => {
    const db = world();
    const mail = await signed(message({ id: 'old1', subject: 'Re: Book order, November 2026', body: QUOTE }));
    db.insert(t.mailSeen).values({ messageId: '<old1@quillmere.example>', kind: 'unclassified', parsedJson: JSON.stringify({ uid: 9, uidValidity: 7 }), parserVersion: 'm3c-3', seenAt: NOW, authJson: '{}', accepted: 1 }).run();
    const box = fakeBox([{ uid: 9, raw: mail }]);
    // The cursor is past it, under the same settings: only the re-read path can find it.
    const configKey = createHash('sha256').update(JSON.stringify([PARSER_VERSION, [...SEALERS].sort(), [...HOUSEHOLD].sort(), [['quillmere', CONNECTORS.get('quillmere')!.version]]])).digest('hex');
    db.insert(t.mailCursor).values({ folder: 'INBOX', uidValidity: 7, lastUid: 9, configKey, updatedAt: NOW }).run();
    expect((await run(db, box)).detail).toBe('0 new: 0 verified, 0 not verified, 0 seen before; 1 read again');
    expect(kept(db, '<old1@quillmere.example>').kind).toBe('bookshop_quote');
    expect(order(db).status).toBe('quoted');
  });
});

describe('the delivery address never reaches a kept field', () => {
  it('a quote whose line holds the sealed address keeps that field empty', async () => {
    const db = world();
    seal(db, Buffer.from(TEST_SEALING_KEY, 'base64'), SEALED.deliveryAddress, 'A Reader\nSomewhere Street 1\n8000 Exampletown');
    const body = '- Okafor, Value Beyond Price, CHF 18.90, to Somewhere Street 1';
    await run(db, fakeBox([{ uid: 1, raw: await signed(message({ id: 'a1', subject: 'Re: Book order, November 2026', body })) }]), {}, { ...CFG, sealingKey: { value: TEST_SEALING_KEY } });
    const k = kept(db, '<a1@quillmere.example>').parsedJson!;
    expect(JSON.parse(k)).toMatchObject({ lines: [{ title: 'Value Beyond Price', delivery: null, bookId: 'b_value' }] });
    expect(k).not.toMatch(/Somewhere/);
  });

  it('the generated ids pass safeField too: a Message-ID with a long number is not kept as a field (the row is still keyed by it)', async () => {
    const db = world();
    await run(db, fakeBox([{ uid: 1, raw: await signed(message({ id: '4111111111111111', subject: 'Re: Book order, November 2026', body: QUOTE })) }]));
    const row = kept(db, '<4111111111111111@quillmere.example>');
    expect(JSON.parse(row.parsedJson!)).toMatchObject({ messageId: null, inReplyTo: null });
  });

  it('openVerified is the one way in: the same checks for a mail read the first time and again', async () => {
    const good = await signed(message({ id: 'v1' }));
    const o = { shops: SHOPS, arcSealers: SEALERS, recipients: HOUSEHOLD, resolver, address: [] };
    expect(await openVerified(good, o)).toMatchObject({ ok: true });
    expect(await openVerified(Buffer.concat([Buffer.from('Subject: forged\r\n'), good]), o)).toMatchObject({ ok: false });
    expect(await openVerified(Buffer.from(good.toString().replace('To: shelf.household@example.org', 'To: stranger@example.com')), o)).toMatchObject({ ok: false });
  });
});

describe('philobiblos#15: the round-3 nits', () => {
  it('a shop line whose EAN is no ISBN is notBook, and never matches a book by its title', async () => {
    const text = 'Buch The Long Tide of Markets von Mira Okafor EAN: 4001234567890 | Fr. 19.90\nBuch The Quiet Hedgehog von Lena Paulsen EAN: 9780000000019 | Fr. 16.90';
    const p = parseShop('online_order', '4400123', text, []);
    if (p.kind !== 'online_order') throw new Error('an online order');
    expect(p.lines.map((l) => l.notBook ?? false)).toEqual([true, false]);
    const db = world();
    await run(db, fakeBox([{ uid: 1, raw: await signed(message({ id: 'oo15', from: 'shop@quillmere.example', subject: 'Ihre Quillmere Bestellung (4400123)', body: text })) }]));
    expect(JSON.parse(kept(db, '<oo15@quillmere.example>').parsedJson!)).toMatchObject({ lines: [{ bookId: null, notBook: true }, { bookId: 'b_hedgehog' }] });
  });

  it('classify strips format characters: a zero-width character in or after the number does not hide it', () => {
    expect(classify('x@quillmere.example', 'Ihre Quillmere-Rechnung Nr. 1234​5678')).toEqual({ kind: 'invoice', number: '12345678' });
    expect(classify('x@quillmere.example', 'Ihre Quillmere-Rechnung Nr. 12345678​')).toEqual({ kind: 'invoice', number: '12345678' });
    expect(classify('x@quillmere.example', 'Wir bearbeiten Ihre Bestellung (4400⁠124)')).toEqual({ kind: 'click_collect', number: '4400124' });
  });

  it('an invoice row read whole but for its EAN is kept as eanUnreadable (with or without a Total), counted, never matched', async () => {
    const spaced = ['978 0000 000002', 'The Long Tide of Markets', '1 ST', '19.90', '19.90 CHF', '2.6 %'];
    const ok = ['9780000000019', 'The Quiet Hedgehog', '1 ST', '16.90', '16.90 CHF', '2.6 %'];
    for (const rows of [[spaced, ok], [spaced, ok, ['Total', '36.80 CHF']]]) {
      expect(parseInvoice('99001122', rows, false, [])).toMatchObject({ kind: 'invoice', totalC: 3680, lines: [
        { ean: null, title: 'The Long Tide of Markets', totalC: 1990, eanUnreadable: true }, { ean: '9780000000019' },
      ] });
    }
    // A whole row with no leading digits (a gift card, say) is no book row: not a line, not in the sum (PR #16 review).
    expect(parseInvoice('1', [ok, ['Gutschein Geschenkkarte', '1 ST', '50.00', '50.00 CHF', '0 %']], false, [])).toMatchObject({ kind: 'invoice', totalC: 1690, lines: [{ ean: '9780000000019' }] });
    // A row that is not a book row (no ST, no CHF, no VAT) is still left alone.
    expect(parseInvoice('1', [['Kundennummer', '5550001'], ok], false, [])).toMatchObject({ kind: 'invoice', lines: [{ ean: '9780000000019' }] });
    const db = world();
    db.update(t.order).set({ status: 'quoted' }).where(eq(t.order.id, 'o_nov')).run();
    await run(db, fakeBox([{ uid: 1, raw: await invoice('i15') }]), { pdfText: async () => ({ id: 'j', ok: true, kind: 'pdf.text', pages: 1, truncated: false, rows: [spaced, ok] }) });
    // The title is a book's, but the EAN could not be read: no copy of it, the row to the Inbox.
    expect(db.select().from(t.copy).where(eq(t.copy.source, 'invoice')).all().map((c) => c.bookId)).toEqual(['b_hedgehog']);
    expect(lines(db).b_tide!.state).toBe('planned');
    expect(unmatchedLines(db).map((l) => l.title)).toEqual(['The Long Tide of Markets']);
  });
});
