// An order's quote or an invoice a person types in or imports from a CSV (philobiblos#27 slice 4): the path that works
// with any shop, or none, beside the connectors' mail. It has the effects a verified mail of the same kind has
// (mail/effects.ts quoteOrder, receive), on the same records only:
//
// - an invoice: each line's copies owned at the price paid (source manual), the price learnt, and the line of the
//   composed order the book was ordered in delivered (that order invoiced); a book nobody has yet is added (for a kid,
//   a kids' book, on their pile), as adding an invoice line from the Inbox does;
// - a quote: the shop's answer to the month's composed order (drafted or quoted): each of its books quoted at its price
//   or unavailable, and the order quoted at the total of its quoted lines. A line that names no book of that order is
//   refused, never guessed at.
//
// Who: any adult (kids have no access), for themselves or a kid, never another adult (`for`, the Backlog's rule); the
// order and the copies are the household's. What is kept: the entry's book ids, quantities and amounts, its invoice
// number and who recorded it, never the text typed. An invoice number counts once per shop, whether typed, imported or read from a
// bookshop's mail (mail/effects.ts looks here too). Amounts are in the household's currency (none yet: nothing is
// recorded). Everything is checked before anything changes and applied in one transaction; a dry run applies it and
// rolls back, so it answers exactly what the entry would do and changes nothing.
//
// An invoice entry keeps what it did (undo_json), so whoever recorded it, or an admin, may undo it for UNDO_DAYS while
// nothing it changed has changed since (undoEntry; philobiblos#45).
//
// An invoice that may be one a bookshop's mail brought and counted already (mail/effects.ts maybeMailed; philobiblos#58)
// is asked about before it counts: 409 with the mail ("Is this the invoice that came by mail on …?"), and the person
// sends it again with the answer (`mailed`). The same: it is kept as that mail's duplicate (duplicate_of) and counts
// nothing; another purchase: it counts. A dry run names the question and asks nothing.
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { bookIsbn } from '../books/isbn';
import { AMOUNT_CEILING_C, parseAmount } from '@philobiblos/contracts/money';
import { amountProblem, getMoney } from '../household/money';
import { actsFor, getPerson, household, view } from '../household/people';
import { DAY, longDay } from '../inbox/inbox';
import { invoiceOrders, keys, mailItemId, matchBook, maybeMailed, orderBooks, quoteOrder, receive, type BookKey, type Delivered, type MailedInvoice, type Tx } from '../mail/effects';
import { safeField } from '../mail/read';
import { norm } from '../seed/import';
import { CsvError, parseCsv } from './csv';
import { unguardCell } from './list';

/** At most 100 lines (a parser's books a mail), 20 copies a line (the Inbox's), a price at most any amount's ceiling. */
export const ENTRY_LIMITS = { lines: 100, qty: 20, price: AMOUNT_CEILING_C, number: 40, shop: 80, title: 300, author: 200 } as const;

/** The bookshop's mail an invoice may be (philobiblos#58): its Inbox item id, the day it names, its number, its books' total. */
export interface MaybeMailed { mail: string; cameOn: string; number: string | null; total: number }

export class EntryError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string, readonly maybeMailed?: MaybeMailed) { super(message); }
}

export type EntryKind = 'quote' | 'invoice';
export interface EntryLine {
  row: number;
  /** The book it names; null in a dry run for a book that would be added. */
  bookId: string | null;
  new: boolean;
  title: string;
  authors: string[];
  isbn13: string | null;
  qty: number | null;
  price: number | null;
  available: boolean;
  /** Whose pile it goes on (a handle), if anyone's. */
  for: string | null;
}
export interface EntryResult {
  id?: string;
  kind: EntryKind;
  source: 'typed' | 'csv';
  dryRun: boolean;
  month?: string;
  orderId?: string;
  number: string | null;
  /** An invoice's shop: an enabled connector's id, or the label given. */
  shop: string | null;
  total: number;
  lines: EntryLine[];
  ignoredColumns: string[];
  /** A dry run's: the bookshop's mail it would be asked about. */
  maybeMailed?: MaybeMailed;
  /** Answered the same as this mail: kept as its duplicate, nothing counted. */
  sameAsMail?: MaybeMailed;
}

/** A line as it was given, checked: what it names and its amounts. */
interface Given { row: number; isbn: string | null; title: string | null; author: string | null; qty: number; price: number | null; available: boolean; for: string | null }

