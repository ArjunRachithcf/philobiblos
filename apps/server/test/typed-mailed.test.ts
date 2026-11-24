// An invoice typed in with no number (or for no connector's shop), then mailed by the bookshop (philobiblos#45 item 2):
// nothing de-duplicates it by its number, so the mail waits in the Inbox, "maybe the invoice typed on …", when its books
// and total are those of a recent typed one. Every book, number and amount here is invented. Each rule has a test that
// fails when the rule is changed.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import * as t from '../src/db/schema';
import { InboxError, answerTyped, decide, dismiss, listInbox, mailItemId } from '../src/inbox/inbox';
import { MAYBE_TYPED_DAYS } from '../src/mail/effects';
import { refreshMail } from '../src/mail/job';
import type { MediaOutcome } from '../src/media/client';
import { EntryError, recentEntries, recordEntry, undoEntry } from '../src/orders/entries';
import { createShareToken } from '../src/shares/tokens';
import { ORIGIN, TEST_SEALING_KEY, household, sessionCookie } from './helpers';
import { CFG, fakeBox, message, resolver, signed } from './mailkit';

const NOW = new Date('2026-11-16T10:00:00.000Z');
const DAY = 86_400_000;
function world() {
  const db = household();
  const iso = NOW.toISOString();
  db.update(t.book).set({ isbn13: '9780000000002' }).where(eq(t.book.id, 'b_tide')).run();
  db.insert(t.book).values({ id: 'b_hedgehog', title: 'The Quiet Hedgehog', authorsJson: '["Lena Paulsen"]', isbn13: '9780000000019', audience: 'kids', normKey: 'x', createdAt: iso }).run();
  db.insert(t.order).values({ id: 'o_nov', month: '2026-11', status: 'drafted', estimateC: 5000, createdAt: iso }).run();
  db.insert(t.orderLine).values([
    { orderId: 'o_nov', bookId: 'b_tide', forPerson: 'p_alex', estimateC: 2500 },
    { orderId: 'o_nov', bookId: 'b_hedgehog', forPerson: 'p_kid1', estimateC: 2500 },
  ]).run();
  return db;
}
type W = ReturnType<typeof world>;
const copies = (db: W) => db.select().from(t.copy).all().map((c) => [c.bookId, c.source, c.orderId, c.priceC]).sort();
const order = (db: W) => db.select().from(t.order).where(eq(t.order.id, 'o_nov')).get()!;
const tide = (o: { qty?: number; price?: number } = {}) => ({ isbn: '9780000000002', qty: o.qty ?? 1, price: o.price ?? 1990 });
const hedgehog = (o: { qty?: number; price?: number } = {}) => ({ isbn: '9780000000019', qty: o.qty ?? 1, price: o.price ?? 1200 });
const TIDE_ROW = ['9780000000002', 'The Long Tide of Markets', '1 ST', '19.90', '19.90 CHF', '2.6 %'];
const HEDGEHOG_ROW = ['9780000000019', 'The Quiet Hedgehog', '1 ST', '12.00', '12.00 CHF', '2.6 %'];
const UNPLACED_ROW = ['9780000000026', 'A Map of Small Rivers', '1 ST', '12.00', '12.00 CHF', '2.6 %'];
const typed = (db: W, body: Record<string, unknown> = {}, at = NOW) => recordEntry(db, 'p_alex', { kind: 'invoice', lines: [tide()], ...body }, at);

/** The media worker's rows for the mailed invoice: one copy of The Long Tide of Markets at 19.90, unless told. */
const rows = (r: string[][] = [['9780000000002', 'The Long Tide of Markets', '1 ST', '19.90', '19.90 CHF', '2.6 %']]): MediaOutcome =>
  ({ id: 'j', ok: true, kind: 'pdf.text', pages: 1, truncated: false, rows: [...r, ['Total', `${(r.reduce((n, x) => n + Math.round(parseFloat(x[4]!) * 100), 0) / 100).toFixed(2)} CHF`]] });
const PDF = Buffer.from('%PDF-1.4\n% invented, read only by the fake worker below\n');
async function mailInvoice(db: W, number: string, o: { at?: Date; rows?: string[][]; uid?: number } = {}) {
  const raw = await signed(message({ id: `inv-${number}-${o.uid ?? 1}`, from: 'rechnung@quillmere.example', subject: `Ihre Quillmere-Rechnung Nr. ${number}`, body: 'Guten Tag, Ihre Rechnung finden Sie im Anhang.', pdf: PDF }));
  const at = o.at ?? new Date(NOW.getTime() + 3600_000);
  await refreshMail(db, CFG, { open: async () => fakeBox([{ uid: o.uid ?? 1, raw }]), resolver, pdfText: async () => rows(o.rows), now: () => at });
}
const mailRow = (db: W) => db.select().from(t.mailSeen).where(eq(t.mailSeen.kind, 'invoice')).all().at(-1)!;
const parsed = (db: W) => JSON.parse(mailRow(db).parsedJson!) as Record<string, unknown>;
const items = (db: W, me = 'p_sam') => listInbox(db, me, 'mail').items;
const expectError = (f: () => unknown, cls: typeof InboxError | typeof EntryError, status: number, msg?: RegExp) => {
  let e: unknown;
  try { f(); } catch (x) { e = x; }
  expect(e, 'refused').toBeInstanceOf(cls);
  expect((e as InboxError).status).toBe(status);
  if (msg) expect((e as Error).message).toMatch(msg);
};

