// How a connector's words are matched (connectors/<id>/connector.yaml). A connector holds plain words and phrases, never a
// regular expression: what is built here from them is a fixed shape, written in this file, with each word escaped as a
// literal. Every shape is an alternation of literals with at most one bounded or single-character quantifier around it,
// so matching is linear in the text (and the words are few and short: contracts/connector.schema.json). Nothing a
// connector says can add a quantifier, a group or a backreference.

// The syntax characters of a pattern (the only ones the u flag lets be escaped).
const SPECIAL = /[\\^$.*+?()[\]{}|/]/g;
/** A word or phrase as a literal inside a pattern. */
export const literal = (s: string) => s.replace(SPECIAL, '\\$&');

/** Folded for comparing: NFKC, format characters (zero-width spaces, soft hyphens) gone, white space as one space. */
export const fold = (s: string) => s.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();

/**
 * The phrases as one alternation, longest first (so "delivery time" wins over "delivery"). A word ending in `*`
 * (only the summary's and invoice's word lists allow it) stands for any word that begins so: `gesamt*` is Gesamtbetrag.
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

/** Hundredths (up to 9999.99) of the first amount in a line, or null. */
export function amountFinder(m: Money): (s: string) => number | null {
  const re = new RegExp(`${alternation(m.before)}\\s?(\\d{1,4})[.,](\\d{2})(?!\\d)|(?<![\\d.,])(\\d{1,4})[.,](\\d{2})\\s?${alternation(m.after)}${NOT_WORD_AFTER}`, 'iu');
  return (s) => {
    const x = re.exec(s);
    return x ? Number(x[1] ?? x[3]) * 100 + Number(x[2] ?? x[4]) : null;
  };
}

/** Whether a line holds an amount at all (a symbol and a digit, or an amount and a symbol after it). */
export function amountTest(m: Money): (s: string) => boolean {
  const re = new RegExp(`${alternation(m.before)}\\s?\\d|\\d[.,]\\d{2}\\s?${alternation(m.after)}${NOT_WORD_AFTER}`, 'iu');
  return (s) => re.test(s);
}
