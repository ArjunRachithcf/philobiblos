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
import { and, desc, eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { bookIsbn } from '../books/isbn';
import { BUDGET_CEILING_C } from '../household/budget';
import { getMoney } from '../household/money';
import { actsFor, getPerson, household } from '../household/people';
import { invoiceOrders, keys, matchBook, orderBooks, quoteOrder, receive, type BookKey } from '../mail/effects';
import { safeField } from '../mail/read';
import { norm } from '../seed/import';
import { CsvError, parseCsv } from './csv';
import { unguardCell } from './list';

/** At most 100 lines (a parser's books a mail), 20 copies a line (the Inbox's), a price at most the budget's ceiling. */
export const ENTRY_LIMITS = { lines: 100, qty: 20, price: BUDGET_CEILING_C, number: 40, shop: 80, title: 300, author: 200 } as const;

export class EntryError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
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

/** One line, from JSON (`price` in hundredths) or a CSV's row (its cells as text: `price` an amount such as 18.90). */
function line(kind: EntryKind, row: number, v: unknown, csv: boolean): Given {
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
      // An amount in the household's currency as a person writes it: digits, then a point or a comma and one or two
      // more. No symbol, sign or thousands separator: an amount Philobiblos cannot place is refused, never guessed.
      const m = typeof p === 'string' ? /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(p.trim()) : null;
      p = m ? Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0')) : null;
      if (p === null) return at('price: an amount such as 18.90, in the household\'s currency');
    }
    if (!Number.isInteger(p) || (p as number) < 0 || (p as number) > ENTRY_LIMITS.price) return at(`price: whole hundredths of the household's currency, 0 to ${ENTRY_LIMITS.price}`);
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
  for (const k of Object.keys(body)) if (!['kind', 'month', 'number', 'shop', 'date', 'lines', 'csv', 'dryRun'].includes(k)) return bad(`unknown field ${k.slice(0, 40)}`);
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
  } else if (body.month !== undefined) return bad('month: only a quote names its order\'s month');
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
  const given = raw.map((v, i) => line(kind, i + 1, v, source === 'csv'));

  if (!getMoney(db).currency) throw new EntryError(409, 'the household has no currency yet: an admin chooses it in Settings');

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
      const view = (g: Given, b: BookKey | null, isNew: boolean): EntryLine => ({
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
              sql`json_extract(${t.mailSeen.authJson}, '$.connector') = ${shop}`, sql`json_extract(${t.mailSeen.parsedJson}, '$.duplicateOf') IS NULL`)).get();
          if (mailed) throw new EntryError(409, `invoice ${number} came in the bookshop's mail already, and counts from there`);
        }
        const books = keys(tx);
        const invoiced = new Map<string, number>();
        for (const g of given) {
          const person = g.for ? target.get(g.for)! : null;
          let id = matchBook(books, { ean: g.isbn, title: g.title, author: g.author });
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
          const ordered = receive(tx, { bookId: id, qty: g.qty, unitC: g.price!, acquiredAt, source: 'manual' }, iso);
          if (ordered) invoiced.set(ordered, (invoiced.get(ordered) ?? 0) + g.price! * g.qty);
          if (person) tx.insert(t.reading).values({ personId: person.id, bookId: id, status: 'to_read', updatedAt: iso }).onConflictDoNothing().run();
          out.push(view(g, books.find((b) => b.id === id)!, isNew));
        }
        invoiceOrders(tx, invoiced);
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
          out.push(view(g, books.find((b) => b.id === id)!, false));
          // The delivery a shop's mail gave stays: a typed row says nothing about it.
          const delivery = tx.select({ d: t.orderLine.delivery }).from(t.orderLine).where(and(eq(t.orderLine.orderId, order.id), eq(t.orderLine.bookId, id))).get()?.d ?? null;
          return { bookId: id, available: g.available, priceC: g.available ? g.price : null, delivery };
        });
        quoteOrder(tx, order, matched, iso, order.mailThreadRef);
        quotedTotal = tx.select({ c: t.order.quotedC }).from(t.order).where(eq(t.order.id, order.id)).get()?.c ?? 0;
      }

      // An invoice's total is its own rows'; a quote's is the order's, as quoted now (a correction of one book included).
      const total = kind === 'quote' ? quotedTotal : given.reduce((n, g) => n + g.price! * g.qty, 0);
      const result: EntryResult = { kind, source, dryRun, ...(month ? { month } : {}), ...(orderId ? { orderId } : {}), number, shop, total, lines: out, ignoredColumns: ignored };
      if (dryRun) throw new DryRun(result);
      const id = ulid();
      tx.insert(t.orderEntry).values({
        id, kind, source, number, shop: shop ?? '', orderId: orderId ?? null, personId: me, totalC: total, createdAt: iso,
        linesJson: JSON.stringify(out.map((l) => ({ bookId: l.bookId, qty: l.qty, priceC: l.price, available: l.available }))),
      }).run();
      return { id, ...result };
    });
  } catch (e) {
    if (e instanceof DryRun) return e.result;
    throw e;
  }
}