describe('a mailed invoice that may be one typed in already: it waits, and changes nothing until a person answers', () => {
  it('typed with no number, then mailed with the same books and total: the mail makes no copies and asks in the Inbox', async () => {
    const db = world();
    const e = typed(db);
    const before = copies(db);
    await mailInvoice(db, '99001122');
    expect(copies(db)).toEqual(before);
    expect(parsed(db)).toMatchObject({ maybeTyped: e.id });
    expect(parsed(db).duplicateOf).toBeUndefined();
    const it = items(db).find((x) => x.kind === 'maybe_typed_invoice')!;
    expect(it).toMatchObject({
      id: mailItemId(mailRow(db).messageId), title: 'Maybe the invoice typed on 16 November 2026',
      mail: { number: '99001122' }, typed: { entryId: e.id, createdAt: NOW.toISOString(), number: null, shop: null, totalC: 1990, by: { id: 'p_alex' } },
      found: [{ index: 0, title: 'The Long Tide of Markets', qty: 1, priceC: 1990, decided: null }],
    });
  });

  it('typed with the same number but no shop, or another shop\'s label (philobiblos#45\'s round-2 case): the same', async () => {
    for (const shop of [undefined, 'Corner Books']) {
      const db = world();
      const e = typed(db, { number: '99001122', ...(shop ? { shop } : {}) });
      await mailInvoice(db, '99001122');
      expect(parsed(db)).toMatchObject({ maybeTyped: e.id });
      expect(copies(db)).toHaveLength(1);
    }
  });

  it('a line of the mail that is no book (a toy: its EAN is no ISBN) is left out of the comparison: still held', async () => {
    const db = world();
    const e = typed(db);
    await mailInvoice(db, '99001122', { rows: [['9780000000002', 'The Long Tide of Markets', '1 ST', '19.90', '19.90 CHF', '2.6 %'], ['4006381333931', 'Wooden Puzzle', '1 ST', '12.00', '12.00 CHF', '8.1 %']] });
    expect(parsed(db)).toMatchObject({ maybeTyped: e.id });
    expect(copies(db)).toHaveLength(1);
    // Not "the typed books and more" (philobiblos#64): the toy is no copy of a book.
    expect(items(db).find((x) => x.kind === 'maybe_typed_invoice')!.typed).not.toHaveProperty('more');
  });

  it('counts as usual when neither holds the other: another total, other books or quantities, another number', async () => {
    const cases: [string, Record<string, unknown>, string[][] | undefined][] = [
      ['another total', { lines: [tide({ price: 1890 })] }, undefined],
      ['another quantity', { lines: [tide({ qty: 2, price: 995 })] }, undefined],
      ['another book instead', { lines: [{ isbn: '9780000000019', qty: 1, price: 1990 }] }, undefined],
      ['another book besides, the mailed one at another price', { lines: [tide({ price: 1890 }), hedgehog()] }, undefined],
      ['the mail holds another book besides, the typed one at another price', { lines: [tide({ price: 1890 })] }, [TIDE_ROW, HEDGEHOG_ROW]],
      ['another number', { number: '99001123' }, undefined],
    ];
    for (const [what, body, r] of cases) {
      const db = world();
      typed(db, body);
      const n = copies(db).length;
      await mailInvoice(db, '99001122', { rows: r });
      expect(parsed(db).maybeTyped, what).toBeUndefined();
      expect(copies(db).length, what).toBe(n + (r ? r.length : 1));
    }
  });

  it(`only a recent one: typed more than ${MAYBE_TYPED_DAYS} days before the mail is read, it counts as usual`, async () => {
    const db = world();
    typed(db);
    await mailInvoice(db, '99001122', { at: new Date(NOW.getTime() + (MAYBE_TYPED_DAYS + 1) * DAY) });
    expect(parsed(db).maybeTyped).toBeUndefined();
    expect(copies(db)).toHaveLength(2);
    const db2 = world();
    const e = typed(db2);
    await mailInvoice(db2, '99001122', { at: new Date(NOW.getTime() + (MAYBE_TYPED_DAYS - 1) * DAY) });
    expect(parsed(db2).maybeTyped).toBe(e.id);
  });

  it('typed for the connector\'s own shop with that number: counted once by its number, as before (no question)', async () => {
    const db = world();
    typed(db, { number: '99001122', shop: 'quillmere' });
    await mailInvoice(db, '99001122');
    expect(parsed(db)).toMatchObject({ duplicateOf: expect.stringMatching(/^entry:/) });
    expect(parsed(db).maybeTyped).toBeUndefined();
  });

  it('a typed one another mail counts as already, or asks about already, is never asked about again', async () => {
    const db = world();
    const e = typed(db);
    await mailInvoice(db, '99001122');
    await mailInvoice(db, '99001133', { uid: 2 });
    const all = db.select().from(t.mailSeen).where(eq(t.mailSeen.kind, 'invoice')).all().map((r) => JSON.parse(r.parsedJson!) as Record<string, unknown>);
    expect(all.map((p) => p.maybeTyped ?? null)).toEqual([e.id, null]);
    expect(copies(db)).toHaveLength(2);
  });
});

describe('the answer: the same invoice (counted once, as typed), or another purchase (the mail counts)', () => {
  it('the same: the mail counts as the typed one; nothing else changes and the item is gone', async () => {
    const db = world();
    const e = typed(db);
    await mailInvoice(db, '99001122');
    const before = copies(db);
    const id = mailItemId(mailRow(db).messageId);
    answerTyped(db, 'p_sam', id, { answer: 'same' }, NOW);
    expect(copies(db)).toEqual(before);
    expect(parsed(db)).toMatchObject({ duplicateOf: `entry:${e.id}` });
    expect(parsed(db).maybeTyped).toBeUndefined();
    expect(items(db).find((x) => x.id === id)).toBeUndefined();
    expect(db.select().from(t.inboxDecision).where(eq(t.inboxDecision.item, id)).all()).toMatchObject([{ idx: -2, decision: 'skipped', personId: 'p_sam' }]);
    // The mail's number now counts with the connector: typed for it again is 409.
    expectError(() => typed(db, { number: '99001122', shop: 'quillmere' }), EntryError, 409);
  });

  it('another purchase: the mail\'s effect now, as if nothing had been typed (copies at the price paid, the order invoiced)', async () => {
    const db = world();
    typed(db, { lines: [tide()] });
    // The typed one delivered the order's line: the mail's copy is one more, of no order.
    await mailInvoice(db, '99001122');
    const id = mailItemId(mailRow(db).messageId);
    answerTyped(db, 'p_sam', id, { answer: 'another' }, NOW);
    expect(copies(db)).toEqual([['b_tide', 'invoice', null, 1990], ['b_tide', 'manual', 'o_nov', 1990]]);
    expect(order(db)).toMatchObject({ status: 'invoiced', invoicedC: 1990 });
    expect(parsed(db).maybeTyped).toBeUndefined();
    expect(parsed(db).duplicateOf).toBeUndefined();
    expect(items(db).find((x) => x.id === id)).toBeUndefined();
    expect(db.select().from(t.inboxDecision).where(eq(t.inboxDecision.item, id)).all()).toMatchObject([{ idx: -2, decision: 'added', personId: 'p_sam' }]);
  });

  it('answered once: a second answer is 409; dismissing it is refused (it must be answered); a bad answer is 400', async () => {
    const db = world();
    typed(db);
    await mailInvoice(db, '99001122');
    const id = mailItemId(mailRow(db).messageId);
    expectError(() => answerTyped(db, 'p_sam', id, { answer: 'maybe' }, NOW), InboxError, 400);
    expectError(() => answerTyped(db, 'p_sam', id, { answer: 'same', extra: 1 }, NOW), InboxError, 400);
    expectError(() => dismiss(db, 'p_sam', id, NOW), InboxError, 409, /same invoice|another purchase/);
    answerTyped(db, 'p_sam', id, { answer: 'same' }, NOW);
    expectError(() => answerTyped(db, 'p_sam', id, { answer: 'another' }, NOW), InboxError, 409);
    expect(copies(db)).toHaveLength(1);
  });

  it('only an item that asks: another mail\'s item is 409, an unknown one 404', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    expectError(() => answerTyped(db, 'p_sam', mailItemId(mailRow(db).messageId), { answer: 'same' }, NOW), InboxError, 409);
    expectError(() => answerTyped(db, 'p_sam', `m_${'0'.repeat(32)}`, { answer: 'same' }, NOW), InboxError, 404);
  });

  it('the typed one cannot be undone while its mail waits for the answer, nor once the mail counts as it', async () => {
    const db = world();
    const e = typed(db);
    await mailInvoice(db, '99001122');
    expectError(() => undoEntry(db, 'p_alex', e.id!, NOW), EntryError, 409, /mail/);
    answerTyped(db, 'p_sam', mailItemId(mailRow(db).messageId), { answer: 'same' }, NOW);
    expectError(() => undoEntry(db, 'p_alex', e.id!, NOW), EntryError, 409, /mail/);
  });
});

