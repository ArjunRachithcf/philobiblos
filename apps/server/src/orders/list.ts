// No-shop mode (philobiblos#27 slice 5): the month's order as a plain list for any shop, or none. Three forms: the mail
// text (a mailto: with no recipient, the person picks one in their own mail app), a printable page (the web app's), and
// a CSV. None holds the delivery address, a person's name or a card number: a list may be printed, posted or left on a
// counter. The CSV's columns are the ones an invoice imported reads (orders/entries.ts), so the same file, with the
// prices paid filled in, records what was bought; its `estimate` column is named back there and never read.
//
// A spreadsheet runs a cell that starts with `=`, `+`, `-` or `@` (or a tab or carriage return before one) as a formula,
// and titles and authors come from anywhere (a shop's mail, a CSV, a share): such a cell is written with a leading `'`,
// which every spreadsheet shows as text (OWASP "CSV Injection"; philobiblos#45). So does a cell whose first visible
// character is one of them in another form (NFKC: full-width, small, super- or subscript) after invisible characters
// (zero-width spaces, joiners, a byte order mark), and a cell that starts with `'` itself, so the importer, which leaves
// that one quote out again (`unguardCell`), gives back what was written (philobiblos#47). Pure: no database, no clock.
import { orderText, type OrderLineText } from '../month/order-mail';

/** A cell a spreadsheet would read as a formula: one of = + - @ (or their full-width forms), after any spaces, or a tab or CR first. */
const FORMULA = /^(?:[\t\r]|\s*[=+\-@\uff1d\uff0b\uff0d\uff20])/;

/**
 * Starts like a formula: FORMULA, or = + - @ in any NFKC form (small ﹢, superscript ⁺, …) as its first visible
 * character, after invisible format characters (\p{Cf}: zero-width space and joiners, word joiner, BOM) and spaces.
 */
const formulaStart = (v: string) => FORMULA.test(v) || /^[\p{Cf}\s]*[=+\-@]/u.test(v.normalize('NFKC'));

/** One CSV cell: quoted (a quote inside written twice), a formula neutralised, line breaks and control characters as spaces. */
export function csvCell(value: string): string {
  // One row stays one line: control characters become spaces. The guard looks at the value as given (a leading tab or
  // CR counts) and as written (spaces before a formula character count). A `'` first gets one more, which the importer
  // reads back out: never lost on a round trip.
  const flat = value.replace(/\p{Cc}/gu, ' ');
  const guarded = formulaStart(value) || formulaStart(flat) || flat.startsWith('\'') ? `'${flat}` : flat;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * A cell as the guard wrote it, read back: the one `'` before a formula character, before the spaces a tab or CR
 * became, or before another `'` left out. Anything else as it is, so a hand-written "'s-Hertogenbosch" keeps its
 * apostrophe (and the guard's "''s-Hertogenbosch" comes back as it). A hand-written cell that starts with two loses
 * one: that is the guard's own form, and no title starts so.
 */
export function unguardCell(cell: string): string {
  const rest = cell.slice(1);
  return cell.startsWith('\'') && (formulaStart(rest) || /^\s/.test(rest) || rest.startsWith('\'')) ? rest : cell;
}

export interface ListRow { title: string; authors: string[]; isbn13: string | null; estimateC: number | null }

/** An amount in hundredths as the importer reads it: digits, a point, two more. */
const amount = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

/** An ISBN-13 a spreadsheet keeps as text (a plain 13-digit number turns into 9.78E+12): its prefix hyphenated. */
const isbnCell = (isbn: string) => `${isbn.slice(0, 3)}-${isbn.slice(3)}`;

export const LIST_COLUMNS = ['isbn', 'title', 'author', 'qty', 'price', 'estimate'] as const;

/**
 * The list as a CSV (RFC 4180, CRLF, a byte order mark so spreadsheets read UTF-8): a row a book, its first author (the
 * importer matches one), one copy, the price left empty for what was paid, and the estimate.
 */
export function listCsv(rows: ListRow[]): string {
  const lines = [LIST_COLUMNS.join(','), ...rows.map((r) => [
    r.isbn13 ? isbnCell(r.isbn13) : '', r.title, r.authors[0] ?? '', '1', '', r.estimateC != null ? amount(r.estimateC) : '',
  ].map(csvCell).join(','))];
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

/** The list's mail text: the order's, with no delivery address and no name (the person adds them if a shop needs them). */
export function listText(o: { month: string; lines: OrderLineText[] }) {
  return orderText({ ...o, deliveryAddress: null, signedBy: '' });
}
