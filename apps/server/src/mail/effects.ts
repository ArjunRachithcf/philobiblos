// What a parsed bookshop mail changes (ADR 0007, contracts/connectors.md "Effect"), and only from a mail `openVerified`
// produced (a `VerifiedMail`): anything else is refused here, whatever the caller. Effects touch Philobiblos's own records
// only: order lines quoted or unavailable, the order's quoted total and status, copies from an invoice (owned), and the
// prices learnt. They never create people, settings or outgoing mail.
//
// Lines are matched to books by EAN first, then by normalised title and author (title alone on an invoice, which has
// no author); a line that matches no book, or more than one, is kept as unmatched (its structured fields only), for a
// person to resolve in the Inbox. An invoice that may be one typed in already with no number to tell (maybeTyped,
// philobiblos#45) changes nothing until a person answers in the Inbox.
//
// A quote or a confirmation belongs to a composed order (drafted or quoted): the one whose thread holds the mail's
// signed In-Reply-To (a bookshop mail already tied to it), or the one of the month its signed Subject names as Compose
// wrote it ("Book order, November 2026"); only the bookshop's signed mail ties anything (Compose copies the request to
// no one). With no order, every line is unmatched.
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
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

/** A mail's Inbox item id: its key (mail_seen.message_id) hashed, never the Message-ID itself. */
export const mailItemId = (key: string) => `m_${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32)}`;

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
    // A line already delivered (a book bought from the plain list, a tap) stays as it is: the household owns it.
    tx.update(t.orderLine).set({ state: l.available ? 'quoted' : 'unavailable', quotedC: l.available ? l.priceC : null, delivery: l.delivery })
      .where(and(eq(t.orderLine.orderId, order.id), eq(t.orderLine.bookId, l.bookId), ne(t.orderLine.state, 'delivered'))).run();
    // A free quote (0) is no price learnt, as a free invoice line is none (philobiblos#53).
    if (l.available && l.priceC != null && l.priceC > 0) {
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
    .where(and(eq(t.mailSeen.accepted, 1), eq(t.mailSeen.kind, 'invoice'), sql`upper(json_extract(${t.mailSeen.parsedJson}, '$.invoiceNumber')) = upper(${p.invoiceNumber})`, sql`${t.mailSeen.messageId} <> ${o.key}`,
      // The same shop's number: two shops may number their invoices alike (a row from before connectors names none: it
      // was the one shop's).
      sql`(json_extract(${t.mailSeen.authJson}, '$.connector') = ${m.auth.connector} OR json_extract(${t.mailSeen.authJson}, '$.connector') IS NULL)`)).get();
  if (again) return { ...kept, duplicateOf: again.id };
  // One a person typed in already for this connector's shop (orders/entries.ts) counts as this one; one typed for
  // another shop, or for none, never does.
  // One a person answered is the same as another mail (philobiblos#58) stands for that mail, and never for this one.
  const typed = p.invoiceNumber != null && tx.select({ id: t.orderEntry.id }).from(t.orderEntry)
    .where(and(eq(t.orderEntry.kind, 'invoice'), sql`upper(${t.orderEntry.number}) = upper(${p.invoiceNumber})`, eq(t.orderEntry.shop, m.auth.connector), isNull(t.orderEntry.duplicateOf))).get();
  if (typed) return { ...kept, duplicateOf: `entry:${typed.id}` };
  const books = keys(tx);
  const out = p.lines.map((l): Matched<InvoiceLine> => ({ ...l, bookId: matchBook(books, l) }));
  // Maybe one typed in already, with no number to tell (philobiblos#45): it waits for a person, and changes nothing.
  const maybe = maybeTyped(tx, { connector: m.auth.connector, number: p.invoiceNumber, key: o.key }, mailParts(out) ?? [], o.now);
  if (maybe) return { ...kept, lines: out, maybeTyped: maybe.id };
  invoiceLines(tx, out, { date: m.content.date, day: m.content.day, readAt: o.now }, o.now);
  return { ...kept, lines: out };
}

/**
 * A verified invoice's lines that name a book, applied: each one's copies owned at the price paid (source invoice),
 * the price learnt and its order line delivered (`receive`), each order invoiced for its lines. `when` is the mail's:
 * its Date header (an unreadable one counts from when it was read) and its day (read.ts `mailDay`). Applied when the
 * mail is read, or when a person answers that a mail that waited (`maybeTyped`) is another purchase.
 */