describe('POST /inbox/{itemId}/typed', () => {
  let built: BuiltApp;
  let db: W;
  let id: string;
  beforeAll(async () => {
    db = world();
    typed(db);
    await mailInvoice(db, '99001122');
    id = mailItemId(mailRow(db).messageId);
    built = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY }), db);
    await built.app.ready();
  });
  afterAll(() => built.app.close());
  const post = (who: string, payload: unknown, origin = ORIGIN) => built.app.inject({ method: 'POST', url: `/api/inbox/${id}/typed`, payload: JSON.stringify(payload), headers: { cookie: sessionCookie(db, who), origin, 'content-type': 'application/json' } });

  it('a kid has no access; another origin is refused; nothing changes', async () => {
    expect((await post('p_kid1', { answer: 'another' })).statusCode).toBe(403);
    expect((await post('p_sam', { answer: 'another' }, 'https://evil.example')).statusCode).toBe(403);
    expect(parsed(db).maybeTyped).toBeDefined();
    expect(copies(db)).toHaveLength(1);
  });

  it('any adult answers it (the mail is the household\'s), and gets the item as it is now', async () => {
    const res = await post('p_sam', { answer: 'another' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id });
    expect(copies(db)).toHaveLength(2);
    expect((await post('p_sam', { answer: 'same' })).statusCode).toBe(409);
  });
});

// The reverse order (philobiblos#58): the shop's mail counted first, then the same invoice typed or imported. The typed
// one is asked about before it counts: "Is this the invoice that came by mail on …?".
const LATER = new Date(NOW.getTime() + 2 * 3600_000);
const entries = (db: W) => db.select().from(t.orderEntry).all();
const offers = (db: W) => db.select().from(t.bookOffer).all().map((o) => [o.bookId, o.source, o.priceC, o.seenAt]).sort();
const askedOf = (f: () => unknown) => {
  let e: unknown;
  try { f(); } catch (x) { e = x; }
  expect(e, 'asked').toBeInstanceOf(EntryError);
  expect((e as EntryError).status).toBe(409);
  return e as EntryError;
};

