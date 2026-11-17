// The Backlog's GitHub-style query language (contracts/backlog-query.md).
// Pure: no I/O. Shared by the server (filtering) and the web app (the filter bar).

export const IS_VALUES = ['open', 'closed', 'adult', 'kids', 'fiction'] as const;
export const MOVE_VALUES = ['deepen', 'connect', 'broaden', 'counterpoint', 'wildcard', 'intro', 'fiction'] as const;
export const LAYER_VALUES = ['intro', 'core', 'deep', 'counterpoint'] as const;
export const SOURCE_VALUES = ['instagram', 'wishlist', 'to-buy', 'ai', 'manual'] as const;
export const REASON_VALUES = ['not-for-me', 'snoozed', 'owned', 'repeats', 'picked'] as const;
export const SORT_FIELDS = ['score', 'links', 'price', 'added', 'title'] as const;

export type IsValue = (typeof IS_VALUES)[number];
export type MoveValue = (typeof MOVE_VALUES)[number];
export type LayerValue = (typeof LAYER_VALUES)[number];
export type SourceValue = (typeof SOURCE_VALUES)[number];
export type ReasonValue = (typeof REASON_VALUES)[number];
export type SortField = (typeof SORT_FIELDS)[number];
export type SortDir = 'asc' | 'desc';
export type Comparator = '<' | '<=' | '>' | '>=' | '=';

/** Qualifier keys the grammar knows (the table in contracts/backlog-query.md). */
export const QUALIFIERS = [
  'is', 'for', 'move', 'idea', 'layer', 'theme', 'source', 'by', 'author',
  'score', 'price', 'links', 'added', 'reason', 'sort',
] as const;
export type QualifierKey = (typeof QUALIFIERS)[number];

interface Base { negated: boolean }
export type Term =
  | (Base & { key: 'is'; value: IsValue })
  | (Base & { key: 'for' | 'by'; value: string })
  | (Base & { key: 'move'; value: MoveValue })
  | (Base & { key: 'layer'; value: LayerValue })
  | (Base & { key: 'source'; value: SourceValue })
  | (Base & { key: 'reason'; value: ReasonValue })
  | (Base & { key: 'idea' | 'theme' | 'author'; value: string })
  /** score and links: plain numbers; price: whole units of the household's currency (the API's money is in hundredths, compare against price / 100). */
  | (Base & { key: 'score' | 'price' | 'links'; cmp: Comparator; value: number })
  /** added: age in days, `added:<30d` = added less than 30 days ago. */
  | (Base & { key: 'added'; cmp: Comparator; days: number })
  /** A free word or "quoted phrase": matches title and author. */
  | (Base & { key: 'text'; value: string });

export interface Sort { field: SortField; dir: SortDir }

export interface ParsedQuery {
  /** Every accepted term in query order, except `sort:` (see `sort`). */
  terms: Term[];
  /** Open or closed tab: `is:open` is the default; the last `is:open`/`is:closed` wins; negation flips it. */
  state: 'open' | 'closed';
  sort: Sort;
  /** Unknown qualifiers and bad values; those terms are ignored (never an error response). */
  errors: string[];
}

/** Direction used when `sort:<field>` has no `-asc`/`-desc` suffix. */
export const DEFAULT_SORT_DIR: Record<SortField, SortDir> = {
  score: 'desc', links: 'desc', price: 'asc', added: 'desc', title: 'asc',
};
export const DEFAULT_SORT: Sort = { field: 'score', dir: 'desc' };

/** A raw term of the query string, with its position, for parsing and for editing the bar's text. */
export interface Token {
  raw: string;
  negated: boolean;
  /** Lower-case key when the token is `key:value`, else null (free text). */
  key: string | null;
  /** The value with quotes removed. */
  value: string;
  /** Set when a quote was opened and never closed (the token then runs to the end of the query). */
  unterminated: boolean;
}

const KEY_RE = /^([A-Za-z][A-Za-z-]*):/;

/** Split on whitespace; a double-quoted part may contain spaces (`idea:"markets and value"`, `"whole phrase"`). */
export function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = query.length;
  while (i < n) {
    while (i < n && /\s/.test(query[i]!)) i++;
    if (i >= n) break;
    const start = i;
    let value = '';
    let inQuote = false;
    let unterminated = false;
    while (i < n && (inQuote || !/\s/.test(query[i]!))) {
      const ch = query[i]!;
      if (ch === '"') inQuote = !inQuote;
      else value += ch;
      i++;
    }
    if (inQuote) unterminated = true;
    const raw = query.slice(start, i);
    let negated = false;
    let body = value;
    if (raw.startsWith('-') && raw.length > 1) {
      negated = true;
      body = value.slice(1);
    }
    const bodyRaw = negated ? raw.slice(1) : raw;
    const m = KEY_RE.exec(bodyRaw);
    let key: string | null = null;
    if (m) {
      key = m[1]!.toLowerCase();
      body = body.slice(m[1]!.length + 1);
    }
    tokens.push({ raw, negated, key, value: body, unterminated });
  }
  return tokens;
}