const bad = (m: string): never => { throw new EntryError(400, m); };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A text field fit to keep, or null when empty: NFKC, invisible characters gone; no control character, no run of 12 digits. */
function textField(v: unknown, name: string, max: number): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') return bad(`${name}: text`);
  const s = v.normalize('NFKC').replace(/\p{Cf}/gu, '').trim();
  if (!s) return null;
  if (s.length > max) return bad(`${name}: up to ${max} characters`);
  if (/\p{Cc}/u.test(s)) return bad(`${name}: no line breaks or control characters`);
  // U+FFFD is what a decoder writes for bytes it could not read: a file saved in another encoding than UTF-8, whose words
  // would never match a book (and would add a broken one).
  if (s.includes('\ufffd')) return bad(`${name}: holds a character that could not be read: save the file as CSV UTF-8`);
  // A card or account number has no place in a book's title (ADR 0009); safeField's rule for every string a parser keeps.
  if (safeField(s, []) === null) return bad(`${name}: holds a run of 12 or more digits, which Philobiblos never keeps`);
  return s;
}

const LINE_FIELDS: Record<EntryKind, string[]> = { invoice: ['isbn', 'title', 'author', 'qty', 'price', 'for'], quote: ['isbn', 'title', 'author', 'price', 'available'] };

/**
 * One line, from JSON (`price` in hundredths) or a CSV's row (its cells as text: `price` an amount such as 18.90), in
 * the household's `currency`: whole units in one without decimals.
 */
function line(kind: EntryKind, row: number, v: unknown, csv: boolean, currency: string): Given {
  const at = (m: string) => bad(`row ${row}: ${m}`);
  if (!isObject(v)) return at('an object');
  for (const k of Object.keys(v)) {
    if (k === 'qty' && kind === 'quote') return at('qty: a quote has no quantity (its order has)');
    if (!LINE_FIELDS[kind].includes(k)) return at(`unknown field ${k.slice(0, 40)}`);
  }
  const field = (name: string, max: number) => { try { return textField(v[name], name, max); } catch (e) { return at((e as Error).message); } };
  // An ISBN is digits by nature: its own check (bookIsbn), not the text fields' digit rule.
  const rawIsbn = v.isbn === undefined || v.isbn === null || v.isbn === '' ? null : v.isbn;
  const isbn = typeof rawIsbn === 'string' ? bookIsbn(rawIsbn) : null;
  if (rawIsbn != null && !isbn) return at('isbn: not a book\'s ISBN (ISBN-13 starting 978 or 979, or ISBN-10, with its check digit)');
  const title = field('title', ENTRY_LIMITS.title);
  const author = field('author', ENTRY_LIMITS.author);
  if (!title && !isbn) return at('a title or isbn names the book');

  let qty = 1;
  if (v.qty !== undefined && v.qty !== '') {
    const q = csv && typeof v.qty === 'string' && /^\d{1,3}$/.test(v.qty.trim()) ? Number(v.qty.trim()) : v.qty;
    if (!Number.isInteger(q) || (q as number) < 1 || (q as number) > ENTRY_LIMITS.qty) return at(`qty: a whole number from 1 to ${ENTRY_LIMITS.qty}`);
    qty = q as number;
  }

  let available = true;
  if (v.available !== undefined && v.available !== '') {
    const a = csv && typeof v.available === 'string' ? ({ yes: true, y: true, true: true, 1: true, no: false, n: false, false: false, 0: false } as Record<string, boolean>)[v.available.trim().toLowerCase()] : v.available;
    if (typeof a !== 'boolean') return at(csv ? 'available: yes or no' : 'available: true or false');
    available = a;
  }

  let price: number | null = null;
  if (v.price !== undefined && v.price !== null && v.price !== '') {
    let p: unknown = v.price;
    if (csv) {
      // An amount in the household's currency as a person writes it: digits, then a point or a comma and at most the
      // currency's decimals. No symbol, sign or thousands separator: an amount Philobiblos cannot place is refused, never guessed.
      p = typeof p === 'string' ? parseAmount(p, currency) : null;
      if (p === null) return at(`price: an amount such as 18.90 (or 1890 in a currency without decimals), in ${currency}`);
    }
    const problem = amountProblem(p, currency);
    if (problem) return at(`price: ${problem}`);
    price = p as number;
  }
  if (kind === 'invoice' && price === null) return at('price: what was paid for each copy');
  if (kind === 'quote' && available && price === null) return at('price: the shop\'s price, or available: false');
  if (kind === 'quote' && !available && price !== null) return at('price: an unavailable book has none');

  const forWho = field('for', 40);
  return { row, isbn, title, author, qty, price, available, for: forWho };
}

/** The names a CSV's header may give a column (lower case), and the field each one is. */
const COLUMNS: Record<string, string> = { isbn: 'isbn', isbn13: 'isbn', ean: 'isbn', title: 'title', author: 'author', qty: 'qty', quantity: 'qty', price: 'price', available: 'available', for: 'for' };