describe('an invoice typed or imported after its mail counted: asked about before it counts (philobiblos#58)', () => {
  it('the same books and total as a mail counted lately: 409 with the question and the mail; nothing changes', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    const before = { copies: copies(db), order: order(db), offers: offers(db) };
    const e = askedOf(() => typed(db, {}, LATER));
    expect(e.message).toBe('Is this the invoice that came by mail on 16 November 2026?');
    expect(e.maybeMailed).toEqual({ mail: mailItemId(mailRow(db).messageId), cameOn: '2026-11-16T00:00:00.000Z', number: '99001122', total: 1990 });
    expect({ copies: copies(db), order: order(db), offers: offers(db) }).toEqual(before);
    expect(entries(db)).toHaveLength(0);
  });

  it('a CSV import is asked about alike; a dry run answers the question without asking (200) and changes nothing', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    askedOf(() => recordEntry(db, 'p_alex', { kind: 'invoice', csv: 'isbn,qty,price\n9780000000002,1,19.90\n' }, LATER));
    const dry = typed(db, { dryRun: true }, LATER);
    expect(dry.maybeMailed).toMatchObject({ mail: mailItemId(mailRow(db).messageId), number: '99001122' });
    expect(entries(db)).toHaveLength(0);
    expect(copies(db)).toHaveLength(1);
  });

  it('the same number with no shop or another shop\'s label is asked about; a line that is no book in the mail is left out', async () => {
    for (const shop of [undefined, 'Corner Books']) {
      const db = world();
      await mailInvoice(db, '99001122', { rows: [['9780000000002', 'The Long Tide of Markets', '1 ST', '19.90', '19.90 CHF', '2.6 %'], ['4006381333931', 'Wooden Puzzle', '1 ST', '12.00', '12.00 CHF', '8.1 %']] });
      askedOf(() => typed(db, { number: '99001122', ...(shop ? { shop } : {}) }, LATER));
    }
  });

  it('counts at once when neither holds the other: another total, quantity or book, another number', async () => {
    const cases: [string, Record<string, unknown>, string[][] | undefined][] = [
      ['another total', { lines: [tide({ price: 1890 })] }, undefined],
      ['another quantity', { lines: [tide({ qty: 2, price: 995 })] }, undefined],
      ['another book instead', { lines: [{ isbn: '9780000000019', qty: 1, price: 1990 }] }, undefined],
      ['a book nobody has yet', { lines: [{ title: 'A Map of Small Rivers', qty: 1, price: 1990 }] }, undefined],
      ['another book besides, the mailed one at another price', { lines: [tide({ price: 1890 }), hedgehog()] }, undefined],
      ['the mail holds another book besides, the typed one at another price', { lines: [tide({ price: 1890 })] }, [TIDE_ROW, HEDGEHOG_ROW]],
      ['another number', { number: '99001123' }, undefined],
    ];
    for (const [what, body, r] of cases) {
      const db = world();
      await mailInvoice(db, '99001122', { rows: r });
      const n = copies(db).length;
      const got = typed(db, body, LATER);
      expect(got.id, what).toBeDefined();
      expect(copies(db).length, what).toBeGreaterThan(n);
    }
  });

  it(`only a mail read in the last ${MAYBE_TYPED_DAYS} days; one that waits in the Inbox, or counts as another, is never asked about`, async () => {
    const old = world();
    await mailInvoice(old, '99001122');
    expect(typed(old, {}, new Date(NOW.getTime() + (MAYBE_TYPED_DAYS + 1) * DAY)).id).toBeDefined();
    const recent = world();
    await mailInvoice(recent, '99001122');
    askedOf(() => typed(recent, {}, new Date(NOW.getTime() + (MAYBE_TYPED_DAYS - 1) * DAY)));
    // A mail held as maybe a typed one counts nothing yet; one answered "the same" counts as that one.
    const held = world();
    typed(held);
    await mailInvoice(held, '99001122');
    expect(typed(held, {}, LATER).id).toBeDefined();
    const same = world();
    typed(same);
    await mailInvoice(same, '99001122');
    answerTyped(same, 'p_sam', mailItemId(mailRow(same).messageId), { answer: 'same' }, NOW);
    expect(typed(same, {}, LATER).id).toBeDefined();
    // A mail sent again (duplicateOf the first) is not asked about twice: the first is the one asked about.
    const twice = world();
    await mailInvoice(twice, '99001122');
    await mailInvoice(twice, '99001122', { uid: 2 });
    expect(askedOf(() => typed(twice, {}, LATER)).maybeMailed!.mail).toBe(mailItemId(db0(twice).messageId));
  });

  it('a mail line that named no book when read but was added from the Inbox since counts as that book: asked about', async () => {
    const db = world();
    await mailInvoice(db, '99001122', { rows: [['9780000000002', 'The Long Tide of Markets', '1 ST', '19.90', '19.90 CHF', '2.6 %'], ['9780000000026', 'A Map of Small Rivers', '1 ST', '12.00', '12.00 CHF', '2.6 %']] });
    decide(db, 'p_sam', mailItemId(mailRow(db).messageId), 1, { action: 'add' }, NOW);
    expect(copies(db)).toHaveLength(2);
    askedOf(() => typed(db, { lines: [tide(), { isbn: '9780000000026', qty: 1, price: 1200 }] }, LATER));
  });

  it('of several mails that fit, the newest is asked about', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    await mailInvoice(db, '99001133', { uid: 2, at: new Date(NOW.getTime() + 90 * 60_000) });
    expect(askedOf(() => typed(db, {}, LATER)).maybeMailed).toMatchObject({ mail: mailItemId(mailRow(db).messageId), number: '99001133' });
  });

  it('typed for the connector\'s own shop with the mail\'s number: refused by its number, as before (no question)', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    expectError(() => typed(db, { number: '99001122', shop: 'quillmere' }, LATER), EntryError, 409, /came in the bookshop's mail already/);
  });
});

/** The first invoice mail read. */
const db0 = (db: W) => db.select().from(t.mailSeen).where(eq(t.mailSeen.kind, 'invoice')).all()[0]!;

describe('the answer, sent with the entry again: the same invoice (nothing new counted) or another purchase (it counts)', () => {
  it('the same: kept as a duplicate of the mail; no copy, order, price or pile changes; the mail is never asked about again', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    const mail = mailItemId(mailRow(db).messageId);
    const before = { copies: copies(db), order: order(db), offers: offers(db), reading: db.select().from(t.reading).all() };
    const r = typed(db, { lines: [{ ...tide(), for: 'kid1' }], mailed: { mail, answer: 'same' } }, LATER);
    expect(r).toMatchObject({ id: expect.any(String), dryRun: false, sameAsMail: { mail, number: '99001122', total: 1990 } });
    expect({ copies: copies(db), order: order(db), offers: offers(db), reading: db.select().from(t.reading).all() }).toEqual(before);
    expect(entries(db)).toMatchObject([{ id: r.id, duplicateOf: mailRow(db).messageId }]);
    expect(parsed(db).duplicateOf).toBeUndefined();
    // Typed a second time, the mail is taken: it counts at once.
    expect(typed(db, {}, LATER).id).toBeDefined();
    expect(copies(db)).toHaveLength(2);
  });

  it('another purchase: it counts, as when no mail fits', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    const r = typed(db, { mailed: { mail: mailItemId(mailRow(db).messageId), answer: 'another' } }, LATER);
    expect(r.sameAsMail).toBeUndefined();
    expect(copies(db)).toEqual([['b_tide', 'invoice', 'o_nov', 1990], ['b_tide', 'manual', null, 1990]]);
    expect(entries(db)[0]!.duplicateOf).toBeNull();
  });

  it('an answer about another mail than the one that fits now is asked again; with none that fits, another counts and same is 409; a bad answer is 400', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    const mail = mailItemId(mailRow(db).messageId);
    expect(askedOf(() => typed(db, { mailed: { mail: `m_${'0'.repeat(32)}`, answer: 'same' } }, LATER)).maybeMailed!.mail).toBe(mail);
    for (const mailed of [{ mail, answer: 'maybe' }, { mail: 42, answer: 'same' }, { mail, answer: 'same', extra: 1 }, 'same', null]) {
      expectError(() => typed(db, { mailed }, LATER), EntryError, 400);
    }
    expect(entries(db)).toHaveLength(0);
    const none = world();
    expectError(() => typed(none, { mailed: { mail, answer: 'same' } }, LATER), EntryError, 409, /no mail/);
    expect(typed(none, { mailed: { mail, answer: 'another' } }, LATER).id).toBeDefined();
  });

  it('a dry run with an answer about another mail names the one that fits (200), and asks nothing', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    const r = typed(db, { dryRun: true, mailed: { mail: `m_${'0'.repeat(32)}`, answer: 'same' } }, LATER);
    expect(r).toMatchObject({ dryRun: true, maybeMailed: { mail: mailItemId(mailRow(db).messageId) } });
    expect(r.sameAsMail).toBeUndefined();
    expect(entries(db)).toHaveLength(0);
  });

  it('a quote has no such question: mailed is 400', () => {
    const db = world();
    db.update(t.order).set({ status: 'quoted' }).where(eq(t.order.id, 'o_nov')).run();
    const quote = { kind: 'quote', month: '2026-11', lines: [{ isbn: '9780000000002', price: 1990 }] };
    expectError(() => recordEntry(db, 'p_alex', { ...quote, mailed: { mail: `m_${'0'.repeat(32)}`, answer: 'same' } }, LATER), EntryError, 400, /mailed/);
    expect(recordEntry(db, 'p_alex', quote, LATER).id).toBeDefined();
  });
});

