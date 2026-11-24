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

/**
 * Money as the connector writes it: a symbol before the amount (`<symbol> 19.90`) or after it (`19.90 <symbol>`), and
 * optionally its decimal mark and its thousands groups (contracts/connector.schema.json `money`, philobiblos#62).
 */
export interface Money { before: string[]; after: string[]; decimal?: '.' | ','; groups?: readonly (',' | '.' | "'" | ' ')[] }

/** How each group separator is matched: a space is any of the spaces a page or a PDF writes between thousands. */
const GROUP: Record<',' | '.' | "'" | ' ', string> = { ',': ',', '.': '\\.', "'": "'", ' ': '[ \\u00a0\\u202f]' };
/** Whatever could continue a number after it: a separator (or a space) and a digit, or a digit. */
const CONTINUES = "(?![.,'\\s]?\\d)";

/**
 * An amount's number in a currency with `digits` decimals (philobiblos#62), as a pattern with two captures: its whole
 * units, grouped by thousands (the same separator throughout, up to 10,000,000,000) or not grouped, and its decimals:
 * exactly the currency's, after the decimal mark, or none in a currency without decimals (`1,980`). Groups are `,` `.`
 * and `'` unless the connector names its own (a space only then); the decimal mark is the connector's, or else a point
 * or a comma that is not the grouping's (`1,234.50`, `1.234,50`). In a currency with three decimals a connector must
 * name its decimal mark (`1,250` is 1.25 or 1250): without one, nothing matches. It never stops inside a number: a
 * digit, or a separator or a space and a digit, after it is no amount (`1,98` without decimals, `19.905` with two,
 * `12 500` without space groups). Bounded alternatives only: linear.
 */
export function amountNumber(digits: number, m: Pick<Money, 'decimal' | 'groups'> = {}): string {
  if (digits > 2 && !m.decimal) return '(?!)()()';
  const groups = m.groups ?? ([',', '.', "'"] as const).filter((g) => g !== m.decimal);
  const mark = m.decimal ? GROUP[m.decimal] : '[.,]';
  const grouped = groups.map((g) => {
    const run = `\\d{1,3}(?:${GROUP[g]}\\d{3}){1,3}`;
    // Without a named decimal mark, a point or a comma grouping is followed by the other one only.
    return digits > 0 && !m.decimal && (g === ',' || g === '.') ? `${run}(?=${g === ',' ? '\\.' : ','})` : run;
  });
  const units = `(${[...grouped, '\\d{1,11}'].join('|')})`;
  return `${units}${digits > 0 ? `${mark}(\\d{${digits}})` : '()'}${CONTINUES}`;
}

/** The two captures of `amountNumber` in hundredths; `below` when its decimals have a thousandth (not kept); else null. */
export const readNumber = (units: string, decimals: string, digits: number): number | 'below' | null =>
  toHundredths(units.replace(/[^\d]/g, ''), decimals, digits);

/**
 * The first amount in a line, a symbol before it or after it: hundredths, written with the currency's `digits` decimals
 * (household/currency.ts), at most any amount's ceiling; `below` when it has a thousandth (not kept, and said so); else
 * null. One pattern, compiled once.
 */
export function amountReader(m: Money, digits: number): (s: string) => number | 'below' | null {
  const n = amountNumber(digits, m);
  // A side without symbols has no branch (an empty alternation would match any number). An amount after which its
  // symbol stands never starts inside a number (after a digit, a separator, or a digit and a space: `12 500`).
  const before = m.before.length ? `${alternation(m.before)}\\s?${n}` : '(?!)()()';
  const after = m.after.length ? `(?<![\\d.,'])(?<!\\d\\s)${n}\\s?${alternation(m.after)}${NOT_WORD_AFTER}` : '(?!)()()';
  const re = new RegExp(`${before}|${after}`, 'iu');
  return (s) => {
    const x = re.exec(s);
    return x ? readNumber(x[1] ?? x[3]!, x[2] ?? x[4]!, digits) : null;
  };
}

/** `amountReader` as a price: an amount with a thousandth is none either. */
export function amountFinder(m: Money, digits: number): (s: string) => number | null {
  const read = amountReader(m, digits);
  return (s) => { const c = read(s); return c === 'below' ? null : c; };
}

/**
 * Whether a line holds an amount at all: a symbol and a digit, or a digit with a symbol after it, however the number is
 * written (`1.250` or `12 500` before the symbol). Loose on purpose, so a line with an amount the reader cannot place is refused,
 * never skipped.
 */
export function amountTest(m: Money): (s: string) => boolean {
  const sides = [...(m.before.length ? [`${alternation(m.before)}\\s?\\d`] : []), ...(m.after.length ? [`\\d\\s?${alternation(m.after)}${NOT_WORD_AFTER}`] : [])];
  const re = new RegExp(sides.length ? sides.join('|') : '(?!)', 'iu');
  return (s) => re.test(s);
}