/** A CSV's rows as lines; the columns it does not read are named in the answer and never kept. */
function csvLines(kind: EntryKind, text: unknown): { lines: unknown[]; ignored: string[] } {
  if (typeof text !== 'string') return bad('csv: the file\'s text');
  let records: string[][];
  try { records = parseCsv(text); } catch (e) { return e instanceof CsvError ? bad(`csv: ${e.message}`) : bad('csv: unreadable'); }
  const [header, ...rows] = records;
  if (!header || !rows.length) return bad('csv: no rows below its header');
  const ignored: string[] = [];
  const fields = header.map((h) => {
    const name = h.normalize('NFKC').replace(/\p{Cf}/gu, '').trim().toLowerCase();
    if (name.includes('\ufffd')) return bad('csv: its header holds a character that could not be read: save the file as CSV UTF-8');
    const f = COLUMNS[name];
    if (f && LINE_FIELDS[kind].includes(f)) return f;
    // A column it does not read: named back (bounded, printable), its cells never read.
    const shown = name.replace(/\p{Cc}/gu, '').slice(0, 40);
    if (shown && !ignored.includes(shown)) ignored.push(shown);
    return null;
  });
  const seen = new Set<string>();
  for (const f of fields) {
    if (!f) continue;
    if (seen.has(f)) return bad(`csv: the column ${f} twice`);
    seen.add(f);
  }
  if (!seen.has('title') && !seen.has('isbn')) return bad('csv: a title or isbn column names the books');
  if (rows.length > ENTRY_LIMITS.lines) return bad(`csv: at most ${ENTRY_LIMITS.lines} rows`);
  // A cell Philobiblos's own list wrote with the formula guard (orders/list.ts) reads as it was.
  return { lines: rows.map((r) => Object.fromEntries(fields.flatMap((f, i) => (f && r[i] !== undefined && r[i] !== '' ? [[f, unguardCell(r[i])]] : [])))), ignored };
}

/** Today in UTC, plus a day: an invoice dated in the household's tomorrow is still today somewhere. */
function checkDate(v: unknown, now: Date): string {
  const s = typeof v === 'string' ? v.trim() : '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00.000Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return bad('date: the day it was bought, YYYY-MM-DD');
  if (s < '1900-01-01' || d.getTime() > now.getTime() + 24 * 3600 * 1000) return bad('date: a day that has come');
  return d.toISOString();
}

/** How many books a row's title names (by matchBook's own rule: its author, if given; never a book with another ISBN). */
function titleNames(books: BookKey[], g: Given): number {
  const title = norm(g.title ?? '');
  const same = books.filter((b) => norm(b.title) === title && !(g.isbn && b.isbn13 && b.isbn13 !== g.isbn));
  return g.author ? same.filter((b) => matchBook([b], { ean: null, title: g.title, author: g.author }) === b.id).length : same.length;
}

/**
 * POST /orders/entries: a quote or an invoice, typed (`lines`) or imported (`csv`); `dryRun` answers what it would do.
 * `connectors` are the ids of the enabled connectors in force, which an invoice's `shop` may name.
 */
