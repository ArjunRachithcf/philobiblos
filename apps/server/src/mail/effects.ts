// What a parsed bookshop mail changes (ADR 0007, contracts/connectors.md "Effect"), and only from a mail `openVerified`
// produced (a `VerifiedMail`): anything else is refused here, whatever the caller. Effects touch Philobiblos's own records
// only: order lines quoted or unavailable, the order's quoted total and status, copies from an invoice (owned), and the
// prices learnt. They never create people, settings or outgoing mail.
//
// Lines are matched to books by EAN first, then by normalised title and author (title alone on an invoice, which has
// no author); a line that matches no book, or more than one, is kept as unmatched (its structured fields only), for a
// person to resolve in the Inbox.
//
// A quote or a confirmation belongs to a composed order (drafted or quoted): the one whose thread holds the mail's
// signed In-Reply-To (a bookshop mail already tied to it), or the one of the month its signed Subject names as Compose
// wrote it ("Book order, November 2026"); only the bookshop's signed mail ties anything (Compose copies the request to
// no one). With no order, every line is unmatched.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { MONTHS } from '../month/order-mail';
import { norm } from '../seed/import';
import { isVerified, type VerifiedMail } from './read';
import type { InvoiceLine, Parsed, QuoteLine, ShopLine } from './parse';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export interface BookKey { id: string; title: string; authors: string[]; isbn13: string | null }
export type Matched<L> = L & { bookId: string | null };
/** What is kept of a parsed mail beside its headers: the parser's fields, each line with the book it matched. */
export type Applied = Record<string, unknown> & { parser: string };

/** How many of a thread's Message-IDs an order keeps. */
export const THREAD_MAX = 20;

export const keys = (tx: Tx, ids?: string[]): BookKey[] =>
  (ids ? (ids.length ? tx.select().from(t.book).where(inArray(t.book.id, ids)).all() : []) : tx.select().from(t.book).all())
    .map((b) => ({ id: b.id, title: b.title, authors: JSON.parse(b.authorsJson) as string[], isbn13: b.isbn13 }));

function authorIs(stored: string, given: string): boolean {
  const g = norm(given), s = norm(stored);
  if (!g) return false;
  if (s === g) return true;
  const c = given.split(',');
  if (c.length === 2 && norm(`${c[1]} ${c[0]}`) === s) return true; // "Paulsen, Lena"
  const words = stored.trim().split(/\s+/);
  return words.length > 1 && norm(words[words.length - 1]!) === g; // a surname alone
}

/** The one book a line names: by EAN, then by normalised title and author; null for none or several. */
export function matchBook(books: BookKey[], l: { ean: string | null; title: string | null; author?: string | null; notBook?: true; eanUnreadable?: true }): string | null {
  // An EAN that is no ISBN, or one Philobiblos could not read: never matched, not even by its title (to the Inbox).
  if (l.notBook || l.eanUnreadable) return null;
  if (l.ean) {
    const hit = books.filter((b) => b.isbn13 === l.ean);
    if (hit.length === 1) return hit[0]!.id;
  }
  const title = l.title ? norm(l.title) : '';
  if (!title) return null;
  // A line with an EAN never names, by its title, a book that has another ISBN (another edition, or another book).
  const same = books.filter((b) => norm(b.title) === title && !(l.ean && b.isbn13 && b.isbn13 !== l.ean));
  const hits = l.author ? same.filter((b) => b.authors.some((a) => authorIs(a, l.author!))) : same;
  return hits.length === 1 ? hits[0]!.id : null;
}

/** "Re: Book order, November 2026" → "2026-11". */
export function monthOfSubject(subject: string | null): string | null {
  const m = new RegExp(`\\bBook order, (${MONTHS.join('|')}) (\\d{4})\\b`).exec(subject ?? '');
  return m ? `${m[2]}-${String(MONTHS.indexOf(m[1]!) + 1).padStart(2, '0')}` : null;
}

function tiedOrder(tx: Tx, m: VerifiedMail) {
  const open = tx.select().from(t.order).where(inArray(t.order.status, ['drafted', 'quoted'])).all();
  const byThread = m.threadRef ? open.find((o) => (o.mailThreadRef ?? '').split(' ').includes(m.threadRef!)) : undefined;
  if (byThread) return byThread;
  const month = monthOfSubject(m.content.subject);
  return month ? open.find((o) => o.month === month) ?? null : null;
}
const thread = (ref: string | null, id: string | null | undefined) => [...new Set([...(ref ?? '').split(' ').filter(Boolean), ...(id && !/\s/.test(id) ? [id] : [])])].slice(-THREAD_MAX).join(' ') || null;