const NUM_RE = /^(<=|>=|<|>|=)?(\d+(?:\.\d+)?)$/;
const AGE_RE = /^(<=|>=|<|>|=)?(\d+)d$/i;

function oneOf<T extends string>(values: readonly T[], v: string): T | undefined {
  return (values as readonly string[]).includes(v) ? (v as T) : undefined;
}

export function parseQuery(query: string): ParsedQuery {
  const terms: Term[] = [];
  const errors: string[] = [];
  let state: 'open' | 'closed' = 'open';
  let sort: Sort = DEFAULT_SORT;

  for (const t of tokenize(query)) {
    if (t.unterminated) errors.push(`missing closing quote in ${t.raw}`);
    if (t.raw === '-') continue;
    const negated = t.negated;

    if (t.key === null) {
      const value = t.value.trim().toLowerCase();
      if (value) terms.push({ key: 'text', value, negated });
      continue;
    }
    const key = oneOf(QUALIFIERS, t.key);
    if (!key) {
      errors.push(`unknown qualifier "${t.key}:"`);
      continue;
    }
    const raw = t.value.trim();
    const v = raw.toLowerCase();
    if (!v) {
      errors.push(`missing value for "${key}:"`);
      continue;
    }
    const bad = (expected: string) => errors.push(`invalid value "${raw}" for "${key}:" (expected ${expected})`);

    switch (key) {
      case 'is': {
        const value = oneOf(IS_VALUES, v);
        if (!value) { bad(IS_VALUES.join(', ')); break; }
        terms.push({ key, value, negated });
        if (value === 'open' || value === 'closed') {
          const closed = value === 'closed';
          state = closed !== negated ? 'closed' : 'open';
        }
        break;
      }
      case 'move': {
        const value = oneOf(MOVE_VALUES, v);
        if (!value) { bad(MOVE_VALUES.join(', ')); break; }
        terms.push({ key, value, negated });
        break;
      }
      case 'layer': {
        const value = oneOf(LAYER_VALUES, v);
        if (!value) { bad(LAYER_VALUES.join(', ')); break; }
        terms.push({ key, value, negated });
        break;
      }
      case 'source': {
        const value = oneOf(SOURCE_VALUES, v);
        if (!value) { bad(SOURCE_VALUES.join(', ')); break; }
        terms.push({ key, value, negated });
        break;
      }
      case 'reason': {
        const value = oneOf(REASON_VALUES, v);
        if (!value) { bad(REASON_VALUES.join(', ')); break; }
        terms.push({ key, value, negated });
        break;
      }
      case 'for':
      case 'by':
        terms.push({ key, value: v, negated });
        break;
      case 'idea':
      case 'theme':
      case 'author':
        terms.push({ key, value: v, negated });
        break;
      case 'score':
      case 'price':
      case 'links': {
        const m = NUM_RE.exec(v);
        if (!m) { bad('a number with <, <=, >, >= or none'); break; }
        terms.push({ key, cmp: (m[1] as Comparator | undefined) ?? '=', value: Number(m[2]), negated });
        break;
      }
      case 'added': {
        const m = AGE_RE.exec(v);
        if (!m) { bad('an age in days such as <30d or >90d'); break; }
        terms.push({ key, cmp: (m[1] as Comparator | undefined) ?? '=', days: Number(m[2]), negated });
        break;
      }
      case 'sort': {
        if (negated) { errors.push(`"sort:" cannot be negated`); break; }
        const m = /^([a-z]+)(?:-(asc|desc))?$/.exec(v);
        const field = m ? oneOf(SORT_FIELDS, m[1]!) : undefined;
        if (!m || !field) { bad(`${SORT_FIELDS.join(', ')} with an optional -asc or -desc`); break; }
        sort = { field, dir: (m[2] as SortDir | undefined) ?? DEFAULT_SORT_DIR[field] };
        break;
      }
    }
  }
  return { terms, state, sort, errors };
}

/** Group of an `is:` value: a label click replaces only the value of the same group. */
function isGroup(value: string): string {
  if (value === 'open' || value === 'closed') return 'state';
  if (value === 'adult' || value === 'kids') return 'audience';
  return value;
}

function quote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * What a click on a label does: append `key:value`, removing an existing term of the same key
 * (for `is:`, of the same group: open/closed, adult/kids, fiction). Other terms keep their text.
 */
export function withQualifier(query: string, key: QualifierKey, value: string, negated = false): string {
  const kept = tokenize(query).filter((t) => {
    if (t.key !== key) return true;
    if (key === 'is') return isGroup(t.value.toLowerCase()) !== isGroup(value.toLowerCase());
    return false;
  });
  const term = `${negated ? '-' : ''}${key}:${quote(value)}`;
  return [...kept.map((t) => t.raw), term].join(' ');
}
