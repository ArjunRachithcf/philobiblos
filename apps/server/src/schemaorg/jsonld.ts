// schema.org markup (JSON-LD) in a bookshop's mail or on its search page (philobiblos#27): hostile input, read as data.
// The blocks are found by one linear scan (indexOf, each search starting where the last one ended), bounded in number
// and size; each is parsed as JSON, never run, and its links are never followed. Only nodes under the schema.org
// context count; @graph and top-level lists are opened, within a node count and a depth, and nothing else is
// resolved (no remote context, no @id lookups). Callers keep only the few fields they need, through their own filters.

export const MARKUP_LIMITS = {
  /** Script blocks read from one page or mail. */
  blocks: 8,
  /** Characters of one block. */
  blockBytes: 256 * 1024,
  /** Nodes kept from all blocks together. */
  nodes: 500,
  /** How deep @graph and lists are opened. */
  depth: 4,
} as const;

/** The text of each `<script type="application/ld+json">` block (in any case and quoting), in order, within the limits. */
export function ldBlocks(html: string): string[] {
  // ASCII letters only: a full lowercasing can change the length (U+0130 becomes two code units), and the offsets found
  // here slice the original.
  const lower = html.replace(/[A-Z]+/g, (s) => s.toLowerCase());
  const out: string[] = [];
  let i = 0;
  while (out.length < MARKUP_LIMITS.blocks) {
    const at = lower.indexOf('<script', i);
    if (at < 0) break;
    const gt = lower.indexOf('>', at + 7);
    if (gt < 0) break;
    const close = lower.indexOf('</script', gt + 1);
    if (close < 0) break;
    i = close + 8;
    const attrs = lower.slice(at + 7, gt);
    if (!/(?:^|\s)type\s*=\s*["']?application\/ld\+json(?:["'\s]|$)/.test(attrs.slice(0, 200))) continue;
    if (close - gt - 1 > MARKUP_LIMITS.blockBytes) continue;
    out.push(html.slice(gt + 1, close).trim());
  }
  return out;
}

export type LdNode = Record<string, unknown>;
const SCHEMA = /^https?:\/\/schema\.org\/?$/;
const isSchema = (ctx: unknown): boolean => (typeof ctx === 'string' ? SCHEMA.test(ctx) : Array.isArray(ctx) && ctx.length <= 8 && ctx.some((c) => typeof c === 'string' && SCHEMA.test(c)));
const obj = (v: unknown): v is LdNode => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The schema.org nodes of these blocks: each block's top-level node(s), its @graph opened; a block of another vocabulary is no markup. */
export function schemaNodes(blocks: string[]): LdNode[] {
  const out: LdNode[] = [];
  const add = (v: unknown, inSchema: boolean, depth: number) => {
    if (out.length >= MARKUP_LIMITS.nodes || depth > MARKUP_LIMITS.depth) return;
    if (Array.isArray(v)) { for (const x of v.slice(0, MARKUP_LIMITS.nodes)) add(x, inSchema, depth + 1); return; }
    if (!obj(v)) return;
    const here = '@context' in v ? isSchema(v['@context']) : inSchema;
    if (!here) return;
    if (Array.isArray(v['@graph'])) { add(v['@graph'], true, depth + 1); return; }
    if ('@type' in v) out.push(v);
  };
  for (const b of blocks) {
    let v: unknown;
    try { v = JSON.parse(b); } catch { continue; }
    add(v, false, 0);
  }
  return out;
}

/** Whether a node is of this schema.org type (`Order`, `schema:Order`, `https://schema.org/Order`, or one of a list). */
export function isType(n: unknown, ...types: string[]): n is LdNode {
  if (!obj(n)) return false;
  const ts = Array.isArray(n['@type']) ? n['@type'].slice(0, 8) : [n['@type']];
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
 * An amount as schema.org writes it (a number, or a string of digits with `.` for decimals, no grouping): hundredths, at
 * most 9999.99, or null for anything else (a comma, an exponent, a sign, more than two decimals).
 */
export function hundredths(v: unknown): number | null {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
  const m = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(s);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0')) : null;
}