/**
 * Applies a parsed mail to Philobiblos's records, in the caller's transaction, and returns what is kept of it. `key` is the
 * mail's own row in mail_seen (for an invoice already read under another Message-ID).
 */
export function applyMail(tx: Tx, m: VerifiedMail, p: Parsed, o: { key: string; now: string }): Applied {
  if (!isVerified(m)) throw new Error('effects apply only to a verified mail');
  switch (p.kind) {
    case 'bookshop_quote': return quote(tx, m, p.lines, p.parser, o.now);
    case 'bookshop_confirm': {
      const order = tiedOrder(tx, m);
      if (order) tx.update(t.order).set({ status: 'quoted', mailThreadRef: thread(order.mailThreadRef, m.auth.messageId) }).where(eq(t.order.id, order.id)).run();
      return { parser: p.parser, orderNumber: p.orderNumber, orderId: order?.id ?? null };
    }
    case 'online_order': case 'click_collect': {
      const books = keys(tx);
      return { parser: p.parser, orderNumber: p.orderNumber, lines: p.lines.map((l): Matched<ShopLine> => ({ ...l, bookId: matchBook(books, l) })) };
    }
    case 'invoice': return invoice(tx, m, p, o);
    case 'unknown_layout': return { parser: p.parser, expected: p.expected, reason: p.reason };
    case 'other': return { parser: p.parser };
  }
}

function quote(tx: Tx, m: VerifiedMail, lines: QuoteLine[], parser: string, now: string): Applied {
  const order = tiedOrder(tx, m);
  if (!order) return { parser, orderId: null, lines: lines.map((l) => ({ ...l, bookId: null })) };
  const books = keys(tx, orderBooks(tx, order.id));
  const out = lines.map((l): Matched<QuoteLine> => ({ ...l, bookId: matchBook(books, l) }));
  quoteOrder(tx, order, out, now, thread(order.mailThreadRef, m.auth.messageId));
  return { parser, orderId: order.id, lines: out };
}

/** The books of an order's lines. */
export const orderBooks = (tx: Tx, orderId: string): string[] =>
  tx.select({ id: t.orderLine.bookId }).from(t.orderLine).where(eq(t.orderLine.orderId, orderId)).all().map((l) => l.id);

/**
 * A quote's effect on its composed order (a verified mail's, or one a person typed in: orders/entries.ts): each line
 * that names one of its books quoted at its price or unavailable, the price learnt, and the order quoted at the total
 * of its quoted lines. `threadRef` is what the order's thread becomes (a mail's adds its Message-ID).
 */
export function quoteOrder(tx: Tx, order: { id: string }, lines: { bookId: string | null; available: boolean; priceC: number | null; delivery: string | null }[], now: string, threadRef: string | null): void {
  for (const l of lines) {
    if (!l.bookId) continue;
    tx.update(t.orderLine).set({ state: l.available ? 'quoted' : 'unavailable', quotedC: l.available ? l.priceC : null, delivery: l.delivery })
      .where(and(eq(t.orderLine.orderId, order.id), eq(t.orderLine.bookId, l.bookId))).run();
    if (l.available && l.priceC != null) {
      const v = { priceC: l.priceC, availability: l.delivery, seenAt: now };
      tx.insert(t.bookOffer).values({ bookId: l.bookId, source: 'quote', ...v }).onConflictDoUpdate({ target: [t.bookOffer.bookId, t.bookOffer.source], set: v }).run();
    }
  }
  // The order's total is the quote's: what the bookshop priced, the unavailable lines left out.
  const quoted = tx.select().from(t.orderLine).where(and(eq(t.orderLine.orderId, order.id), eq(t.orderLine.state, 'quoted'))).all().reduce((n, l) => n + (l.quotedC ?? 0), 0);
  tx.update(t.order).set({ status: 'quoted', quotedC: quoted, mailThreadRef: threadRef }).where(eq(t.order.id, order.id)).run();
}