describe('with #57: a duplicate of a mail and the undo, the hand-over and a mail read after it', () => {
  it('an entry kept as the mail\'s duplicate is undone (it did nothing: only the entry goes), and the mail is asked about again', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    const mail = mailItemId(mailRow(db).messageId);
    const r = typed(db, { mailed: { mail, answer: 'same' } }, LATER);
    const before = { copies: copies(db), order: order(db), offers: offers(db) };
    expect(recentEntries(db, 'p_alex', LATER)).toMatchObject([{ id: r.id, copies: 0, sameAsMail: true, canUndo: true }]);
    undoEntry(db, 'p_alex', r.id!, LATER);
    expect(entries(db)).toHaveLength(0);
    expect({ copies: copies(db), order: order(db), offers: offers(db) }).toEqual(before);
    askedOf(() => typed(db, {}, LATER));
  });

  it('an entry kept as one mail\'s duplicate never counts as another mail of its number and shop (that one counts)', async () => {
    const db = world();
    db.insert(t.orderEntry).values({ id: '01JZZZZZZZZZZZZZZZZZZZZZZZ', kind: 'invoice', source: 'typed', number: '99001122', shop: 'quillmere', personId: 'p_alex', totalC: 1990, createdAt: NOW.toISOString(),
      linesJson: JSON.stringify([{ bookId: 'b_tide', qty: 1, priceC: 1990, available: true }]), undoJson: JSON.stringify({ lines: [], orders: [], offers: [] }), duplicateOf: 'another-shops-mail' }).run();
    await mailInvoice(db, '99001122');
    expect(parsed(db).duplicateOf).toBeUndefined();
    expect(copies(db)).toHaveLength(1);
  });

  it('a mail read after an entry kept as another mail\'s duplicate never waits as maybe that entry (it stands for the first mail)', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    typed(db, { mailed: { mail: mailItemId(mailRow(db).messageId), answer: 'same' } }, LATER);
    await mailInvoice(db, '99001133', { uid: 2, at: new Date(LATER.getTime() + 3600_000) });
    expect(parsed(db).maybeTyped).toBeUndefined();
    expect(copies(db)).toHaveLength(2);
  });

  it('typed at the wrong price, the shop\'s mail at the right one, then typed again at the right one (the same): undoing the first hands its line to the mail', async () => {
    const db = world();
    const wrong = typed(db, { lines: [tide({ price: 1890 })] });
    await mailInvoice(db, '99001122');
    const mail = mailItemId(mailRow(db).messageId);
    expect(askedOf(() => typed(db, {}, LATER)).maybeMailed!.mail).toBe(mail);
    typed(db, { mailed: { mail, answer: 'same' } }, LATER);
    undoEntry(db, 'p_alex', wrong.id!, LATER);
    expect(copies(db)).toEqual([['b_tide', 'invoice', 'o_nov', 1990]]);
    expect(order(db)).toMatchObject({ status: 'invoiced', invoicedC: 1990 });
    expect(db.select().from(t.orderLine).where(eq(t.orderLine.bookId, 'b_tide')).get()).toMatchObject({ state: 'delivered' });
  });
});

describe('POST /orders/entries, asked about a mail', () => {
  let built: BuiltApp;
  let db: W;
  let mail: string;
  beforeAll(async () => {
    db = world();
    await mailInvoice(db, '99001122');
    mail = mailItemId(mailRow(db).messageId);
    built = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY }), db);
    await built.app.ready();
  });
  afterAll(() => built.app.close());
  const body = (extra: Record<string, unknown> = {}) => ({ kind: 'invoice', lines: [tide()], ...extra });
  const post = (headers: Record<string, string>, payload: unknown) => built.app.inject({ method: 'POST', url: '/api/orders/entries', payload: JSON.stringify(payload), headers: { 'content-type': 'application/json', ...headers } });
  const as = (who: string, origin = ORIGIN) => ({ cookie: sessionCookie(db, who), origin });

  it('a kid has no access, another origin and a share token are refused: no question asked, nothing recorded', async () => {
    expect((await post(as('p_kid1'), body())).statusCode).toBe(403);
    expect((await post(as('p_kid1'), body({ mailed: { mail, answer: 'another' } }))).statusCode).toBe(403);
    expect((await post(as('p_alex', 'https://evil.example'), body({ mailed: { mail, answer: 'another' } }))).statusCode).toBe(403);
    const { token } = createShareToken(db, 'p_alex', 'iPhone');
    expect((await post({ authorization: `Bearer ${token}`, origin: ORIGIN }, body({ mailed: { mail, answer: 'another' } }))).statusCode).toBe(401);
    expect(entries(db)).toHaveLength(0);
  });

  it('an adult is asked (409 with the mail), then answers the same (201)', async () => {
    const asked = await post(as('p_alex'), body());
    expect(asked.statusCode).toBe(409);
    expect(asked.json()).toEqual({ error: 'Is this the invoice that came by mail on 16 November 2026?', maybeMailed: { mail, cameOn: '2026-11-16T00:00:00.000Z', number: '99001122', total: 1990 } });
    const res = await post(as('p_sam'), body({ mailed: { mail, answer: 'same' } }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sameAsMail: { mail } });
    expect(copies(db)).toHaveLength(1);
  });
});