export function invoiceLines(tx: Tx, lines: { bookId: string | null; qty: number; totalC: number }[], when: { date: string | null; day: string | null; readAt: string }, now: string): void {
  const acquired = when.date && !Number.isNaN(Date.parse(when.date)) ? new Date(when.date).toISOString() : when.readAt;
  const invoiced = new Map<string, number>();
  for (const l of lines) {
    if (!l.bookId) continue;
    const orderId = receive(tx, { bookId: l.bookId, qty: l.qty, unitC: Math.round(l.totalC / l.qty), acquiredAt: acquired, source: 'invoice', day: when.day }, now);
    if (orderId) invoiced.set(orderId, (invoiced.get(orderId) ?? 0) + l.totalC);
  }
  invoiceOrders(tx, invoiced);
}

/** How recent a typed invoice is (recorded at most this many days before the mail is read) to be asked about. */
export const MAYBE_TYPED_DAYS = 30;

/**
 * An invoice's line, as two invoices are compared: the book it names (null: none), its copies and what they cost
 * together; `slack`, the cents its total may be off, one for each time it was a line taken in part (its total a share).
 */
export interface Part { bookId: string | null; qty: number; totalC: number; slack?: number }
/** Copies of a book and what the invoice holding them charges for them, as two invoices share them (kept with the answer that they are one purchase: philobiblos#64). */
export interface Shared { bookId: string; qty: number; totalC: number }

/**
 * What one invoice's copies (`inner`, every line naming a book) take of another's lines (`outer`): per outer line, how
 * many copies, and what the copies taken cost at the outer's prices (a line taken in part, its share of the line's
 * total; `partial` counts those, each up to a cent off). Of a book's lines, those nearest the inner's price for it are
 * taken first (a shop may bill one book on two lines at two prices). Null when the outer lacks some of them.
 */
function take(outer: Part[], inner: Part[]): { taken: number[]; amount: number; partial: number; shared: Shared[] } | null {
  if (!inner.length || inner.some((l) => !l.bookId)) return null;
  const want = new Map<string, { qty: number; c: number }>();
  for (const l of inner) {
    const w = want.get(l.bookId!) ?? { qty: 0, c: 0 };
    want.set(l.bookId!, { qty: w.qty + l.qty, c: w.c + l.totalC });
  }
  const shared = [...want].map(([bookId, w]) => ({ bookId, qty: w.qty, totalC: w.c }));
  const off = (l: Part) => (l.bookId && want.has(l.bookId) ? Math.abs(l.totalC / l.qty - want.get(l.bookId)!.c / want.get(l.bookId)!.qty) : 0);
  const taken = outer.map(() => 0);
  // The cents the amount may be off: a line taken in part, and any line whose total was a share already.
  let amount = 0, partial = inner.reduce((n, l) => n + (l.slack ?? 0), 0);
  for (const i of outer.map((_, i) => i).sort((a, b) => off(outer[a]!) - off(outer[b]!))) {
    const l = outer[i]!;
    const w = l.bookId ? want.get(l.bookId) : undefined;
    const k = w ? Math.min(w.qty, l.qty) : 0;
    if (!k) continue;
    w!.qty -= k;
    taken[i] = k;
    amount += share(l, k);
    partial += (l.slack ?? 0) + (k < l.qty ? 1 : 0);
  }
  return [...want.values()].every((w) => w.qty === 0) ? { taken, amount, partial, shared } : null;
}
/** What `k` of a line's copies cost: the line's total for all of them, else their share of it. */
const share = (l: Part, k: number) => (k === l.qty ? l.totalC : Math.round((l.totalC * k) / l.qty));
/** A line's copies left once `k` of them are taken, and what they cost. */
const left = <L extends Part>(l: L, k: number): L => (k
  ? { ...l, qty: l.qty - k, totalC: l.totalC - share(l, k), slack: (l.slack ?? 0) + ((l.totalC * k) % l.qty === 0 ? 0 : 1) }
  : l);

