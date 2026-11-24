// How a connector's words are matched (connectors/<id>/connector.yaml). A connector holds plain words and phrases, never a
// regular expression: what is built here from them is a fixed shape, written in this file, with each word escaped as a
// literal. Every shape is an alternation of literals with at most one bounded or single-character quantifier around it,
// so matching is linear in the text (and the words are few and short: contracts/connector.schema.json). Nothing a
// connector says can add a quantifier, a group or a backreference.
import { toHundredths } from '@philobiblos/contracts/money';

// The syntax characters of a pattern (the only ones the u flag lets be escaped).
const SPECIAL = /[\\^$.*+?()[\]{}|/]/g;
/** A word or phrase as a literal inside a pattern. */
export const literal = (s: string) => s.replace(SPECIAL, '\\$&');

/** Folded for comparing: NFKC, format characters (zero-width spaces, soft hyphens) gone, white space as one space. */
export const fold = (s: string) => s.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();

/**
 * The phrases as one alternation, longest first (so "delivery time" wins over "delivery"). A word ending in `*`
 * (only the summary's and invoice's word lists allow it) stands for any word that begins so: `subtotal*` is subtotals.
 */
export function alternation(phrases: readonly string[]): string {
  const sorted = [...phrases].sort((a, b) => b.length - a.length || a.localeCompare(b));
  return `(?:${sorted.map((p) => (p.endsWith('*') ? `${literal(p.slice(0, -1))}\\p{L}*` : literal(p))).join('|')})`;
}

const NOT_WORD_BEFORE = '(?<![\\p{L}\\p{N}])';
const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}])';

/** A line that begins with one of the phrases, as a whole word or words. */
export function startsWith(phrases: readonly string[]): (line: string) => boolean {
  const re = new RegExp(`^${alternation(phrases)}${NOT_WORD_AFTER}`, 'iu');
  return (l) => re.test(l);
}

/** A line that holds one of the phrases anywhere, as a whole word or words. */
export function contains(phrases: readonly string[]): (line: string) => boolean {
  const re = new RegExp(`${NOT_WORD_BEFORE}${alternation(phrases)}${NOT_WORD_AFTER}`, 'iu');
  return (l) => re.test(l);
}

/**
 * A subject template such as `Your order ({number})`: the subject, folded and in any case, is the text before
 * `{number}`, then a number (a digit, then digits and spaces), then the text after it. A space before `{number}` may be
 * left out (`Nr.123`). The number is returned as written; whether it reads (4 to 11 digits) is the caller's question.
 */
export function subjectMatcher(template: string): (subject: string) => string | null {
  const at = template.indexOf('{number}');
  const head = template.slice(0, at);
  const before = fold(head).toLowerCase();
  const after = fold(template.slice(at + '{number}'.length)).toLowerCase();
  const re = new RegExp(`^${literal(before)}${/\s$/.test(head) ? ' ?' : ''}(\\d[\\d ]*)${/^\s/.test(template.slice(at + 8)) ? ' ' : ''}${literal(after)}$`, 'u');
  return (subject) => {
    const s = fold(subject).toLowerCase();
    const m = re.exec(s);
    return m ? m[1]!.trimEnd() : null;
  };
}

/** Money as the connector writes it: a symbol before the amount (`<symbol> 19.90`) or after it (`19.90 <symbol>`). */
export interface Money { before: string[]; after: string[] }

/**
 * An amount's number in a currency with `digits` decimals (philobiblos#62), as a pattern with two captures: its whole
 * units, grouped by thousands (with `,`, `.` or `'`, the same one throughout, up to 10,000,000,000) or not grouped, and
 * its decimals: exactly the currency's, after a point or a comma that is not the grouping's (`1,234.50`, `1.234,50`), or
 * none in a currency without decimals (`1,980`). It never stops inside a number: a digit, or a separator and a digit,
 * after it is no amount (`1,98` in a currency without decimals, `19.905` in one with two). Bounded alternatives only:
 * linear.
 */
export function amountNumber(digits: number): string {
  const grouped = (sep: string) => `\\d{1,3}(?:${sep}\\d{3}){1,3}`;
  const units = digits > 0
    ? `(${grouped(',')}(?=\\.)|${grouped('\\.')}(?=,)|${grouped("'")}|\\d{1,11})[.,](\\d{${digits}})`
    : `(${grouped(',')}|${grouped('\\.')}|${grouped("'")}|\\d{1,11})()`;
  return `${units}(?![.,']?\\d)`;
}

/** The two captures of `amountNumber` in hundredths; `below` when its decimals have a thousandth (not kept); else null. */
export function readNumber(units: string, decimals: string, digits: number): number | 'below' | null {
  if (/[1-9]/.test(decimals.slice(2))) return 'below';
  return toHundredths(units.replace(/[,.']/g, ''), decimals, digits);
}

/** The first amount in a line, a symbol before it or after it, read by `readNumber`. */
function amountReader(m: Money, digits: number): (s: string) => number | 'below' | null {
  const n = amountNumber(digits);
  // A side without symbols has no branch (an empty alternation would match any number).
  const before = m.before.length ? `${alternation(m.before)}\\s?${n}` : '(?!)()()';
  const after = m.after.length ? `(?<![\\d.,'])${n}\\s?${alternation(m.after)}${NOT_WORD_AFTER}` : '(?!)()()';
  const re = new RegExp(`${before}|${after}`, 'iu');
  return (s) => {
    const x = re.exec(s);
    return x ? readNumber(x[1] ?? x[3]!, x[2] ?? x[4]!, digits) : null;
  };
}

/**
 * Hundredths of the first amount in a line, written with the currency's `digits` decimals (household/currency.ts), at
 * most any amount's ceiling; or null. An amount with a thousandth is null too (`amountBelow` says so).
 */
export function amountFinder(m: Money, digits: number): (s: string) => number | null {
  const read = amountReader(m, digits);
  return (s) => { const c = read(s); return c === 'below' ? null : c; };
}

/** Whether the first amount in a line has a thousandth (`1.255` in a currency with three decimals): why it is not read, said as such. */
export function amountBelow(m: Money, digits: number): (s: string) => boolean {
  const read = amountReader(m, digits);
  return (s) => read(s) === 'below';
}

/** Whether a line holds an amount at all (a symbol and a digit, or an amount with the currency's decimals and a symbol after it). */
export function amountTest(m: Money, digits: number): (s: string) => boolean {
  const re = new RegExp(`${alternation(m.before)}\\s?\\d|\\d${digits > 0 ? `[.,]\\d{${digits}}` : ''}\\s?${alternation(m.after)}${NOT_WORD_AFTER}`, 'iu');
  return (s) => re.test(s);
}