export function recordEntry(db: Db, me: string, body: unknown, now = new Date(), connectors?: string[]): EntryResult {
  if (!isObject(body)) return bad('a JSON object is needed');
  for (const k of Object.keys(body)) if (!['kind', 'month', 'number', 'shop', 'date', 'lines', 'csv', 'dryRun', 'mailed'].includes(k)) return bad(`unknown field ${k.slice(0, 40)}`);
  const kind = body.kind;
  if (kind !== 'quote' && kind !== 'invoice') return bad('kind: quote or invoice');
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return bad('dryRun: true or false');
  const dryRun = body.dryRun === true;
  if ((body.lines === undefined) === (body.csv === undefined)) return bad('lines or csv: one of them');

  let month: string | undefined;
  if (kind === 'quote') {
    if (typeof body.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month)) return bad('month: the order\'s month, YYYY-MM');
    month = body.month;
    if (body.date !== undefined) return bad('date: only an invoice has one');
    if (body.number !== undefined) return bad('number: only an invoice has one');
    if (body.shop !== undefined) return bad('shop: only an invoice names one (a quote is its order\'s)');
    if (body.mailed !== undefined) return bad('mailed: only an invoice is asked about a mail');
  } else if (body.month !== undefined) return bad('month: only a quote names its order\'s month');
  const answer = body.mailed === undefined ? null : answerOf(body.mailed);
  const acquiredAt = kind === 'invoice' && body.date !== undefined ? checkDate(body.date, now) : now.toISOString();

  let number: string | null = null;
  if (kind === 'invoice' && body.number !== undefined && body.number !== null && body.number !== '') {
    number = textField(body.number, 'number', ENTRY_LIMITS.number);
    if (number !== null && !/^[\p{L}\p{N}][\p{L}\p{N} ./_-]*$/u.test(number)) return bad('number: letters, digits, spaces and . / _ -');
  }
  // The shop an invoice is from: its number counts once for that shop (two shops may number alike). An enabled
  // connector's id (any case) is that connector, whose mail of the same number then counts once with it; anything else
  // is the household's own label for a shop without a connector, which never stands for a connector's mail.
  let shop: string | null = null;
  if (kind === 'invoice' && body.shop !== undefined && body.shop !== null && body.shop !== '') {
    shop = textField(body.shop, 'shop', ENTRY_LIMITS.shop);
    // `connectors`: the enabled ones in force (the route's, connectors/enabled.ts); else every enabling recorded.
    const ids = connectors ?? db.select({ id: t.connectorEnabled.id }).from(t.connectorEnabled).all().map((c) => c.id);
    const id = shop && ids.find((c) => c.toLowerCase() === shop!.toLowerCase());
    if (id) shop = id;
  }

  const source = body.csv !== undefined ? 'csv' as const : 'typed' as const;
  const { lines: raw, ignored } = source === 'csv' ? csvLines(kind, body.csv) : { lines: body.lines, ignored: [] as string[] };
  if (!Array.isArray(raw) || !raw.length || raw.length > ENTRY_LIMITS.lines) return bad(`lines: 1 to ${ENTRY_LIMITS.lines}`);
  const { currency } = getMoney(db);
  if (!currency) throw new EntryError(409, 'the household has no currency yet: an admin chooses it in Settings');
  const given = raw.map((v, i) => line(kind, i + 1, v, source === 'csv', currency));

  // Whose pile each book goes on: yourself or a kid, never another adult (the Backlog's rule).
  const people = household(db);
  const target = new Map<string, NonNullable<ReturnType<typeof getPerson>>>();
  for (const g of given) {
    if (!g.for || target.has(g.for)) continue;
    const p = g.for === 'me' ? getPerson(db, me) : people.find((x) => x.handle === g.for);
    if (!p) throw new EntryError(404, `row ${g.row}: no one in the household has that handle`);
    if (actsFor(db, me, p.id) !== 'yes') throw new EntryError(403, `row ${g.row}: only they add their own books; for yourself or a kid`);
    target.set(g.for, p);
  }

  const iso = now.toISOString();
  class DryRun { constructor(readonly result: EntryResult) {} }
  try {
    return db.transaction((tx) => {
      const out: EntryLine[] = [];
      /** Books this entry adds: in a dry run they will not exist, so no row names their id. */
      const added = new Set<string>();
      let orderId: string | undefined;
      let quotedTotal = 0;
      const invoiceTotal = kind === 'invoice' ? given.reduce((n, g) => n + g.price! * g.qty, 0) : 0;
      let maybe: MaybeMailed | undefined;
      let same: { key: string; asked: MaybeMailed } | undefined;
      const undo: Undo = { lines: [], orders: [], offers: [] };
      const lineView = (g: Given, b: BookKey | null, isNew: boolean): EntryLine => ({
        row: g.row, bookId: b && !(dryRun && added.has(b.id)) ? b.id : null, new: isNew, title: b?.title ?? g.title!, authors: b?.authors ?? (g.author ? [g.author] : []),
        isbn13: b?.isbn13 ?? g.isbn, qty: kind === 'invoice' ? g.qty : null, price: g.price, available: g.available, for: g.for,
      });

      if (kind === 'invoice') {
        if (number !== null) {
          // The unique index order_entry_number holds the same rule.
          if (tx.select({ id: t.orderEntry.id }).from(t.orderEntry).where(and(sql`upper(${t.orderEntry.number}) = upper(${number})`, sql`upper(${t.orderEntry.shop}) = upper(${shop ?? ''})`)).get()) {
            throw new EntryError(409, `invoice ${number}${shop ? ` from ${shop}` : ''} is recorded already`);
          }
          // A connector's own mail of this number (only when the shop is that connector: a label or none matches no mail).
          const mailed = tx.select({ id: t.mailSeen.messageId }).from(t.mailSeen)
            .where(and(eq(t.mailSeen.accepted, 1), eq(t.mailSeen.kind, 'invoice'), sql`upper(json_extract(${t.mailSeen.parsedJson}, '$.invoiceNumber')) = upper(${number})`,
              sql`json_extract(${t.mailSeen.authJson}, '$.connector') = ${shop}`,
              // A mail sent again counts as its first (which this finds); one counted as a typed entry (philobiblos#45) counts.
              sql`(json_extract(${t.mailSeen.parsedJson}, '$.duplicateOf') IS NULL OR json_extract(${t.mailSeen.parsedJson}, '$.duplicateOf') LIKE 'entry:%')`)).get();
          if (mailed) throw new EntryError(409, `invoice ${number} came in the bookshop's mail already, and counts from there`);
        }
        const books = keys(tx);
        // The bookshop's mail it may be (philobiblos#58): only when every row names a book Philobiblos has already.
        const ids = given.map((g) => matchBook(books, { ean: g.isbn, title: g.title, author: g.author }));
        const fit = ids.every((x) => x !== null) ? maybeMailed(tx, { number, lines: given.map((g, i) => ({ bookId: ids[i]!, qty: g.qty })), total: invoiceTotal }, iso) : null;
        const asked = fit && askedOf(fit, invoiceTotal);
        // An answer about this mail answers it; none, or one about another mail, asks (a dry run only names it).
        const answered = asked && answer?.mail === asked.mail ? answer.answer : null;
        if (asked && !answered && !dryRun) throw new EntryError(409, `Is this the invoice that came by mail on ${longDay(asked.cameOn)}?`, asked);
        if (!asked && answer?.answer === 'same') throw new EntryError(409, 'no mail fits this invoice now: record it as it is, or check it again');
        if (asked && !answered) maybe = asked;
        if (asked && answered === 'same') {
          // The same invoice as the mail: nothing new counted; kept as the mail's duplicate.
          same = { key: fit.key, asked };
          for (const [i, g] of given.entries()) out.push(lineView(g, books.find((b) => b.id === ids[i])!, false));
        }
        const invoiced = new Map<string, number>();
        // What it does, kept to undo it (undoEntry): the values each row had before it, and the ones it left.
        const priced = new Map<string, OfferRow | null>();
        for (const [i, g] of (same ? [] : given).entries()) {
          const person = g.for ? target.get(g.for)! : null;
          // A row of a book an earlier row of this entry added names it now.
          let id = ids[i] ?? matchBook(books, { ean: g.isbn, title: g.title, author: g.author });
          const isNew = !id;
          if (!id) {
            if (!g.title) throw new EntryError(400, `row ${g.row}: no book has this ISBN yet: add its title`);
            // matchBook's null is none or several: several is refused, never a book more beside them.
            if (titleNames(books, g) > 1) throw new EntryError(400, `row ${g.row}: its title names several books: add the author or the ISBN`);
            id = ulid();
            tx.insert(t.book).values({ id, title: g.title, authorsJson: JSON.stringify(g.author ? [g.author] : []), isbn13: g.isbn, audience: person?.role === 'kid' ? 'kids' : 'adult', normKey: `${norm(g.title)}|${norm(g.author ?? '')}`, createdAt: iso }).run();
            books.push({ id, title: g.title, authors: g.author ? [g.author] : [], isbn13: g.isbn });
            added.add(id);
          }
          if (!priced.has(id)) priced.set(id, offerOf(tx, id));
          const trace: Delivered = { copies: [], tap: null, line: null };
          const ordered = receive(tx, { bookId: id, qty: g.qty, unitC: g.price!, acquiredAt, source: 'manual' }, iso, trace);
          if (ordered) invoiced.set(ordered, (invoiced.get(ordered) ?? 0) + g.price! * g.qty);
          const piled = !!person && tx.insert(t.reading).values({ personId: person.id, bookId: id, status: 'to_read', updatedAt: iso }).onConflictDoNothing().run().changes > 0;
          undo.lines.push({ ...trace, bookId: id, orderId: ordered, priceC: g.price!, acquiredAt, reading: piled ? person!.id : null });
          out.push(lineView(g, books.find((b) => b.id === id)!, isNew));
        }
        for (const [id, c] of invoiced) {
          const o = tx.select().from(t.order).where(eq(t.order.id, id)).get()!;
          undo.orders.push({ id, c, was: { status: o.status, invoicedC: o.invoicedC } });
        }
        invoiceOrders(tx, invoiced);
        for (const [bookId, was] of priced) undo.offers.push({ bookId, was, left: offerOf(tx, bookId) });
      } else {
        const order = tx.select().from(t.order).where(eq(t.order.month, month!)).orderBy(desc(t.order.createdAt)).get();
        if (!order) throw new EntryError(404, `no order for ${month}`);
        if (order.status === 'picked') throw new EntryError(409, `the ${month} order has not gone to a bookshop yet: compose it first`);
        if (order.status !== 'drafted' && order.status !== 'quoted') throw new EntryError(409, `the ${month} order is ${order.status} already`);
        orderId = order.id;
        const books = keys(tx, orderBooks(tx, order.id));
        const named = new Map<string, number>();
        const matched = given.map((g) => {
          const id = matchBook(books, { ean: g.isbn, title: g.title, author: g.author });
          if (!id) throw new EntryError(400, `row ${g.row}: no book of the order (${month}) has this ISBN or title`);
          if (named.has(id)) throw new EntryError(400, `row ${g.row}: names the book of row ${named.get(id)} twice`);
          named.set(id, g.row);
          out.push(lineView(g, books.find((b) => b.id === id)!, false));
          // The delivery a shop's mail gave stays: a typed row says nothing about it.
          const delivery = tx.select({ d: t.orderLine.delivery }).from(t.orderLine).where(and(eq(t.orderLine.orderId, order.id), eq(t.orderLine.bookId, id))).get()?.d ?? null;
          return { bookId: id, available: g.available, priceC: g.available ? g.price : null, delivery };
        });
        quoteOrder(tx, order, matched, iso, order.mailThreadRef);
        quotedTotal = tx.select({ c: t.order.quotedC }).from(t.order).where(eq(t.order.id, order.id)).get()?.c ?? 0;
      }

      // An invoice's total is its own rows'; a quote's is the order's, as quoted now (a correction of one book included).
      const total = kind === 'quote' ? quotedTotal : invoiceTotal;
      const result: EntryResult = {
        kind, source, dryRun, ...(month ? { month } : {}), ...(orderId ? { orderId } : {}), number, shop, total, lines: out, ignoredColumns: ignored,
        ...(maybe ? { maybeMailed: maybe } : {}), ...(same ? { sameAsMail: same.asked } : {}),
      };
      if (dryRun) throw new DryRun(result);
      const id = ulid();
      tx.insert(t.orderEntry).values({
        id, kind, source, number, shop: shop ?? '', orderId: orderId ?? null, personId: me, totalC: total, createdAt: iso,
        linesJson: JSON.stringify(out.map((l) => ({ bookId: l.bookId, qty: l.qty, priceC: l.price, available: l.available }))),
        undoJson: kind === 'invoice' ? JSON.stringify(undo) : null, duplicateOf: same?.key ?? null,
      }).run();
      return { id, ...result };
    });
  } catch (e) {
    if (e instanceof DryRun) return e.result;
    throw e;
  }
}