/** How a later invoice overlaps an earlier one (`overlap`). */
export interface Overlap {
  /** `same`: the same copies; `more`: the later holds every copy of the earlier, and more; `part`: the earlier holds every copy of the later. */
  holds: 'same' | 'more' | 'part';
  /** The later's lines beyond the earlier's (`more` only; a line taken in part: its copies left, and what they cost), `at` its place in `later`. */
  rest: (Part & { at: number })[];
  /** The copies the two share, by book. */
  shared: Shared[];
  /** How many copies they share. */
  copies: number;
}

/**
 * Whether one of two invoices holds the other (philobiblos#64), and how: every copy of the one is a copy of the same book
 * on the other, which charges for those copies what the one charges for them all (its books' total; a cent off for each
 * line taken in part). A line naming no book is never shared: on the invoice that holds the other, it is part of the
 * rest. Null when neither holds the other.
 */
export function overlap<L extends Part>(earlier: Part[], later: L[]): Overlap | null {
  const total = (ls: Part[]) => ls.reduce((n, l) => n + l.totalC, 0);
  const fits = (t: ReturnType<typeof take>, inner: Part[]) => !!t && Math.abs(t.amount - total(inner)) <= t.partial;
  const copies = (s: Shared[]) => s.reduce((n, l) => n + l.qty, 0);
  const inLater = take(later, earlier);
  if (inLater && fits(inLater, earlier)) {
    const rest = later.flatMap((l, at) => (inLater.taken[at] === l.qty ? [] : [{ ...left(l, inLater.taken[at]!), at }]));
    return { holds: rest.length ? 'more' : 'same', rest, shared: inLater.shared, copies: copies(inLater.shared) };
  }
  const inEarlier = take(earlier, later);
  return inEarlier && fits(inEarlier, later) ? { holds: 'part', rest: [], shared: inEarlier.shared, copies: copies(inEarlier.shared) } : null;
}

/** Lines less copies another invoice shares with them (`take`: nearest its price first, as `overlap` took them); every copy shared: none. */
function less<L extends Part>(lines: L[], shared: Shared[] | 'all'): L[] {
  if (shared === 'all') return [];
  if (!shared.length) return lines;
  const t = take(lines, shared);
  // Shares that no longer fit (never expected): as if all of it were shared, so nothing is asked of it again.
  return t ? lines.map((l, i) => left(l, t.taken[i]!)).filter((l) => l.qty > 0) : [];
}

/** A typed or imported invoice's lines (order_entry.lines_json), as `overlap` compares them. */
export const entryParts = (linesJson: string): Part[] =>
  (JSON.parse(linesJson) as { bookId: string | null; qty: number | null; priceC: number | null }[])
    .map((l) => ({ bookId: l.bookId, qty: l.qty ?? 0, totalC: (l.priceC ?? 0) * (l.qty ?? 0) })).filter((l) => l.qty > 0);

/** A mailed invoice's lines as `overlap` compares them, `index` each one's in the mail: a line that is no book left out; null for one it cannot read. */
export function mailParts(lines: unknown, added: Map<number, string | null> = new Map()): (Part & { index: number })[] | null {
  if (!Array.isArray(lines)) return null;
  const out: (Part & { index: number })[] = [];
  for (const [index, l] of (lines as { bookId?: unknown; qty?: unknown; totalC?: unknown; notBook?: unknown }[]).entries()) {
    if (!l || typeof l !== 'object') return null;
    if (l.notBook) continue;
    // A line that named no book when it was read but was added from the Inbox since counts as the book it was added as.
    const bookId = typeof l.bookId === 'string' ? l.bookId : added.get(index) ?? null;
    if (typeof l.qty !== 'number' || l.qty < 1 || typeof l.totalC !== 'number') return null;
    out.push({ index, bookId, qty: l.qty, totalC: l.totalC });
  }
  return out;
}