function invoice(tx: Tx, m: VerifiedMail, p: Extract<Parsed, { kind: 'invoice' }>, o: { key: string; now: string }): Applied {
  const kept = { parser: p.parser, invoiceNumber: p.invoiceNumber, totalC: p.totalC };
  // The same invoice sent again by the same shop (another Message-ID): read, never counted twice.
  const again = p.invoiceNumber != null && tx.select({ id: t.mailSeen.messageId }).from(t.mailSeen)
    .where(and(eq(t.mailSeen.accepted, 1), eq(t.mailSeen.kind, 'invoice'), sql`json_extract(${t.mailSeen.parsedJson}, '$.invoiceNumber') = ${p.invoiceNumber}`, sql`${t.mailSeen.messageId} <> ${o.key}`,
      // The same shop's number: two shops may number their invoices alike (a row from before connectors names none: it
      // was the one shop's).
      sql`(json_extract(${t.mailSeen.authJson}, '$.connector') = ${m.auth.connector} OR json_extract(${t.mailSeen.authJson}, '$.connector') IS NULL)`)).get();
  if (again) return { ...kept, duplicateOf: again.id };
  // One a person typed in already (orders/entries.ts) counts as this one: a typed entry names no shop, so any shop's.
  const typed = p.invoiceNumber != null && tx.select({ id: t.orderEntry.id }).from(t.orderEntry).where(and(eq(t.orderEntry.kind, 'invoice'), sql`upper(${t.orderEntry.number}) = upper(${p.invoiceNumber})`)).get();
  if (typed) return { ...kept, duplicateOf: `entry:${typed.id}` };
  const books = keys(tx);
  const acquired = m.content.date && !Number.isNaN(Date.parse(m.content.date)) ? new Date(m.content.date).toISOString() : o.now;
  const invoiced = new Map<string, number>();
  const out = p.lines.map((l): Matched<InvoiceLine> => ({ ...l, bookId: matchBook(books, l) }));
  for (const l of out) {
    if (!l.bookId) continue;
    const orderId = receive(tx, { bookId: l.bookId, qty: l.qty, unitC: Math.round(l.totalC / l.qty), acquiredAt: acquired, source: 'invoice' }, o.now);
    if (orderId) invoiced.set(orderId, (invoiced.get(orderId) ?? 0) + l.totalC);
  }
  invoiceOrders(tx, invoiced);
  return { ...kept, lines: out };
}

/**
 * An invoice line's effect (a verified mail's, or one a person typed in: orders/entries.ts): `qty` copies owned at the
 * unit price, the price learnt, and the line of the composed order the book was ordered in, if any (not delivered yet),
 * delivered. Returns that order's id.
 */
export function receive(tx: Tx, l: { bookId: string; qty: number; unitC: number; acquiredAt: string; source: 'invoice' | 'manual' }, now: string): string | null {
  // The order it was ordered in, if any: a composed one, the line not delivered yet.
  const line = tx.select({ orderId: t.orderLine.orderId }).from(t.orderLine).innerJoin(t.order, eq(t.order.id, t.orderLine.orderId))
    .where(and(eq(t.orderLine.bookId, l.bookId), inArray(t.order.status, ['drafted', 'quoted', 'invoiced']), inArray(t.orderLine.state, ['planned', 'quoted']))).orderBy(sql`${t.order.month} DESC`).get();
  for (let i = 0; i < l.qty; i++) tx.insert(t.copy).values({ id: ulid(), bookId: l.bookId, source: l.source, orderId: line?.orderId ?? null, priceC: l.unitC, acquiredAt: l.acquiredAt }).run();
  const v = { priceC: l.unitC, availability: null, seenAt: now };
  tx.insert(t.bookOffer).values({ bookId: l.bookId, source: 'invoice', ...v }).onConflictDoUpdate({ target: [t.bookOffer.bookId, t.bookOffer.source], set: v }).run();
  if (line) tx.update(t.orderLine).set({ state: 'delivered' }).where(and(eq(t.orderLine.orderId, line.orderId), eq(t.orderLine.bookId, l.bookId))).run();
  return line?.orderId ?? null;
}

/** Each order an invoice delivered to: invoiced, its invoiced total grown by what the invoice charged for its books. */
export function invoiceOrders(tx: Tx, invoiced: Map<string, number>): void {
  for (const [id, c] of invoiced) {
    const order = tx.select().from(t.order).where(eq(t.order.id, id)).get()!;
    tx.update(t.order).set({ status: 'invoiced', invoicedC: (order.invoicedC ?? 0) + c }).where(eq(t.order.id, id)).run();
  }
}

/** Lines of verified mail that matched no book, for the Inbox (M3 e): their structured fields only. */
export function unmatchedLines(db: Db): { mail: string; kind: string; index: number; title: string | null; author: string | null; ean: string | null }[] {
  return db.select().from(t.mailSeen).where(eq(t.mailSeen.accepted, 1)).all().flatMap((r) => {
    const lines = (JSON.parse(r.parsedJson ?? '{}') as { lines?: unknown }).lines;
    if (!Array.isArray(lines)) return [];
    return lines.flatMap((l: { bookId?: string | null; title?: string | null; author?: string | null; ean?: string | null }, index) =>
      (l.bookId ? [] : [{ mail: r.messageId, kind: r.kind, index, title: l.title ?? null, author: l.author ?? null, ean: l.ean ?? null }]));
  });
}