/** The answer to "Is this the invoice that came by mail on …?", sent with the entry again (`mailed`). */
function answerOf(v: unknown): { mail: string; answer: 'same' | 'another' } {
  if (!isObject(v)) return bad('mailed: { mail, answer }');
  for (const k of Object.keys(v)) if (k !== 'mail' && k !== 'answer') return bad(`mailed: unknown field ${k.slice(0, 40)}`);
  if (typeof v.mail !== 'string' || !/^m_[0-9a-f]{32}$/.test(v.mail)) return bad('mailed.mail: the mail it was asked about');
  if (v.answer !== 'same' && v.answer !== 'another') return bad('mailed.answer: same or another');
  return { mail: v.mail, answer: v.answer };
}

/** The question's mail: its Inbox item id, the day it names (its Date header's, else the day it was read), number and total. */
function askedOf(m: MailedInvoice, total: number): MaybeMailed {
  const at = m.date ? Date.parse(m.date) : Number.NaN;
  const cameOn = m.day && DAY.test(m.day) ? m.day : `${(Number.isNaN(at) ? m.seenAt : new Date(at).toISOString()).slice(0, 10)}T00:00:00.000Z`;
  return { mail: mailItemId(m.key), cameOn, number: m.number, total };
}

/** An invoice's price learnt for a book (book_offer, source invoice), or none. */
type OfferRow = { priceC: number | null; availability: string | null; seenAt: string };
const offerOf = (tx: Tx, bookId: string): OfferRow | null => {
  const o = tx.select().from(t.bookOffer).where(and(eq(t.bookOffer.bookId, bookId), eq(t.bookOffer.source, 'invoice'))).get();
  return o ? { priceC: o.priceC, availability: o.availability, seenAt: o.seenAt } : null;
};
/**
 * What an invoice entry did (order_entry.undo_json), ids and amounts only: per row, the copies it made (of `orderId`,
 * at `priceC`, acquired at `acquiredAt`), the tap's copy it took and the order line it delivered (with what each was),
 * and whose pile it put the book on (a reading row it added); per order, what it added to the invoiced total and what
 * the order was; per book, the price learnt before and after it.
 */