// One invoice holding the other (philobiblos#64): the mailed books plus one more, typed or mailed second. The books the
// two share count once, and what the second one adds counts when a person says it is the same purchase.
describe('typed after its mail, holding the mail\'s books and more, or part of them: asked, and the shared books count once (philobiblos#64)', () => {
  it('the mailed books plus another: asked (nothing changes); the same counts only the other book', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    const mail = mailItemId(mailRow(db).messageId);
    const before = { copies: copies(db), order: order(db), offers: offers(db) };
    const body = { lines: [tide(), { ...hedgehog(), for: 'kid1' }] };
    const e = askedOf(() => typed(db, body, LATER));
    expect(e.message).toBe('Does this invoice hold the one that came by mail on 16 November 2026? Its 1 other copy counts either way.');
    expect(e.maybeMailed).toEqual({ mail, cameOn: '2026-11-16T00:00:00.000Z', number: '99001122', total: 1990, more: 1 });
    expect({ copies: copies(db), order: order(db), offers: offers(db) }).toEqual(before);
    const dry = typed(db, { ...body, dryRun: true, mailed: { mail, answer: 'same' } }, LATER);
    expect(dry).toMatchObject({ dryRun: true, sameAsMail: { mail, more: 1 } });
    expect({ copies: copies(db), order: order(db), entries: entries(db) }).toEqual({ copies: before.copies, order: before.order, entries: [] });
    const r = typed(db, { ...body, mailed: { mail, answer: 'same' } }, LATER);
    expect(r).toMatchObject({ sameAsMail: { mail, number: '99001122', total: 1990, more: 1 }, total: 3190 });
    expect(copies(db)).toEqual([['b_hedgehog', 'manual', 'o_nov', 1200], ['b_tide', 'invoice', 'o_nov', 1990]]);
    expect(order(db)).toMatchObject({ status: 'invoiced', invoicedC: 3190 });
    expect(offers(db)).toContainEqual(['b_hedgehog', 'invoice', 1200, '2026-11-16T00:00:00.000Z']);
    expect(db.select().from(t.reading).all()).toContainEqual(expect.objectContaining({ personId: 'p_kid1', bookId: 'b_hedgehog', status: 'to_read' }));
    expect(entries(db)).toMatchObject([{ id: r.id, duplicateOf: mailRow(db).messageId }]);
    expect(recentEntries(db, 'p_alex', LATER)).toMatchObject([{ id: r.id, copies: 1, sameAsMail: true, canUndo: true }]);
    // Its undo takes back the other book only; the mail's stays, and may be asked about again.
    undoEntry(db, 'p_alex', r.id!, LATER);
    expect({ copies: copies(db), order: order(db) }).toEqual({ copies: before.copies, order: before.order });
    expect(entries(db)).toHaveLength(0);
    askedOf(() => typed(db, body, LATER));
  });

  it('another purchase counts every book, as before', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    typed(db, { lines: [tide(), hedgehog()], mailed: { mail: mailItemId(mailRow(db).messageId), answer: 'another' } }, LATER);
    expect(copies(db)).toEqual([['b_hedgehog', 'manual', 'o_nov', 1200], ['b_tide', 'invoice', 'o_nov', 1990], ['b_tide', 'manual', null, 1990]]);
  });

  it('the other book may be one nobody has yet: the same adds it, and its copy', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    const mail = mailItemId(mailRow(db).messageId);
    const body = { lines: [tide(), { title: 'A Map of Small Rivers', author: 'Ines Varga', qty: 1, price: 1500 }] };
    expect(askedOf(() => typed(db, body, LATER)).maybeMailed).toMatchObject({ mail, more: 1 });
    const r = typed(db, { ...body, mailed: { mail, answer: 'same' } }, LATER);
    const added = r.lines[1]!;
    expect(added).toMatchObject({ new: true, title: 'A Map of Small Rivers' });
    expect(copies(db)).toEqual([[added.bookId, 'manual', null, 1500], ['b_tide', 'invoice', 'o_nov', 1990]].sort());
  });

  it('more copies of a mailed book: the same counts only the copies beyond the mail\'s', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    const mail = mailItemId(mailRow(db).messageId);
    expect(askedOf(() => typed(db, { lines: [tide({ qty: 3 })] }, LATER)).message).toMatch(/Its 2 other copies count either way/);
    typed(db, { lines: [tide({ qty: 3 })], mailed: { mail, answer: 'same' } }, LATER);
    expect(copies(db)).toEqual([['b_tide', 'invoice', 'o_nov', 1990], ['b_tide', 'manual', null, 1990], ['b_tide', 'manual', null, 1990]]);
  });

  it('part of the mail (a book of it, or its books Philobiblos placed): asked; the same counts nothing', async () => {
    for (const r of [[TIDE_ROW, HEDGEHOG_ROW], [TIDE_ROW, UNPLACED_ROW]]) {
      const db = world();
      await mailInvoice(db, '99001122', { rows: r });
      const mail = mailItemId(mailRow(db).messageId);
      const before = { copies: copies(db), order: order(db), offers: offers(db) };
      const e = askedOf(() => typed(db, {}, LATER));
      expect(e.message).toBe('Is this invoice part of the one that came by mail on 16 November 2026?');
      expect(e.maybeMailed).toEqual({ mail, cameOn: '2026-11-16T00:00:00.000Z', number: '99001122', total: 3190, part: true });
      const got = typed(db, { mailed: { mail, answer: 'same' } }, LATER);
      expect(got.sameAsMail).toMatchObject({ mail, part: true });
      expect({ copies: copies(db), order: order(db), offers: offers(db) }).toEqual(before);
      expect(recentEntries(db, 'p_alex', LATER)).toMatchObject([{ copies: 0, sameAsMail: true }]);
    }
  });

  it('two mails\' books in one invoice: refused (409, no question), to be recorded apart; a dry run says so too', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    await mailInvoice(db, '99001133', { uid: 2, at: new Date(NOW.getTime() + 90 * 60_000), rows: [HEDGEHOG_ROW] });
    const before = copies(db);
    for (const extra of [{}, { dryRun: true }]) {
      const e = askedOf(() => typed(db, { lines: [tide(), hedgehog()], ...extra }, LATER));
      expect(e.message).toMatch(/books of two invoices that came by mail \(on 16 November 2026 and 16 November 2026\): record the books of each apart/);
      expect(e.maybeMailed).toBeUndefined();
    }
    expect(copies(db)).toEqual(before);
    expect(entries(db)).toHaveLength(0);
  });

  it('the mail it holds most of is asked about before a newer one it holds less of', async () => {
    const db = world();
    await mailInvoice(db, '99001122', { rows: [TIDE_ROW, HEDGEHOG_ROW] });
    const first = mailItemId(mailRow(db).messageId);
    await mailInvoice(db, '99001133', { uid: 2, at: new Date(NOW.getTime() + 90 * 60_000) });
    const e = askedOf(() => typed(db, { lines: [tide(), hedgehog()] }, LATER));
    expect(e.maybeMailed).toEqual({ mail: first, cameOn: '2026-11-16T00:00:00.000Z', number: '99001122', total: 3190 });
  });
});

