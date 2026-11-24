// schema.org markup (JSON-LD) in a bookshop's mail or on its search page (philobiblos#27): hostile input, read as data.
// The blocks are found by one linear scan (indexOf, each search starting where the last one ended; HTML comments
// skipped in the same scan), bounded in number and size; each is parsed as JSON, never run, and its links are never
// followed. Only nodes under the schema.org context count; @graph and top-level lists are opened, within a node count
// and a depth, and nothing else is resolved (no remote context, no @id lookups). A limit is never a cut: markup beyond
// any of them (a block too many or too big, an unclosed one, more nodes than are kept, a block that is not JSON) is
// reported as `overflow`, and callers read none of it rather than a part. Callers keep only the few fields they need,
// through their own filters.
import { toHundredths } from '@philobiblos/contracts/money';
import { currencyDigits } from '../household/currency';

export const MARKUP_LIMITS = {
  /** Script blocks read from one page or mail. */
  blocks: 8,
  /** Characters (UTF-16 code units) of one block. */
  blockChars: 256 * 1024,
  /** Nodes kept from all blocks together. */
  nodes: 500,
  /** How deep @graph and lists are opened. */
  depth: 4,
} as const;

/** A page's or a mail's markup blocks, and whether there was more than the limits read (then none of it counts). */
export interface Markup { blocks: string[]; overflow: boolean }

const LD_TYPE = /(?:^|\s)type\s*=\s*["']?application\/ld\+json(?:["'\s]|$)/;

/**
 * The text of each `<script type="application/ld+json">` block (in any case and quoting), in order: only a real
 * `<script` tag (followed by a space, `/` or `>`, never `<scriptx`), never one inside an HTML comment. `cut`: the HTML was
 * cut before its end, so there may have been more (an overflow too).
 */
export function ldBlocks(html: string, cut = false): Markup {
  // ASCII letters only: a full lowercasing can change the length (U+0130 becomes two code units), and the offsets found
  // here slice the original.
  const lower = html.replace(/[A-Z]+/g, (s) => s.toLowerCase());
  const blocks: string[] = [];
  let overflow = cut;
  // The next `<script` and the next `<!--` at or after i, each searched again only once i has passed it: linear.
  let script = -2, comment = -2;
  let i = 0;
  for (;;) {
    if (script !== -1 && script < i) script = lower.indexOf('<script', i);
    if (comment !== -1 && comment < i) comment = lower.indexOf('<!--', i);
    if (script < 0) break;
    if (comment >= 0 && comment < script) {
      const end = lower.indexOf('-->', comment + 4);
      if (end < 0) break; // the rest is a comment
      i = end + 3;
      continue;
    }
    const at = script;
    if (!/[\s/>]/.test(lower.charAt(at + 7))) { i = at + 7; continue; }
    const gt = lower.indexOf('>', at + 7);
    if (gt < 0) { overflow = true; break; }
    const ld = LD_TYPE.test(lower.slice(at + 7, Math.min(gt, at + 207)));
    const close = lower.indexOf('</script', gt + 1);
    if (close < 0) { overflow ||= ld; break; }
    i = close + 8;
    if (!ld) continue;
    if (blocks.length >= MARKUP_LIMITS.blocks || close - gt - 1 > MARKUP_LIMITS.blockChars) { overflow = true; break; }
    blocks.push(html.slice(gt + 1, close).trim());
  }
  return { blocks, overflow };
}

export type LdNode = Record<string, unknown>;
const SCHEMA = /^https?:\/\/schema\.org\/?$/;
const isSchema = (ctx: unknown): boolean => (typeof ctx === 'string' ? SCHEMA.test(ctx) : Array.isArray(ctx) && ctx.length <= 8 && ctx.some((c) => typeof c === 'string' && SCHEMA.test(c)));
/** How many types of one node's @type list are read (schemaNodes refuses a longer one). */
const TYPES = 8;
const obj = (v: unknown): v is LdNode => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The schema.org nodes of these blocks: each block's top-level node(s), its @graph opened; a block of another vocabulary
 * is no markup. More than is read (the blocks' own overflow, more nodes than kept, lists deeper than opened, a @type
 * list longer than read, a block that is not JSON) is an overflow: the caller reads none of it.
 */
export function schemaNodes(m: Markup): { nodes: LdNode[]; overflow: boolean } {
  const out: LdNode[] = [];
  let overflow = m.overflow;
  const add = (v: unknown, inSchema: boolean, depth: number) => {
    if (overflow) return;
    if (depth > MARKUP_LIMITS.depth) { overflow = true; return; }
    if (Array.isArray(v)) { for (const x of v) add(x, inSchema, depth + 1); return; }
    if (!obj(v)) return;
    const here = '@context' in v ? isSchema(v['@context']) : inSchema;
    if (!here) return;
    if (Array.isArray(v['@graph'])) { add(v['@graph'], true, depth + 1); return; }
    if (!('@type' in v)) return;
    if (out.length >= MARKUP_LIMITS.nodes || (Array.isArray(v['@type']) && v['@type'].length > TYPES)) { overflow = true; return; }
    out.push(v);
  };
  for (const b of m.blocks) {
    if (overflow) break;
    let v: unknown;
    try { v = JSON.parse(b); } catch { overflow = true; break; }
    add(v, false, 0);
  }
  return { nodes: out, overflow };
}

/** Whether a node is of this schema.org type (`Order`, `schema:Order`, `https://schema.org/Order`, or one of a list). */
export function isType(n: unknown, ...types: string[]): n is LdNode {
  if (!obj(n)) return false;
  const ts = Array.isArray(n['@type']) ? n['@type'].slice(0, TYPES) : [n['@type']];
  return ts.some((t) => typeof t === 'string' && types.includes(t.replace(/^(?:schema:|https?:\/\/schema\.org\/)/, '')));
}

/** A property as a list of at most `max` values (one value, a list, or none). */
export const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : v === undefined || v === null ? [] : [v]);
/** A property as a node, or null (the first, if it is a list). */
export const node = (v: unknown): LdNode | null => { const x = Array.isArray(v) ? v[0] : v; return obj(x) ? x : null; };
/** A property as text: a string, a number, or a node's `name` (a Person, an Organization); else null. */
export function text(v: unknown): string | null {
  const x = Array.isArray(v) ? v[0] : v;
  if (typeof x === 'string') return x;
  if (typeof x === 'number' && Number.isFinite(x)) return String(x);
  if (obj(x) && typeof x.name === 'string') return x.name;
  return null;
}

/**
 * An amount in `currency` as schema.org writes it (a number, or a string of digits with `.` for decimals, no grouping):
 * hundredths, at most any amount's ceiling, or null for anything else (a comma, an exponent, a sign, more decimals than
 * the currency has (two in one without them), a fraction of a unit in a currency without one (`1500.00` reads, `1500.50`
 * does not), or a thousandth in one with three (`1.250` reads, `1.255` does not: hundredths are kept)).
 */
export function hundredths(v: unknown, currency: string): number | null {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
  const digits = currencyDigits(currency);
  const m = /^(\d{1,11})(?:\.(\d{1,4}))?$/.exec(s);
  const c = m && (m[2] ?? '').length <= Math.max(2, digits) ? toHundredths(m[1]!, m[2] ?? '', digits) : null;
  return c === 'below' ? null : c;
}
