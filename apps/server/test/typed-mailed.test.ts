// An invoice typed in with no number (or for no connector's shop), then mailed by the bookshop (philobiblos#45 item 2):
// nothing de-duplicates it by its number, so the mail waits in the Inbox, "maybe the invoice typed on …", when its books
// and total are those of a recent typed one. Every book, number and amount here is invented. Each rule has a test that
// fails when the rule is changed.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import * as t from '../src/db/schema';
import { InboxError, answerTyped, dismiss, listInbox, mailItemId } from '../src/inbox/inbox';
import { MAYBE_TYPED_DAYS } from '../src/mail/effects';
import { refreshMail } from '../src/mail/job';
import type { MediaOutcome } from '../src/media/client';
import { EntryError, recordEntry, undoEntry } from '../src/orders/entries';
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
  });

  it('counts as usual when it is not the same: another total, other books or quantities, another number, a line it cannot place', async () => {
    const cases: [string, Record<string, unknown>, string[][] | undefined][] = [
      ['another total', { lines: [tide({ price: 1890 })] }, undefined],
      ['another quantity', { lines: [tide({ qty: 2, price: 995 })] }, undefined],
      ['another book besides', { lines: [tide(), { isbn: '9780000000019', qty: 1, price: 1200 }] }, undefined],
      ['another number', { number: '99001123' }, undefined],
      ['a line it cannot place', {}, [['9780000000002', 'The Long Tide of Markets', '1 ST', '19.90', '19.90 CHF', '2.6 %'], ['9780000000026', 'A Map of Small Rivers', '1 ST', '0.00', '0.00 CHF', '2.6 %']]],
    ];
    for (const [what, body, r] of cases) {
      const db = world();
      typed(db, body);
      const n = copies(db).length;
      await mailInvoice(db, '99001122', { rows: r });
      expect(parsed(db).maybeTyped, what).toBeUndefined();
      expect(copies(db).length, what).toBe(n + 1);
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
    expect(db.select().from(t.inboxDecision).where(eq(t.inboxDecision.item, id)).all()).toMatchObject([{ idx: -1, decision: 'skipped', personId: 'p_sam' }]);
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
    expect(db.select().from(t.inboxDecision).where(eq(t.inboxDecision.item, id)).all()).toMatchObject([{ idx: -1, decision: 'added', personId: 'p_sam' }]);
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