const isShared = (v: unknown): v is Shared[] => Array.isArray(v) && v.every((s) => s && typeof s.bookId === 'string' && Number.isInteger(s.qty) && s.qty > 0 && Number.isInteger(s.totalC));
/** What a typed entry kept as a mail's duplicate shares with it (its undo record's `shared`); one from before philobiblos#64: all of it. */
const entryShared = (undoJson: string | null): Shared[] | 'all' => {
  const s = undoJson ? (JSON.parse(undoJson) as { shared?: unknown }).shared : undefined;
  return isShared(s) ? s : 'all';
};
/** What a mail answered the same as a typed entry shares with it (`shared[<entry id>]`); one from before philobiblos#64, or counted as it by its number: all of it. */
const mailShared = (p: { shared?: unknown }, entryId: string): Shared[] | 'all' => {
  const s = p.shared && typeof p.shared === 'object' ? (p.shared as Record<string, unknown>)[entryId] : undefined;
  return isShared(s) ? s : 'all';
};
/** The typed entries a mail is the same purchase as: its first (duplicateOf) and any it was answered about since. */
export const mailEntries = (p: { duplicateOf?: unknown; shared?: unknown }): string[] => [...new Set([
  ...(typeof p.duplicateOf === 'string' && p.duplicateOf.startsWith('entry:') ? [p.duplicateOf.slice(6)] : []),
  ...(p.shared && typeof p.shared === 'object' ? Object.keys(p.shared) : []),
])];

/** Mails that are the same purchase as a typed entry (`duplicateOf`, or `shared` since philobiblos#64). */
export const mailsOfEntry = (id: string) =>
  sql`(json_extract(${t.mailSeen.parsedJson}, '$.duplicateOf') = ${`entry:${id}`} OR json_extract(${t.mailSeen.parsedJson}, ${`$.shared.${id}`}) IS NOT NULL)`;

/** What mails share with each typed entry they are the same purchase as (`mailShared`), read once for several entries. */
export type MailLinks = Map<string, (Shared[] | 'all')[]>;
export function mailLinks(tx: Tx): MailLinks {
  const links: MailLinks = new Map();
  const rows = tx.select({ p: t.mailSeen.parsedJson }).from(t.mailSeen).where(and(eq(t.mailSeen.accepted, 1), eq(t.mailSeen.kind, 'invoice'),
    sql`(json_extract(${t.mailSeen.parsedJson}, '$.duplicateOf') LIKE 'entry:%' OR json_extract(${t.mailSeen.parsedJson}, '$.shared') IS NOT NULL)`)).all();
  for (const r of rows) {
    const p = JSON.parse(r.p ?? '{}') as { duplicateOf?: unknown; shared?: unknown };
    for (const id of mailEntries(p)) links.set(id, [...(links.get(id) ?? []), mailShared(p, id)]);
  }
  return links;
}

/**
 * What of a typed entry no mail counts as (philobiblos#64): its lines less what the mail it is the duplicate of shares
 * with it, and less what each mail answered the same as it shares (`links`, else read for this one). An entry a mail is
 * one with by its number, or by an answer from before philobiblos#64, has nothing left.
 */
export function entryLeft(tx: Tx, e: { id: string; linesJson: string; duplicateOf: string | null; undoJson: string | null }, links: MailLinks = mailLinks(tx)): Part[] {
  let lines = entryParts(e.linesJson);
  if (e.duplicateOf) lines = less(lines, entryShared(e.undoJson));
  for (const s of links.get(e.id) ?? []) lines = less(lines, s);
  return lines;
}

/**
 * What of a mailed invoice no typed entry counts as (philobiblos#64): its lines (a line added from the Inbox since as
 * its book) less what each entry it was answered the same as shares, and less what each entry kept as its duplicate
 * shares. Null for a mail whose lines it cannot read.
 */
export function mailLeft(tx: Tx, r: { messageId: string; parsedJson: string | null }): (Part & { index: number })[] | null {
  const p = JSON.parse(r.parsedJson ?? '{}') as { lines?: unknown; duplicateOf?: unknown; shared?: unknown };
  const added = new Map(tx.select().from(t.inboxDecision).where(and(eq(t.inboxDecision.item, mailItemId(r.messageId)), eq(t.inboxDecision.decision, 'added'))).all().map((d) => [d.idx, d.bookId]));
  let lines = mailParts(p.lines, added);
  if (!lines) return null;
  for (const id of mailEntries(p)) lines = less(lines, mailShared(p, id));
  for (const e of tx.select({ u: t.orderEntry.undoJson }).from(t.orderEntry).where(eq(t.orderEntry.duplicateOf, r.messageId)).all()) lines = less(lines, entryShared(e.u));
  return lines;
}