describe('mailed after it was typed, holding the typed books and more, or part of them: held, and the shared books count once (philobiblos#64)', () => {
  const answer = (db: W, a: 'same' | 'another') => answerTyped(db, 'p_sam', mailItemId(mailRow(db).messageId), { answer: a }, NOW);

  it('the typed books plus another: held (nothing changes); the same counts only the other book', async () => {
    const db = world();
    const e = typed(db);
    const before = copies(db);
    await mailInvoice(db, '99001122', { rows: [TIDE_ROW, HEDGEHOG_ROW] });
    expect(parsed(db)).toMatchObject({ maybeTyped: e.id });
    expect(copies(db)).toEqual(before);
    expect(items(db).find((x) => x.kind === 'maybe_typed_invoice')).toMatchObject({ typed: { entryId: e.id, totalC: 1990, more: 1 } });
    answer(db, 'same');
    expect(copies(db)).toEqual([['b_hedgehog', 'invoice', 'o_nov', 1200], ['b_tide', 'manual', 'o_nov', 1990]]);
    expect(order(db)).toMatchObject({ status: 'invoiced', invoicedC: 3190 });
    expect(parsed(db)).toMatchObject({ duplicateOf: `entry:${e.id}` });
  });

  it('another purchase: every book of the mail counts, as before', async () => {
    const db = world();
    typed(db);
    await mailInvoice(db, '99001122', { rows: [TIDE_ROW, HEDGEHOG_ROW] });
    answer(db, 'another');
    expect(copies(db)).toEqual([['b_hedgehog', 'invoice', 'o_nov', 1200], ['b_tide', 'invoice', null, 1990], ['b_tide', 'manual', 'o_nov', 1990]]);
  });

  it('more copies of a typed book: the same counts the copies beyond the typed ones, at the mail\'s price', async () => {
    const db = world();
    typed(db);
    await mailInvoice(db, '99001122', { rows: [['9780000000002', 'The Long Tide of Markets', '3 ST', '19.90', '59.70 CHF', '2.6 %']] });
    expect(items(db).find((x) => x.kind === 'maybe_typed_invoice')).toMatchObject({ typed: { more: 2 } });
    answer(db, 'same');
    expect(copies(db)).toEqual([['b_tide', 'invoice', null, 1990], ['b_tide', 'invoice', null, 1990], ['b_tide', 'manual', 'o_nov', 1990]]);
  });

  it('a line Philobiblos cannot place, besides the typed books: held; after the same it waits in the Inbox as any such line', async () => {
    const db = world();
    const e = typed(db);
    await mailInvoice(db, '99001122', { rows: [TIDE_ROW, UNPLACED_ROW] });
    expect(parsed(db)).toMatchObject({ maybeTyped: e.id });
    // The same adds no copy of it (it waits for a person): it is not among the copies more.
    expect(items(db).find((x) => x.kind === 'maybe_typed_invoice')!.typed).not.toHaveProperty('more');
    answer(db, 'same');
    expect(copies(db)).toHaveLength(1);
    const it = items(db).find((x) => x.id === mailItemId(mailRow(db).messageId))!;
    expect(it.found).toMatchObject([{ index: 1, title: 'A Map of Small Rivers', priceC: 1200 }]);
  });

  it('part of the typed invoice: held; the same counts nothing', async () => {
    const db = world();
    const e = typed(db, { lines: [tide(), hedgehog()] });
    const before = copies(db);
    await mailInvoice(db, '99001122');
    expect(parsed(db)).toMatchObject({ maybeTyped: e.id });
    expect(items(db).find((x) => x.kind === 'maybe_typed_invoice')).toMatchObject({ typed: { entryId: e.id, totalC: 3190, part: true } });
    answer(db, 'same');
    expect(copies(db)).toEqual(before);
    expect(parsed(db)).toMatchObject({ duplicateOf: `entry:${e.id}` });
  });

  it('the typed invoice it holds most of is asked about before a newer one it holds less of', async () => {
    const db = world();
    const first = typed(db, { lines: [tide(), hedgehog()] });
    typed(db, {}, new Date(NOW.getTime() + 10 * 60_000));
    await mailInvoice(db, '99001122', { rows: [TIDE_ROW, HEDGEHOG_ROW] });
    expect(parsed(db)).toMatchObject({ maybeTyped: first.id });
  });
});