interface Undo {
  lines: (Delivered & { bookId: string; orderId: string | null; priceC: number; acquiredAt: string; reading: string | null })[];
  orders: { id: string; c: number; was: { status: string; invoicedC: number | null } }[];
  offers: { bookId: string; was: OfferRow | null; left: OfferRow | null }[];
}

/**
 * Copies of a book made after the entry `entryId` (a ULID: copies made later have later ids), of no order, by an
 * invoice (mailed: invoice; typed or imported: manual). A tap's copy is always of its order, so never one of these.
 */
function laterCopies(tx: Tx, bookId: string, entryId: string) {
  return tx.select().from(t.copy).where(and(eq(t.copy.bookId, bookId), isNull(t.copy.orderId), inArray(t.copy.source, ['invoice', 'manual']), sql`${t.copy.id} > ${entryId}`)).all();
}

/** How long after it was recorded an invoice entry may be undone. */
export const UNDO_DAYS = 7;
const DAY_MS = 86_400_000;

/** Who may undo an entry: whoever recorded it, or an admin (the household's orders are any adult's to see). */
function mayUndo(db: Db, me: string, e: { personId: string | null }): boolean {
  return e.personId === me || getPerson(db, me)?.role === 'admin';
}

/**
 * POST /orders/entries/{id}/undo (philobiblos#45): a mistyped invoice undone, everything it did and only that, while
 * nothing has changed it since. Whoever recorded it, or an admin (403 for another adult; kids have no access), within
 * UNDO_DAYS of recording it; a quote is corrected by typing the quote again, never undone (409).
 *
 * Refused (409, nothing changed) when a copy it made is gone or changed, a tap's copy it took has changed, an order
 * line it delivered is no longer as it left it, an order it invoiced is closed or invoiced for less than it added, or
 * a bookshop's mail counts as it (or waits in the Inbox as maybe it): undoing it would leave that mail uncounted.
 * Otherwise, in one transaction: its copies removed, the tap's copy and its line the tap's again, the order lines it
 * delivered as they were (or, for a book bought again since by an invoice of no order, that purchase's: it takes the line
 * over, and the place of a tap's copy the entry took, and the order is invoiced for it; refused, 409, when it is not
 * clear which purchase that is), each order's invoiced total less what it added (with nothing left invoiced, the order as it
 * was before its first invoice), a price it learnt put back as it was unless another invoice has changed it since,
 * a pile it put a book on left without it unless that book has been touched since, and the entry gone, so its number
 * may be typed again. A book it added stays: it may be known elsewhere by now.
 */
