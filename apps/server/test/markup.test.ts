// schema.org markup (philobiblos#27, slice 3): Order and Invoice JSON-LD in a bookshop's signed mail, read generically for
// any shop whose connector says it sends it, and Product JSON-LD on a shop's search page as a price lookup. The markup
// is hostile input like the rest of the mail: bounded, parsed as data (never followed, never run, never stored), held to
// the connector's currency, and failing closed. Every shop, book, person and number here is invented. Each guard has a
// test that fails when the guard is removed.
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { checkConnectorShape } from '@philobiblos/contracts/connector';
import { allows } from '../src/connectors/enabled';
import { readConnector, registry } from '../src/connectors/load';
import { openDb, type Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { refreshMail } from '../src/mail/job';
import { mailRules, parseMarkup, PARSERS } from '../src/mail/parse';
import { openVerified } from '../src/mail/read';
import { EgressError, type Egress } from '../src/net/egress';
import { markupPrices, pickProduct } from '../src/books/prices';
import { MARKUP_LIMITS, ldBlocks, schemaNodes } from '../src/schemaorg/jsonld';
import { CFG, CONNECTORS, HOUSEHOLD, enableShop, fakeBox, message, resolver, signed } from './mailkit';

const LARKSPUR = CONNECTORS.get('larkspur')!.connector!;
const RULES = mailRules(LARKSPUR);
const ld = (v: unknown) => `<script type="application/ld+json">${JSON.stringify(v)}</script>`;
const CTX = 'https://schema.org';
const offer = (o: { name?: string; author?: unknown; isbn?: string; price?: unknown; currency?: string | null; qty?: number; type?: string } = {}) => ({
  '@type': 'Offer',
  itemOffered: { '@type': o.type ?? 'Book', name: o.name ?? 'The Long Tide of Markets', author: o.author ?? { '@type': 'Person', name: 'Mira Okafor' }, ...(o.isbn === undefined ? { isbn: '978-0-00-000000-2' } : o.isbn ? { isbn: o.isbn } : {}) },
  price: o.price ?? '19.90',
  ...(o.currency === null ? {} : { priceCurrency: o.currency ?? 'EUR' }),
  ...(o.qty !== undefined ? { eligibleQuantity: { '@type': 'QuantitativeValue', value: o.qty } } : {}),
});
const order = (offers: unknown[], more: Record<string, unknown> = {}) => ({ '@context': CTX, '@type': 'Order', orderNumber: 'LK-20417', merchant: { '@type': 'Organization', name: 'Larkspur Books' }, acceptedOffer: offers, ...more });
const invoice = (offers: unknown[], more: Record<string, unknown> = {}) => ({ '@context': CTX, '@type': 'Invoice', confirmationNumber: 'INV-88120', totalPaymentDue: { '@type': 'MonetaryAmount', value: '19.90', currency: 'EUR' }, referencesOrder: order(offers), ...more });
const parse = (html: string, address: string[] = []) => parseMarkup(ldBlocks(html), address, RULES);

describe('the markup in a page: bounded and linear', () => {
  it('a letter whose lowercase is longer (U+0130) before a block does not shift what is read', () => {
    expect(ldBlocks(`<p>${'İ'.repeat(5)}stanbul</p>${ld({ a: 1 })}`)).toEqual(['{"a":1}']);
  });

  it('only JSON-LD script blocks are read, whatever the case and quoting of their type', () => {
    const html = `<p>Hi</p><script>var a = 1</script><SCRIPT TYPE='application/ld+json'>{"a":1}</SCRIPT><script type=application/ld+json >{"b":2}</script><script type="text/json">{"c":3}</script>`;
    expect(ldBlocks(html)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('at most a few blocks, each of bounded size; an unclosed block ends the reading', () => {
    expect(ldBlocks(ld({ a: 1 }).repeat(MARKUP_LIMITS.blocks + 5))).toHaveLength(MARKUP_LIMITS.blocks);
    expect(ldBlocks(`<script type="application/ld+json">${'x'.repeat(MARKUP_LIMITS.blockBytes + 1)}</script>${ld({ a: 1 })}`)).toEqual(['{"a":1}']);
    expect(ldBlocks('<script type="application/ld+json">{"a":1}')).toEqual([]);
  });

  it('linear on hostile pages: a megabyte of unclosed tags and script openings', () => {
    const t0 = Date.now();
    ldBlocks('<script type="application/ld+json"'.repeat(30_000));
    ldBlocks('<'.repeat(1 << 20));
    ldBlocks(`${'<script type="application/ld+json">'.repeat(25_000)}`);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('only schema.org nodes; @graph and lists are opened; anything else is not markup', () => {
    const nodes = schemaNodes([
      JSON.stringify({ '@context': 'http://schema.org/', '@type': 'Order', orderNumber: '1' }),
      JSON.stringify({ '@context': 'https://evil.example/vocab', '@type': 'Order', orderNumber: '2' }),
      JSON.stringify({ '@context': CTX, '@graph': [{ '@type': 'Invoice' }, { '@type': 'Thing' }] }),
      JSON.stringify([{ '@context': CTX, '@type': 'Product' }]),
      '{not json',
      JSON.stringify({ '@type': 'Order', orderNumber: '3' }),
    ]);
    expect(nodes.map((n) => n['@type'])).toEqual(['Order', 'Invoice', 'Thing', 'Product']);
  });

  it('a nesting or a node count beyond the limits is cut, never followed', () => {
    const deep = `{"@context":"${CTX}","@graph":${'['.repeat(100_000)}{"@type":"Thing"}${']'.repeat(100_000)}}`;
    expect(() => schemaNodes([deep])).not.toThrow();
    expect(schemaNodes([deep])).toEqual([]);
    const many = Array.from({ length: MARKUP_LIMITS.nodes * 3 }, () => ({ '@type': 'Thing' }));
    expect(schemaNodes([JSON.stringify({ '@context': CTX, '@graph': many })]).length).toBeLessThanOrEqual(MARKUP_LIMITS.nodes);
  });
});

describe('Order markup', () => {
  it('reads the order number and each book: title, first author, ISBN, quantity and price in hundredths', () => {
    const p = parse(ld(order([offer(), offer({ name: 'A Map of Small Rivers', author: 'Tomas Reed', isbn: '9780000000026', price: 22.5, qty: 2 })])));
    expect(p).toEqual({
      kind: 'online_order', parser: PARSERS.markupOrder, orderNumber: 'LK-20417',
      lines: [
        { title: 'The Long Tide of Markets', author: 'Mira Okafor', ean: '9780000000002', qty: 1, priceC: 1990 },
        { title: 'A Map of Small Rivers', author: 'Tomas Reed', ean: '9780000000026', qty: 2, priceC: 2250 },
      ],
    });
  });

  it('schema.org\'s other spellings of a type and of a list (orderedItem, a single offer, priceSpecification)', () => {
    const one = { ...offer(), price: undefined, priceCurrency: undefined, priceSpecification: { '@type': 'PriceSpecification', price: '19.90', priceCurrency: 'EUR' } };
    expect(parse(ld({ ...order([]), '@type': 'schema:Order', acceptedOffer: one }))).toMatchObject({ kind: 'online_order', lines: [{ priceC: 1990 }] });
    expect(parse(ld({ ...order([]), '@type': ['Order'], acceptedOffer: undefined, orderedItem: [{ '@type': 'OrderItem', orderQuantity: 3, orderedItem: offer().itemOffered, price: '9.00', priceCurrency: 'EUR' }] })))
      .toMatchObject({ kind: 'online_order', lines: [{ qty: 3, priceC: 900 }] });
  });

  it('a product that is not a book is kept as a line that is no book (to the Inbox, skip only)', () => {
    expect(parse(ld(order([offer({ type: 'Product', name: 'Wooden Train Set', isbn: '', author: null as unknown as string })]))))
      .toMatchObject({ kind: 'online_order', lines: [{ title: 'Wooden Train Set', notBook: true }] });
    expect(parse(ld(order([offer({ type: 'Product', isbn: '4001234567890' })])))).toMatchObject({ lines: [{ notBook: true }] });
  });

  it.each([
    ['a price in another currency', [offer({ currency: 'GBP' })], /another currency/],
    ['a price with no currency', [offer({ currency: null })], /currency/],
    ['a price Philobiblos cannot read', [offer({ price: '19,90' })], /price/],
    ['a price written as an exponent', [offer({ price: '1e3' })], /price/],
    ['a negative price', [offer({ price: -5 })], /price/],
    ['a book without a price', [{ ...offer(), price: undefined }], /price/],
    ['a book without a title', [offer({ name: '' })], /title/],
    ['an ISBN that is not 13 digits', [offer({ isbn: '12345' })], /ISBN/],
    ['a quantity that is no count', [offer({ qty: 0 })], /quantity/],
    ['no books', [], /no articles/],
  ])('%s: an unknown layout, which changes nothing', (_what, offers, reason) => {
    const p = parse(ld(order(offers)));
    expect(p).toMatchObject({ kind: 'unknown_layout', parser: PARSERS.markupOrder, expected: 'online_order' });
    expect((p as { reason: string }).reason).toMatch(reason);
  });

  it('an order that lists its books both as offers and as items names each book once', () => {
    const p = parse(ld(order([offer()], { orderedItem: [{ '@type': 'OrderItem', orderQuantity: 1, orderedItem: offer().itemOffered }] })));
    expect(p).toMatchObject({ kind: 'online_order', lines: [{ title: 'The Long Tide of Markets' }] });
    expect((p as { lines: unknown[] }).lines).toHaveLength(1);
  });

  it.each(['OrderCancelled', 'https://schema.org/OrderReturned', 'OrderInTransit', 'OrderDelivered'])('an order mail with status %s is no new order (it stays "other")', (status) => {
    expect(parse(ld(order([offer()], { orderStatus: status })))).toBeNull();
  });

  it.each(['OrderProcessing', 'http://schema.org/OrderPaymentDue'])('an order mail with status %s is the order', (status) => {
    expect(parse(ld(order([offer()], { orderStatus: status })))).toMatchObject({ kind: 'online_order' });
  });

  it('two orders in one mail, or too many books: an unknown layout', () => {
    expect(parse(ld(order([offer()])) + ld(order([offer()])))).toMatchObject({ kind: 'unknown_layout', reason: expect.stringMatching(/more than one/) });
    expect(parse(ld(order(Array.from({ length: 101 }, () => offer()))))).toMatchObject({ kind: 'unknown_layout', reason: 'too many books' });
  });

  it('no Order or Invoice markup: nothing to read (the mail stays "other")', () => {
    expect(parse(ld({ '@context': CTX, '@type': 'EmailMessage', description: 'Your parcel' }))).toBeNull();
    expect(parse('<p>Thank you</p>')).toBeNull();
  });

  it('every field passes the same filter as the text\'s: the delivery address and long digit runs are dropped', () => {
    const p = parse(ld(order([offer({ name: 'Delivered to Somewhere Street 1' }), offer({ name: 'Card 4111 1111 1111 1111' })], { orderNumber: '4111111111111111' })), ['somewhere strasse 1']);
    expect(p).toMatchObject({ kind: 'online_order', orderNumber: null, lines: [{ title: null }, { title: null }] });
  });
});

describe('Invoice markup', () => {
  it('its number, its books (a copy per unit), and its total, which must be their sum', () => {
    const p = parse(ld(invoice([offer(), offer({ name: 'A Map of Small Rivers', isbn: '9780000000026', price: '5.00', qty: 2 })], { totalPaymentDue: { '@type': 'MonetaryAmount', value: 29.9, currency: 'EUR' } })));
    expect(p).toEqual({
      kind: 'invoice', parser: PARSERS.markupInvoice, invoiceNumber: 'INV-88120', totalC: 2990,
      lines: [
        { title: 'The Long Tide of Markets', author: 'Mira Okafor', ean: '9780000000002', qty: 1, priceC: 1990, discountPct: null, totalC: 1990, vatPct: null },
        { title: 'A Map of Small Rivers', author: 'Mira Okafor', ean: '9780000000026', qty: 2, priceC: 500, discountPct: null, totalC: 1000, vatPct: null },
      ],
    });
  });

  it.each([
    ['a stated total that is not the sum', { totalPaymentDue: { '@type': 'MonetaryAmount', value: '99.00', currency: 'EUR' } }, /not the sum/],
    ['a total in another currency', { totalPaymentDue: { '@type': 'MonetaryAmount', value: '19.90', currency: 'USD' } }, /another currency/],
    ['no invoice number (the same invoice again would count twice)', { confirmationNumber: undefined }, /number/],
    ['an invoice number of other characters', { confirmationNumber: 'INV 88120; DROP' }, /number/],
  ])('%s: an unknown layout', (_what, more, reason) => {
    const p = parse(ld(invoice([offer()], more)));
    expect(p).toMatchObject({ kind: 'unknown_layout', parser: PARSERS.markupInvoice, expected: 'invoice' });
    expect((p as { reason: string }).reason).toMatch(reason);
  });

  it('a number the field filter would drop (a run of 12 digits) is no number: refused, never counted twice unseen', () => {
    expect(parse(ld(invoice([offer()], { confirmationNumber: 'INV-123456789012' })))).toMatchObject({ kind: 'unknown_layout', reason: expect.stringMatching(/number/) });
  });

  it('an Invoice and the Order it references by @id, side by side in @graph, are one document', () => {
    const o = { ...order([offer()]), '@context': undefined, '@id': '#order' };
    const p = parse(ld({ '@context': CTX, '@graph': [{ ...invoice([]), '@context': undefined, referencesOrder: { '@id': '#order' } }, o] }));
    expect(p).toMatchObject({ kind: 'invoice', invoiceNumber: 'INV-88120', lines: [{ title: 'The Long Tide of Markets' }] });
    // An @id that names nothing in the mail is nothing (no lookup): no articles.
    expect(parse(ld({ ...invoice([]), referencesOrder: { '@id': 'https://evil.example/order' } }))).toMatchObject({ kind: 'unknown_layout', reason: 'no articles' });
  });

  it('the author stays on an invoice\'s line: without an ISBN, a book is matched by title and author', () => {
    expect(parse(ld(invoice([offer({ isbn: '' })])))).toMatchObject({ kind: 'invoice', lines: [{ author: 'Mira Okafor', ean: null }] });
  });

  it('its identifier stands for a confirmation number', () => {
    expect(parse(ld(invoice([offer()], { confirmationNumber: undefined, identifier: 'INV-88121' })))).toMatchObject({ kind: 'invoice', invoiceNumber: 'INV-88121' });
  });
});

describe('the connector says whether its markup counts', () => {
  const quillmere = CONNECTORS.get('quillmere')!.connector!;

  it('a connector without `mail.markup` never reads it; Settings says which do', () => {
    expect(parseMarkup(ldBlocks(ld(order([offer({ currency: 'CHF' })]))), [], mailRules(quillmere))).toBeNull();
    expect(allows(LARKSPUR).markup).toBe(true);
    expect(allows(quillmere).markup).toBe(false);
  });

  it('the schema: `markup` is true or false; a mail connector needs no words of its own; a jsonld lookup is its URL alone', () => {
    const base = { schema: 1, id: 'x-shop', name: 'X', locale: { currency: 'EUR', language: 'en' }, money: { before: ['EUR'], after: ['EUR'] } };
    expect(checkConnectorShape({ ...base, mail: { domains: ['x.example'], markup: true } }).ok).toBe(true);
    expect(checkConnectorShape({ ...base, mail: { domains: ['x.example'], markup: 'yes' } }).ok).toBe(false);
    // A connector with layouts of its own still says where the household's quoted request begins (never read).
    const q = CONNECTORS.get('quillmere')!.connector!.mail!;
    const words = { reply: q.reply, summary: q.summary, unavailable: q.unavailable };
    for (const layout of ['quote', 'shop', 'invoice'] as const) {
      const mail = { domains: ['quillmere.example'], [layout]: q[layout] };
      expect(checkConnectorShape({ ...base, mail: { ...mail, ...words } }).ok, layout).toBe(true);
      for (const k of ['reply', 'summary', 'unavailable'] as const) {
        const { [k]: _gone, ...rest } = words;
        expect(checkConnectorShape({ ...base, mail: { ...mail, ...rest } }).ok, `${layout} without ${k}`).toBe(false);
      }
    }
    expect(checkConnectorShape({ ...base, prices: { kind: 'jsonld', url: 'https://x.example/s?q={query}' } }).ok).toBe(true);
    expect(checkConnectorShape({ ...base, prices: { kind: 'jsonld', url: 'https://x.example/s?q={query}', follow_links: true } }).ok).toBe(false);
    expect(checkConnectorShape({ ...base, prices: { kind: 'jsonld', url: 'http://x.example/s?q={query}' } }).ok).toBe(false);
    expect(checkConnectorShape({ ...base, prices: { kind: 'jsonld', url: 'https://x.example/s?q={query}', print_formats: ['Buch'] } }).ok).toBe(false);
    expect(checkConnectorShape({ ...base, prices: { kind: 'script', url: 'https://x.example/s?q={query}' } }).ok).toBe(false);
  });

  it('the markup example that ships is sound', () => {
    expect(CONNECTORS.get('larkspur')).toMatchObject({ problem: null, origin: 'builtin' });
    expect(readConnector(Buffer.from('schema: 1\n'), 'larkspur')).toHaveProperty('problem');
  });
});

describe('through the mail job: only a verified mail of an enabled connector', () => {
  function world(): Db {
    const db = openDb(':memory:');
    db.insert(t.person).values({ id: 'p_alex', name: 'Alex', role: 'admin', handle: 'alex' }).run();
    const now = new Date().toISOString();
    db.insert(t.book).values({ id: 'b_tide', title: 'The Long Tide of Markets', authorsJson: '["Mira Okafor"]', audience: 'adult', normKey: 'tide', isbn13: '9780000000002', createdAt: now }).run();
    return enableShop(db, 'larkspur');
  }
  const mail = (id: string, html: string, from = 'Larkspur Books <orders@larkspur.example>') =>
    signed(message({ id, from, subject: 'Your Larkspur receipt', html: true, body: `<p>Thank you for your order.</p>${html}` }), 'larkspur.example');
  const run = (db: Db, raws: Buffer[]) => refreshMail(db, CFG, { open: async () => fakeBox(raws.map((raw, i) => ({ uid: i + 1, raw }))), resolver });
  const kept = (db: Db, id: string) => db.select().from(t.mailSeen).where(eq(t.mailSeen.messageId, `<${id}@quillmere.example>`)).get()!;

  it('an order: its lines matched and kept; the markup itself never stored', async () => {
    const db = world();
    await run(db, [await mail('o1', ld(order([offer()], { description: 'a secret note for the household' })))]);
    const row = kept(db, 'o1');
    expect(row).toMatchObject({ kind: 'online_order', accepted: 1, parserVersion: `m3d-1/${PARSERS.markupOrder}` });
    expect(JSON.parse(row.parsedJson!)).toMatchObject({ orderNumber: 'LK-20417', lines: [{ bookId: 'b_tide', priceC: 1990 }] });
    expect(JSON.stringify(row)).not.toContain('secret note');
    expect(JSON.stringify(row)).not.toContain('@context');
  });

  it('an invoice: a copy per unit, owned; the same invoice number again counts once', async () => {
    const db = world();
    const inv = ld(invoice([offer({ qty: 2 })], { totalPaymentDue: { '@type': 'MonetaryAmount', value: '39.80', currency: 'EUR' } }));
    await run(db, [await mail('i1', inv), await mail('i2', inv)]);
    expect(kept(db, 'i1')).toMatchObject({ kind: 'invoice' });
    expect(db.select().from(t.copy).where(eq(t.copy.source, 'invoice')).all()).toHaveLength(2);
    expect(JSON.parse(kept(db, 'i2').parsedJson!)).toMatchObject({ duplicateOf: '<i1@quillmere.example>' });
  });

  it('another shop\'s invoice with the same number is no resend: each shop\'s numbers are its own', async () => {
    const db = world();
    // An invoice of the example shop, read earlier, numbered alike.
    db.insert(t.mailSeen).values({ messageId: '<q-inv@quillmere.example>', kind: 'invoice', parserVersion: 'm3d-1/invoice-1', seenAt: new Date().toISOString(), accepted: 1,
      authJson: JSON.stringify({ accepted: true, connector: 'quillmere' }), parsedJson: JSON.stringify({ invoiceNumber: 'INV-88120', lines: [] }) }).run();
    await run(db, [await mail('i3', ld(invoice([offer()])))]);
    expect(db.select().from(t.copy).where(eq(t.copy.source, 'invoice')).all()).toHaveLength(1);
  });

  it('a mail not verified (signed by another key, or another sender) changes nothing, whatever its markup', async () => {
    const db = world();
    const forged = await signed(message({ id: 'f1', from: 'Larkspur Books <orders@larkspur.example>', subject: 'Receipt', html: true, body: ld(invoice([offer()])) }), 'evil.example');
    await run(db, [forged]);
    expect(db.select().from(t.copy).all()).toEqual([]);
    expect(db.select().from(t.mailSeen).all().every((r) => r.accepted === 0)).toBe(true);
  });

  it('the connector turned off: its markup counts for nothing', async () => {
    const db = world();
    db.delete(t.connectorEnabled).run();
    expect(await run(db, [await mail('o2', ld(invoice([offer()])))])).toMatchObject({ status: 'blocked' });
    expect(db.select().from(t.copy).all()).toEqual([]);
  });

  it('markup in a mail whose layout the connector knows (its quote sender) never replaces that parser', async () => {
    // The example shop with its markup counting too, as a household's own connector might say.
    const q = CONNECTORS.get('quillmere')!;
    const reg = registry([{ ...q, connector: { ...q.connector!, mail: { ...q.connector!.mail!, markup: true } } }]);
    const db = openDb(':memory:');
    db.insert(t.person).values({ id: 'p_alex', name: 'Alex', role: 'admin', handle: 'alex' }).run();
    enableShop(db, 'quillmere');
    const raw = await signed(message({ id: 'q1', subject: 'Re: Book order', html: true, body: `<p>Author: Mira Okafor / Title: The Long Tide of Markets / ISBN: 9780000000002 / Price: CHF 19.90</p>${ld(invoice([offer({ currency: 'CHF' })]))}` }));
    await refreshMail(db, { ...CFG, connectors: reg }, { open: async () => fakeBox([{ uid: 1, raw }]), resolver });
    expect(kept(db, 'q1').kind).toBe('bookshop_quote');
    expect(db.select().from(t.copy).all()).toEqual([]);
    // The same markup in a mail none of its layouts knows does count.
    const other = await signed(message({ id: 'q2', from: 'Quillmere Books <news@quillmere.example>', subject: 'Your receipt', html: true, body: ld(invoice([offer({ currency: 'CHF' })], { totalPaymentDue: { '@type': 'MonetaryAmount', value: '19.90', currency: 'CHF' } })) }));
    await refreshMail(db, { ...CFG, connectors: reg }, { open: async () => fakeBox([{ uid: 1, raw }, { uid: 2, raw: other }]), resolver });
    expect(kept(db, 'q2').kind).toBe('invoice');
  });

  it('the parsers see the markup of a verified mail only', async () => {
    const raw = await mail('o3', ld(order([offer()])));
    const shops = [{ id: 'larkspur', domains: LARKSPUR.mail!.domains, dkimDomains: LARKSPUR.mail!.domains }];
    const opened = await openVerified(raw, { shops, arcSealers: [], recipients: HOUSEHOLD, resolver, address: [] });
    expect(opened.ok && opened.mail.markup.length).toBe(1);
  });
});

describe('the jsonld price lookup', () => {
  const product = (o: { name?: string; author?: string; price?: unknown; currency?: string; sku?: string; gtin13?: string; availability?: string; offers?: unknown } = {}) => ({
    '@context': CTX, '@type': 'Book', name: o.name ?? 'The Long Tide of Markets', author: { '@type': 'Person', name: o.author ?? 'Mira Okafor' },
    ...(o.gtin13 ? { gtin13: o.gtin13 } : {}), sku: o.sku ?? 'LK-1001',
    offers: o.offers ?? { '@type': 'Offer', price: o.price ?? '18.50', priceCurrency: o.currency ?? 'EUR', availability: o.availability ?? 'https://schema.org/InStock' },
  });
  const page = (...ps: unknown[]) => `<html><body><h1>Results</h1>${ps.map(ld).join('')}</body></html>`;
  const pick = (html: string, title = 'The Long Tide of Markets', authors = ['Mira Okafor']) => pickProduct(schemaNodes(ldBlocks(html)), title, authors, 'EUR');

  it('the product whose title and author match, its price in the connector\'s currency, and its availability as words', () => {
    expect(pick(page(product({ name: 'Another Book' }), product()))).toEqual({ externalId: 'LK-1001', priceC: 1850, availability: 'in stock' });
    expect(pick(page(product({ availability: 'https://schema.org/PreOrder' })))).toMatchObject({ availability: 'pre-order' });
    expect(pick(page(product({ availability: 'javascript:alert(1)' })))).toMatchObject({ availability: null });
  });

  it('an ItemList of results, an AggregateOffer\'s lowest price; the cheapest of several matches', () => {
    const list = { '@context': CTX, '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', position: 1, item: product({ sku: 'LK-2', price: '21.00' }) }, { '@type': 'ListItem', position: 2, item: product({ sku: 'LK-3', price: '17.00' }) }] };
    expect(pick(page(list))).toMatchObject({ externalId: 'LK-3', priceC: 1700 });
    expect(pick(page(product({ offers: { '@type': 'AggregateOffer', lowPrice: '12.00', priceCurrency: 'EUR' } })))).toMatchObject({ priceC: 1200 });
  });

  it('no match: another title, another author, or only prices in another currency', () => {
    expect(pick(page(product({ name: 'The Long Tide' })))).toBeNull();
    expect(pick(page(product({ author: 'Someone Else' })))).toBeNull();
    expect(pick(page(product({ currency: 'USD' })))).toBeNull();
    expect(pick('<p>no markup</p>')).toBeNull();
  });

  it('an author written "Surname, Given" matches; an e-book or an audiobook is never the price of a printed book', () => {
    expect(pick(page({ ...product(), author: 'Okafor, Mira' }))).toMatchObject({ priceC: 1850 });
    expect(pick(page({ ...product({ sku: 'LK-E', price: '9.99' }), bookFormat: 'https://schema.org/EBook' }, { ...product({ sku: 'LK-A', price: '5.00' }), bookFormat: 'AudiobookFormat' }, { ...product({ sku: 'LK-H', price: '24.00' }), bookFormat: 'https://schema.org/Hardcover' })))
      .toMatchObject({ externalId: 'LK-H', priceC: 2400 });
  });

  it('a price it cannot read is no price; its id is kept only as a short plain token', () => {
    expect(pick(page(product({ price: '18,50' })))).toMatchObject({ priceC: null });
    expect(pick(page(product({ sku: 'https://evil.example/x?<script>' })))).toMatchObject({ externalId: null });
  });

  it('asks the connector\'s URL with the title and first author, through the egress client, and nowhere else', async () => {
    const asked: string[] = [];
    const egress: Egress = {
      async get(url) { asked.push(url); return { status: 200, type: 'text/html', body: Buffer.from(page(product())), url }; },
      post: () => Promise.reject(new EgressError('not-allowed', 'no')), push: () => Promise.reject(new EgressError('not-allowed', 'no')),
    };
    const src = markupPrices('larkspur', { locale: LARKSPUR.locale, prices: LARKSPUR.prices! }, egress);
    expect(await src.find({ title: 'The Long Tide of Markets', authors: ['Mira Okafor'] })).toMatchObject({ priceC: 1850 });
    expect(asked).toEqual(['https://shop.larkspur.example/search?q=The+Long+Tide+of+Markets+Mira+Okafor']);
  });
});

describe('an invoice line from markup is matched with its author', () => {
  it('a title shared with a book by someone else is not that book', async () => {
    const db = openDb(':memory:');
    db.insert(t.person).values({ id: 'p_alex', name: 'Alex', role: 'admin', handle: 'alex' }).run();
    db.insert(t.book).values({ id: 'b_emma', title: 'Emma', authorsJson: '["Ines Varga"]', audience: 'adult', normKey: 'emma', createdAt: new Date().toISOString() }).run();
    enableShop(db, 'larkspur');
    const body = ld(invoice([offer({ name: 'Emma', author: 'Tomas Reed', isbn: '' })]));
    const raw = await signed(message({ id: 'e1', from: 'Larkspur Books <orders@larkspur.example>', subject: 'Invoice', html: true, body }), 'larkspur.example');
    await refreshMail(db, CFG, { open: async () => fakeBox([{ uid: 1, raw }]), resolver });
    expect(db.select().from(t.copy).all()).toEqual([]);
  });
});