/**
 * The invoice typed in or imported (orders/entries.ts) that a mailed one may be (philobiblos#45), or null. An invoice
 * typed with no number, or for another shop than this connector (none, or the household's label for it), is never
 * counted once with the mail by its number; so a mail is held when one such entry, recorded in the last
 * MAYBE_TYPED_DAYS days, and the mail (`lines`: what of it no entry counts as yet) hold each other's copies (`overlap`,
 * philobiblos#64): the same books in the same quantities, the typed books and more (a line it cannot place among them),
 * or part of the typed books, at the same total for the copies they share (the books' totals: what else an invoice
 * charges, and a line that is no book, are left out). What of the entry a mail counts as already is left out of it
 * (`entryLeft`), and so is what each other mail waiting as maybe it would share with it (`entryWaitLeft`): an entry
 * wholly counted or waited for so is never asked about again, and one waited for in part is for the rest. The entry's
 * number, if it has one, must be the mail's. Of several, the one sharing the most copies, then the newest.
 */
export function maybeTyped(tx: Tx, m: { connector: string; number: string | null; key: string }, lines: Part[], now: string, skip: string[] = []): { id: string; o: Overlap } | null {
  if (!lines.some((l) => l.bookId)) return null;
  const since = new Date(Date.parse(now) - MAYBE_TYPED_DAYS * 86_400_000).toISOString();
  const rows = tx.select().from(t.orderEntry).where(and(
    eq(t.orderEntry.kind, 'invoice'), sql`${t.orderEntry.createdAt} >= ${since}`, sql`${t.orderEntry.createdAt} <= ${now}`,
    sql`(${t.orderEntry.number} IS NULL OR (upper(${t.orderEntry.number}) = upper(${m.number}) AND ${t.orderEntry.shop} <> ${m.connector}))`,
    skip.length ? notInArray(t.orderEntry.id, skip) : undefined,
  )).orderBy(desc(t.orderEntry.createdAt)).all();
  const links = mailLinks(tx);
  const best = fullest(rows.map((e) => ({ e, o: overlap(entryWaitLeft(tx, e, m.key, links), lines) })));
  return best ? { id: best.e.id, o: best.o } : null;
}

/**
 * What of a typed entry is left (`entryLeft`) less what each mail waiting in the Inbox as maybe it, other than `key`,
 * would share with it if answered the same (philobiblos#64): a purchase mailed in two parts waits as two parts of it.
 * For deciding whether a mail is held only: what is counted, and what a question offers, is against `entryLeft` (an
 * unanswered mail counts nothing yet).
 */
export function entryWaitLeft(tx: Tx, e: { id: string; linesJson: string; duplicateOf: string | null; undoJson: string | null }, key: string, links: MailLinks = mailLinks(tx)): Part[] {
  let lines = entryLeft(tx, e, links);
  const waiting = tx.select().from(t.mailSeen).where(and(eq(t.mailSeen.accepted, 1), eq(t.mailSeen.kind, 'invoice'), ne(t.mailSeen.messageId, key),
    sql`json_extract(${t.mailSeen.parsedJson}, '$.maybeTyped') = ${e.id}`)).orderBy(t.mailSeen.seenAt).all();
  for (const w of waiting) {
    // One that no longer fits shares nothing (its answer "the same" is refused: inbox.ts answerTyped).
    const o = overlap(lines, mailLeft(tx, w) ?? []);
    if (o) lines = less(lines, o.shared);
  }
  return lines;
}

/** Of several candidates (newest first), the one whose overlap shares the most copies; the newest of those. */
function fullest<T extends { o: Overlap | null }>(cs: T[]): (T & { o: Overlap }) | null {
  let best: (T & { o: Overlap }) | null = null;
  for (const c of cs) if (c.o && (!best || c.o.copies > best.o.copies)) best = c as T & { o: Overlap };
  return best;
}

/** A bookshop's invoice mail that a typed or imported one may be (`maybeMailed`): how they overlap, and its books' total. */
export interface MailedInvoice { key: string; seenAt: string; date: string | null; day: string | null; number: string | null; overlap: Overlap; totalC: number }