// One purchase in three records (philobiblos#64 review): what two of them share is kept, so the third is asked about
// what is left, and nothing counts twice.
describe('one purchase split over three records: the third is asked about what is left of the others (philobiblos#64)', () => {
  const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
  const answer = (db: W, a: 'same' | 'another') => answerTyped(db, 'p_sam', mailItemId(mailRow(db).messageId), { answer: a }, NOW);

  it('typed A+B; mailed A (the same), then mailed B: B is held as maybe the typed one too, and counts once', async () => {
    const db = world();
    const e = typed(db, { lines: [tide(), hedgehog()] });
    await mailInvoice(db, '99001122');
    answer(db, 'same');
    await mailInvoice(db, '99001133', { uid: 2, at: later(90), rows: [HEDGEHOG_ROW] });
    expect(parsed(db)).toMatchObject({ maybeTyped: e.id });
    answer(db, 'same');
    expect(copies(db)).toEqual([['b_hedgehog', 'manual', 'o_nov', 1200], ['b_tide', 'manual', 'o_nov', 1990]]);
    // Wholly counted by the two mails now: a third is never asked about it.
    await mailInvoice(db, '99001144', { uid: 3, at: later(100) });
    expect(parsed(db).maybeTyped).toBeUndefined();
  });

  it('mailed A; typed A+B (the same: B counted); then mailed B: held as maybe the typed one', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    const r = typed(db, { lines: [tide(), hedgehog()], mailed: { mail: mailItemId(mailRow(db).messageId), answer: 'same' } }, LATER);
    await mailInvoice(db, '99001133', { uid: 2, at: later(150), rows: [HEDGEHOG_ROW] });
    expect(parsed(db)).toMatchObject({ maybeTyped: r.id });
    answer(db, 'same');
    expect(copies(db)).toEqual([['b_hedgehog', 'manual', 'o_nov', 1200], ['b_tide', 'invoice', 'o_nov', 1990]]);
  });

  it('mailed A+B; typed A (part of it: the same); then typed B: asked about what is left of the mail', async () => {
    const db = world();
    await mailInvoice(db, '99001122', { rows: [TIDE_ROW, HEDGEHOG_ROW] });
    const mail = mailItemId(mailRow(db).messageId);
    typed(db, { mailed: { mail, answer: 'same' } }, LATER);
    const e = askedOf(() => typed(db, { lines: [hedgehog()] }, LATER));
    expect(e.maybeMailed).toEqual({ mail, cameOn: '2026-11-16T00:00:00.000Z', number: '99001122', total: 1200 });
    typed(db, { lines: [hedgehog()], mailed: { mail, answer: 'same' } }, LATER);
    expect(copies(db)).toEqual([['b_hedgehog', 'invoice', 'o_nov', 1200], ['b_tide', 'invoice', 'o_nov', 1990]]);
    // Wholly counted as the two entries: typed once more, it is not asked about.
    expect(typed(db, { lines: [hedgehog()] }, LATER).id).toBeDefined();
  });

  it('typed A; mailed A+B (the same: B counted from the mail); then typed B: asked about what is left of the mail', async () => {
    const db = world();
    typed(db);
    await mailInvoice(db, '99001122', { rows: [TIDE_ROW, HEDGEHOG_ROW] });
    const mail = mailItemId(mailRow(db).messageId);
    answer(db, 'same');
    expect(askedOf(() => typed(db, { lines: [hedgehog()] }, LATER)).maybeMailed).toMatchObject({ mail, total: 1200 });
  });

  it('typed A, then typed B; mailed A+B: asked about each typed one in turn, and every book counts once', async () => {
    for (const second of ['same', 'another'] as const) {
      const db = world();
      const a = typed(db);
      const b = typed(db, { lines: [hedgehog()] }, later(10));
      await mailInvoice(db, '99001122', { rows: [TIDE_ROW, HEDGEHOG_ROW] });
      const first = parsed(db).maybeTyped;
      expect([a.id, b.id]).toContain(first);
      answer(db, 'same');
      // Still held: now as maybe the other typed one.
      expect(parsed(db).maybeTyped).toBe(first === a.id ? b.id : a.id);
      expect(items(db).find((x) => x.kind === 'maybe_typed_invoice')).toMatchObject({ typed: { entryId: parsed(db).maybeTyped } });
      expect(copies(db)).toHaveLength(2);
      answer(db, second);
      expect(parsed(db).maybeTyped).toBeUndefined();
      expect(copies(db), second).toHaveLength(second === 'same' ? 2 : 3);
      // The mail counts as each typed one it was answered the same as: those are never undone alone.
      const linked = second === 'same' ? [a.id!, b.id!] : [first as string];
      for (const id of linked) expectError(() => undoEntry(db, 'p_alex', id, NOW), EntryError, 409, /mail/);
    }
  });

  it('a held mail\'s line is not decided before the answer', async () => {
    const db = world();
    typed(db);
    await mailInvoice(db, '99001122', { rows: [TIDE_ROW, UNPLACED_ROW] });
    expectError(() => decide(db, 'p_sam', mailItemId(mailRow(db).messageId), 1, { action: 'add' }, NOW), InboxError, 409, /answer it first/);
  });
});

describe('a book billed on two lines, and a cent of rounding (philobiblos#64 review)', () => {
  it('the mail bills one book twice at two prices; typed once at one of them: part of it', async () => {
    const db = world();
    await mailInvoice(db, '99001122', { rows: [['9780000000002', 'The Long Tide of Markets', '1 ST', '10.00', '10.00 CHF', '2.6 %'], ['9780000000002', 'The Long Tide of Markets', '1 ST', '15.00', '15.00 CHF', '2.6 %']] });
    expect(askedOf(() => typed(db, { lines: [tide({ price: 1500 })] }, LATER)).maybeMailed).toMatchObject({ part: true });
  });

  it('two of three copies billed together for 29.99, typed at 10.00 each: part of it (a cent of rounding)', async () => {
    const db = world();
    await mailInvoice(db, '99001122', { rows: [['9780000000002', 'The Long Tide of Markets', '3 ST', '10.00', '29.99 CHF', '2.6 %']] });
    expect(askedOf(() => typed(db, { lines: [tide({ qty: 2, price: 1000 })] }, LATER)).maybeMailed).toMatchObject({ part: true });
    // Two cents off is another price: not asked.
    const other = world();
    await mailInvoice(other, '99001122', { rows: [['9780000000002', 'The Long Tide of Markets', '3 ST', '10.00', '29.97 CHF', '2.6 %']] });
    expect(typed(other, { lines: [tide({ qty: 2, price: 1000 })] }, LATER).id).toBeDefined();
  });
});

describe('records answered before philobiblos#64 kept no shared copies: wholly counted, never asked about again', () => {
  it('an entry kept as a mail\'s duplicate then, and a mail answered the same as a typed one then', async () => {
    const db = world();
    await mailInvoice(db, '99001122');
    db.insert(t.orderEntry).values({ id: '01JZZZZZZZZZZZZZZZZZZZZZZZ', kind: 'invoice', source: 'typed', number: null, shop: '', personId: 'p_alex', totalC: 1990, createdAt: LATER.toISOString(),
      linesJson: JSON.stringify([{ bookId: 'b_tide', qty: 1, priceC: 1990, available: true }]), undoJson: JSON.stringify({ lines: [], orders: [], offers: [] }), duplicateOf: mailRow(db).messageId }).run();
    await mailInvoice(db, '99001133', { uid: 2, at: new Date(LATER.getTime() + 3600_000) });
    expect(parsed(db).maybeTyped).toBeUndefined();

    const old = world();
    const e = typed(old);
    await mailInvoice(old, '99001122');
    const p = parsed(old);
    delete p.maybeTyped;
    old.update(t.mailSeen).set({ parsedJson: JSON.stringify({ ...p, duplicateOf: `entry:${e.id}` }) }).where(eq(t.mailSeen.messageId, mailRow(old).messageId)).run();
    // Neither the mail nor the typed one is left to ask about: typed again, or mailed again, it counts at once.
    expect(typed(old, { dryRun: true }, LATER).maybeMailed).toBeUndefined();
    await mailInvoice(old, '99001133', { uid: 2, at: new Date(LATER.getTime() + 3600_000) });
    expect(parsed(old).maybeTyped).toBeUndefined();
  });
});