export function undoEntry(db: Db, me: string, id: string, now = new Date()): void {
  db.transaction((tx) => {
    const e = tx.select().from(t.orderEntry).where(eq(t.orderEntry.id, id)).get();
    if (!e) throw new EntryError(404, 'no such entry');
    if (!mayUndo(db, me, e)) throw new EntryError(403, 'only whoever recorded it, or an admin, undoes it');
    if (e.kind !== 'invoice') throw new EntryError(409, 'a quote is not undone: type the quote again to correct it');
    if (now.getTime() - Date.parse(e.createdAt) > UNDO_DAYS * DAY_MS) throw new EntryError(409, `recorded more than ${UNDO_DAYS} days ago: it stays`);
    if (!e.undoJson) throw new EntryError(409, 'recorded before an invoice could be undone: it stays');
    const mail = tx.select({ p: t.mailSeen.parsedJson }).from(t.mailSeen).where(and(eq(t.mailSeen.accepted, 1), eq(t.mailSeen.kind, 'invoice'),
      sql`(json_extract(${t.mailSeen.parsedJson}, '$.duplicateOf') = ${`entry:${id}`} OR json_extract(${t.mailSeen.parsedJson}, '$.maybeTyped') = ${id})`)).get();
    if (mail) {
      throw new EntryError(409, JSON.parse(mail.p ?? '{}').maybeTyped === id
        ? 'a bookshop mail waits in the Inbox as maybe this invoice: answer it first'
        : 'the bookshop\'s mail of this invoice counts as it: undoing it would leave the mail uncounted');
    }
    const u = JSON.parse(e.undoJson) as Undo;

    // Everything checked before anything changes.
    const changed = (m: string): never => { throw new EntryError(409, `${m} has changed since: the invoice stays`); };
    for (const l of u.lines) {
      for (const c of l.copies) {
        const row = tx.select().from(t.copy).where(eq(t.copy.id, c)).get();
        if (!row || row.bookId !== l.bookId || row.source !== 'manual' || row.orderId !== l.orderId || row.priceC !== l.priceC || row.acquiredAt !== l.acquiredAt) changed('one of its copies');
      }
      if (l.tap) {
        const row = tx.select().from(t.copy).where(eq(t.copy.id, l.tap.copyId)).get();
        if (!row || row.bookId !== l.bookId || row.source !== 'manual' || row.orderId !== l.orderId || row.priceC !== l.priceC) changed('one of its copies');
      }
      if (l.line) {
        const row = tx.select().from(t.orderLine).where(and(eq(t.orderLine.orderId, l.line.orderId), eq(t.orderLine.bookId, l.bookId))).get();
        if (!row || row.state !== 'delivered' || row.copyId !== null || row.tappedFrom !== null) changed('an order line it delivered');
      }
    }
    for (const o of u.orders) {
      const row = tx.select().from(t.order).where(eq(t.order.id, o.id)).get();
      if (!row || row.status !== 'invoiced' || (row.invoicedC ?? 0) < o.c) changed('the order it invoiced');
    }
    // A line it delivered, of a book bought again since, of no order (an invoice read or typed after it, which found
    // the line delivered already): that purchase takes the line over rather than leave it to buy (philobiblos#45 review).
    // A line it took from a tap too: the later purchase would have taken the tap's copy had this entry not been typed
    // (mail/effects.ts deliver), so it takes the tap's place, and the tap's copy goes.
    const handover = new Map<number, string[]>();
    const added = new Map<string, number>();
    const own = new Set(u.lines.flatMap((l) => l.copies));
    for (const [i, l] of u.lines.entries()) {
      if (!l.line) continue;
      const later = laterCopies(tx, l.bookId, id).filter((c) => !own.has(c.id));
      if (!later.length) continue;
      const purchases = new Set(later.map((c) => `${c.source}|${c.acquiredAt}|${c.priceC}`));
      if (purchases.size > 1 || later.length !== l.copies.length + (l.tap ? 1 : 0)) {
        throw new EntryError(409, 'its book was bought again since, and it is not clear which purchase the order line goes to: the invoice stays');
      }
      handover.set(i, later.map((c) => c.id));
      added.set(l.line.orderId, (added.get(l.line.orderId) ?? 0) + later.reduce((n, c) => n + (c.priceC ?? 0), 0));
    }

    for (const [i, l] of u.lines.entries()) {
      for (const c of l.copies) tx.delete(t.copy).where(eq(t.copy.id, c)).run();
      const later = handover.get(i);
      if (l.tap && later) tx.delete(t.copy).where(eq(t.copy.id, l.tap.copyId)).run();
      else if (l.tap) tx.update(t.copy).set(l.tap.was).where(eq(t.copy.id, l.tap.copyId)).run();
      if (later && l.line) tx.update(t.copy).set({ orderId: l.line.orderId }).where(inArray(t.copy.id, later)).run();
      else if (l.line) tx.update(t.orderLine).set(l.line.was as { state: 'planned' }).where(and(eq(t.orderLine.orderId, l.line.orderId), eq(t.orderLine.bookId, l.bookId))).run();
      if (l.reading) {
        tx.delete(t.reading).where(and(eq(t.reading.personId, l.reading), eq(t.reading.bookId, l.bookId), eq(t.reading.status, 'to_read'), eq(t.reading.updatedAt, e.createdAt))).run();
      }
    }
    for (const o of u.orders) {
      const row = tx.select().from(t.order).where(eq(t.order.id, o.id)).get()!;
      const left = (row.invoicedC ?? 0) - o.c + (added.get(o.id) ?? 0);
      // Nothing left of what it was invoiced: still invoiced while a line of it stays delivered by an invoice (a free
      // one, say; a tap's line is no invoice's), else as it was before its first invoice.
      const invoicedLine = tx.select({ b: t.orderLine.bookId }).from(t.orderLine)
        .where(and(eq(t.orderLine.orderId, o.id), eq(t.orderLine.state, 'delivered'), isNull(t.orderLine.copyId))).get();
      const before = o.was.status !== 'invoiced' ? o.was : { status: row.quotedC != null ? 'quoted' : 'drafted', invoicedC: null };
      tx.update(t.order).set(left > 0 || invoicedLine ? { invoicedC: left } : before as { status: 'quoted'; invoicedC: number | null }).where(eq(t.order.id, o.id)).run();
    }
    for (const o of u.offers) {
      if (JSON.stringify(offerOf(tx, o.bookId)) !== JSON.stringify(o.left)) continue;
      const at = and(eq(t.bookOffer.bookId, o.bookId), eq(t.bookOffer.source, 'invoice'));
      if (o.was) tx.insert(t.bookOffer).values({ bookId: o.bookId, source: 'invoice', ...o.was }).onConflictDoUpdate({ target: [t.bookOffer.bookId, t.bookOffer.source], set: o.was }).run();
      else tx.delete(t.bookOffer).where(at).run();
    }
    tx.delete(t.orderEntry).where(eq(t.orderEntry.id, id)).run();
  }, { behavior: 'immediate' });
}

/** GET /orders/entries: the invoices typed in or imported in the last UNDO_DAYS days, newest first (at most 50). */
export function recentEntries(db: Db, me: string, now = new Date()) {
  const since = new Date(now.getTime() - UNDO_DAYS * DAY_MS).toISOString();
  return db.select().from(t.orderEntry).where(and(eq(t.orderEntry.kind, 'invoice'), sql`${t.orderEntry.createdAt} >= ${since}`))
    .orderBy(desc(t.orderEntry.createdAt), desc(t.orderEntry.id)).limit(50).all().map((e) => {
      const by = e.personId ? getPerson(db, e.personId) : null;
      return {
        id: e.id, createdAt: e.createdAt, source: e.source, number: e.number, shop: e.shop || null, total: e.totalC,
        // One answered the same as a mail made no copies: the mail did.
        copies: e.duplicateOf ? 0 : (JSON.parse(e.linesJson) as { qty: number | null }[]).reduce((n, l) => n + (l.qty ?? 0), 0),
        sameAsMail: e.duplicateOf != null,
        ...(by ? { by: view(db, by) } : {}),
        // Who and when only: whether nothing has changed since is answered by the undo itself.
        canUndo: e.undoJson != null && mayUndo(db, me, e),
      };
    });
}