/**
 * The bookshop's invoice mail that an invoice being typed or imported may be (philobiblos#58), or null: `maybeTyped`'s
 * rule mirrored, for a mail that counted first. A verified invoice mail read in the last MAYBE_TYPED_DAYS days that
 * counted (not one sent again, nor one waiting in the Inbox as maybe a typed one), of which what no entry counts as yet
 * (`mailLeft`) and the entry (`lines`: its rows, each with the book it names, or null for one Philobiblos has not) hold
 * each other's copies (`overlap`, philobiblos#64: the same, the mail's and more, or part of the mail's). A mail wholly
 * counted as entries is never asked about again. The entry's number, if it has one, must be the mail's (typed for the
 * mail's own connector, that number is refused before this: orders/entries.ts). Mails in `skip` (keys) are left out; of
 * several, the one sharing the most copies, then the newest. `totalC` is what is left of the mail's books' total.
 */
export function maybeMailed(tx: Tx, e: { number: string | null; lines: Part[] }, now: string, skip: string[] = []): MailedInvoice | null {
  if (!e.lines.some((l) => l.bookId)) return null;
  const since = new Date(Date.parse(now) - MAYBE_TYPED_DAYS * 86_400_000).toISOString();
  const j = (path: string) => sql`json_extract(${t.mailSeen.parsedJson}, ${path})`;
  const rows = tx.select().from(t.mailSeen).where(and(
    eq(t.mailSeen.accepted, 1), eq(t.mailSeen.kind, 'invoice'), sql`${t.mailSeen.seenAt} >= ${since}`, sql`${t.mailSeen.seenAt} <= ${now}`,
    sql`(${j('$.duplicateOf')} IS NULL OR ${j('$.duplicateOf')} LIKE 'entry:%')`, sql`${j('$.maybeTyped')} IS NULL`,
    e.number === null ? undefined : sql`upper(${j('$.invoiceNumber')}) = upper(${e.number})`,
    skip.length ? notInArray(t.mailSeen.messageId, skip) : undefined,
  )).orderBy(desc(t.mailSeen.seenAt)).all();
  const best = fullest(rows.map((r) => {
    const mail = mailLeft(tx, r);
    return { r, mail, o: mail ? overlap(mail, e.lines) : null };
  }));
  if (!best) return null;
  const p = JSON.parse(best.r.parsedJson ?? '{}') as { date?: unknown; day?: unknown; invoiceNumber?: unknown };
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return { key: best.r.messageId, seenAt: best.r.seenAt, date: str(p.date), day: str(p.day), number: str(p.invoiceNumber), overlap: best.o, totalC: best.mail!.reduce((n, l) => n + l.totalC, 0) };
}

/**
 * An invoice line's effect, whichever way the invoice came (mailed, typed in, or a line added from the Inbox): `qty`
 * copies owned at the unit price (the copies' source is the caller's), the price paid learnt (book_offer, always source
 * 'invoice'), and the line of the composed order the book was ordered in, if any, delivered (see `deliver`). Returns
 * that order's id.
 *
 * The price learnt is the latest invoice's by the invoice's day (philobiblos#53): its row's seen_at is that day, as UTC
 * midnight (`day`: a mail's, as its Date header names it in its own zone, read.ts `mailDay`; else the UTC day of
 * `acquiredAt`, a typed invoice's day as typed). A mail's time of day and a typed day compare alike; a day still to
 * come counts as today, so a misdated invoice never holds the price past today's. An invoice of an earlier day leaves
 * it, however late it is read or decided (an Inbox line weeks after its mail); one of the same day replaces it. A free
 * line (0: a gift, a promotion) says nothing of what the book costs, and is no price learnt. Migration 0019 repaired
 * the rows from before this.
 */
export function receive(tx: Tx, l: { bookId: string; qty: number; unitC: number; acquiredAt: string; source: 'invoice' | 'manual'; day?: string | null }, now: string, trace?: Delivered): string | null {
  const orderId = deliver(tx, l, trace);
  if (l.unitC > 0) {
    const at = Date.parse(l.acquiredAt);
    const today = invoiceDay(now);
    const day = l.day ?? (Number.isNaN(at) ? today : invoiceDay(new Date(at).toISOString()));
    const v = { priceC: l.unitC, availability: null, seenAt: day < today ? day : today };
    tx.insert(t.bookOffer).values({ bookId: l.bookId, source: 'invoice', ...v })
      .onConflictDoUpdate({ target: [t.bookOffer.bookId, t.bookOffer.source], set: v, setWhere: sql`excluded.seen_at >= ${t.bookOffer.seenAt}` }).run();
  }
  return orderId;
}

/**
 * What one `receive` did, for an undo (orders/entries.ts undoEntry): the copies it made, the tap's copy it took (with
 * what that copy was), and the order line it delivered (with what that line was).
 */
export interface Delivered {
  copies: string[];
  tap: { copyId: string; was: { source: typeof t.copy.$inferSelect['source']; orderId: string | null; priceC: number | null } } | null;
  line: { orderId: string; was: { state: string; copyId: string | null; tappedFrom: string | null } } | null;
}

/** An instant's day, as an invoice's price is dated: "2026-11-16T08:00:00.000Z" → "2026-11-16T00:00:00.000Z". */
const invoiceDay = (iso: string) => `${iso.slice(0, 10)}T00:00:00.000Z`;

/** How far apart a tap and the invoice of the same book may be for the invoice to take the tap's copy (philobiblos#47). */
export const TAP_INVOICE_DAYS = 60;

/**
 * An invoice's copies of one book (`receive`'s only: never called alone, so no invoice skips the price), and the
 * line of a composed order it was ordered in delivered: the latest month's line not delivered yet, as before; failing
 * that, a line a tap delivered when the parcel came (philobiblos#47) whose copy was made within TAP_INVOICE_DAYS of the
 * invoice's date. The tap's copy (`order_line.copy_id`) is then the invoice's first, at the price paid (its arrival
 * date kept), and the line no longer the tap's, so its Undo is refused like any invoice's: one copy for one book bought.
 * A tap older than that is another purchase, and the invoice makes copies of its own. Returns the line's order id.
 */
function deliver(tx: Tx, l: { bookId: string; qty: number; unitC: number; acquiredAt: string; source: 'invoice' | 'manual' }, trace?: Delivered): string | null {
  const composed = and(eq(t.orderLine.bookId, l.bookId), inArray(t.order.status, ['drafted', 'quoted', 'invoiced']));
  const open = tx.select({ orderId: t.orderLine.orderId }).from(t.orderLine).innerJoin(t.order, eq(t.order.id, t.orderLine.orderId))
    .where(and(composed, inArray(t.orderLine.state, ['planned', 'quoted']))).orderBy(sql`${t.order.month} DESC`).get();
  const at = Date.parse(l.acquiredAt);
  const tap = open ? undefined : tx.select({ orderId: t.orderLine.orderId, copyId: t.copy.id, tappedAt: t.copy.acquiredAt }).from(t.orderLine)
    .innerJoin(t.order, eq(t.order.id, t.orderLine.orderId)).innerJoin(t.copy, eq(t.copy.id, t.orderLine.copyId))
    .where(and(composed, eq(t.orderLine.state, 'delivered'))).orderBy(sql`${t.order.month} DESC`).all()
    .find((r) => Math.abs(Date.parse(r.tappedAt) - at) <= TAP_INVOICE_DAYS * 86_400_000);
  const orderId = open?.orderId ?? tap?.orderId ?? null;
  const copy = { bookId: l.bookId, source: l.source, orderId, priceC: l.unitC };
  const lineOf = (id: string) => and(eq(t.orderLine.orderId, id), eq(t.orderLine.bookId, l.bookId));
  if (trace && orderId) {
    const was = tx.select().from(t.orderLine).where(lineOf(orderId)).get()!;
    trace.line = { orderId, was: { state: was.state, copyId: was.copyId, tappedFrom: was.tappedFrom } };
  }
  if (tap) {
    if (trace) {
      const was = tx.select().from(t.copy).where(eq(t.copy.id, tap.copyId)).get()!;
      trace.tap = { copyId: tap.copyId, was: { source: was.source, orderId: was.orderId, priceC: was.priceC } };
    }
    tx.update(t.copy).set(copy).where(eq(t.copy.id, tap.copyId)).run();
  }
  for (let i = tap ? 1 : 0; i < l.qty; i++) {
    const id = ulid();
    tx.insert(t.copy).values({ id, ...copy, acquiredAt: l.acquiredAt }).run();
    trace?.copies.push(id);
  }
  if (orderId) tx.update(t.orderLine).set({ state: 'delivered', copyId: null, tappedFrom: null }).where(lineOf(orderId)).run();
  return orderId;
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
