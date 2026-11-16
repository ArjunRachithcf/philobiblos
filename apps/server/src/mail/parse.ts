// The bookshop's mails, read into structured fields (ADR 0007, contracts/connectors.md "Kind"). Pure: a verified mail's
// text (or an invoice PDF's rows from the media worker) and its connector's rules in, fields out; nothing here touches
// the database. The layouts are the core's (quote blocks, a line per article, invoice rows); every word in them (the
// subjects, the quote sender, the labels, the currency, the reply markers) is the connector's (`mailRules`), so no shop
// is named here.
//
// Every parser is bounded (lines, line length, books per mail) and linear: lines are split and matched with anchored
// expressions that cannot backtrack, never one pattern over the whole text. Each fails closed: a mail whose kind is
// recognised but whose layout is not (a price Philobiblos cannot place, a book row it cannot read, a stated total that is
// not the sum of the rows) is `unknown_layout`, stamped with the parser's version, and changes nothing. Every string
// field passes `safeField` (read.ts) on its way out. The household's own request, quoted below a reply, is never read:
// lines from the first reply marker on, and any line starting with `>`, are left out.
import type { Connector } from '@philobiblos/contracts/connector';
import { alternation, amountFinder, amountTest, contains, literal, startsWith, subjectMatcher } from '../connectors/text';
import { safeField } from './read';

/** One version per parser: a row records the one that read it (and an unknown layout is read again under a new one). */
export const PARSERS = { quote: 'quote-1', confirm: 'confirm-1', online: 'online-1', collect: 'collect-1', invoice: 'invoice-1', classify: 'classify-1' } as const;
export const LIMITS = { lines: 5000, lineChars: 1000, books: 100 } as const;

/**
 * `notBook`: the line carries a 13-digit EAN that is not an ISBN (978/979): a toy, a game, a Tonie. It never matches a
 * book, not even by its title, and goes to the Inbox. Decided from the raw digits, before safeField (which drops such
 * a run, so the kept `ean` would be null and could not tell).
 */
interface NotBook { notBook?: true }
export interface QuoteLine extends NotBook { title: string | null; author: string | null; ean: string | null; priceC: number | null; delivery: string | null; available: boolean }
export interface ShopLine extends NotBook { title: string | null; author: string | null; ean: string | null; qty: number; priceC: number }
/** `eanUnreadable`: an invoice row read whole but for its EAN (spaced, cut, not 13 digits): never matched, to the Inbox. */
export interface InvoiceLine extends NotBook { title: string | null; ean: string | null; qty: number; priceC: number; discountPct: number | null; totalC: number; vatPct: number; eanUnreadable?: true }
const ISBN = /^97[89]\d{10}$/;
const notBook = (ean: string | null | undefined): NotBook => (ean && !ISBN.test(ean) ? { notBook: true } : {});

export type Parsed =
  | { kind: 'bookshop_quote'; parser: string; lines: QuoteLine[] }
  | { kind: 'bookshop_confirm'; parser: string; orderNumber: string | null }
  | { kind: 'online_order' | 'click_collect'; parser: string; orderNumber: string | null; lines: ShopLine[] }
  | { kind: 'invoice'; parser: string; invoiceNumber: string | null; lines: InvoiceLine[]; totalC: number | null }
  | { kind: 'unknown_layout'; parser: string; expected: string; reason: string }
  | { kind: 'other'; parser: string };

/**
 * What the mail is, from its signed sender and subject; an invoice waits for its PDF rows (`parseInvoice`). A shop
 * subject whose number is not 4 to 11 digits in one run (longer, or spaced: safeField drops a run of 12 digits) is
 * `number_unreadable`, so the mail fails closed as an unknown layout instead of passing as `other`.
 */
export type Kind = { kind: 'quote_or_confirm' } | { kind: 'online_order' | 'click_collect'; number: string } | { kind: 'invoice'; number: string }
  | { kind: 'number_unreadable'; expected: 'online_order' | 'click_collect' | 'invoice' } | { kind: 'other' };

/** A connector's words as the parsers use them, compiled once (connectors/text.ts: literals in fixed, linear shapes). */
export interface MailRules {
  quoteSenders: string[];
  subjects: ['online_order' | 'click_collect' | 'invoice', (subject: string) => string | null][];
  amount: (s: string) => number | null;
  hasAmount: (s: string) => boolean;
  /** A part that is an amount with its symbol first (`CHF 18.90`). */
  startsWithAmount: RegExp;
  summary: (l: string) => boolean;
  unavailable: (l: string) => boolean;
  reply: ((l: string) => boolean)[];
  quote: { field: RegExp; labels: Map<string, QuoteField>; split: RegExp; confirm: (l: string) => boolean; orderNumber: RegExp; deliveryLabel: RegExp } | null;
  shop: { books: Set<string>; skip: Set<string>; right: RegExp; ean: RegExp; by: string } | null;
  invoice: { total: (l: string) => boolean; postage: (l: string) => boolean; unit: string; currency: string } | null;
}
type QuoteField = 'author' | 'title' | 'isbn' | 'price' | 'delivery';

const tester = (re: RegExp) => (l: string) => re.test(l);
const compiled = new WeakMap<Connector, MailRules>();
/** The parsers' rules of a connector with mail (connectors/<id>/connector.yaml `mail` and `money`). */
export function mailRules(c: Connector): MailRules {
  const hit = compiled.get(c);
  if (hit) return hit;
  const m = c.mail;
  if (!m) throw new Error(`the connector ${c.id} reads no mail`);
  const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
  const q = m.quote;
  const labels = new Map<string, QuoteField>();
  if (q) for (const f of ['author', 'title', 'isbn', 'price', 'delivery'] as const) for (const l of q.labels[f]) labels.set(l.toLowerCase(), f);
  const attributionStart = new RegExp(`^${alternation(m.reply.attribution_starts)} `, 'iu');
  const attributionVerb = contains(m.reply.attribution_verbs);
  const r: MailRules = {
    quoteSenders: q?.senders ?? [],
    subjects: [
      ...(m.shop?.online_order_subjects ?? []).map((t) => ['online_order', subjectMatcher(t)] as const),
      ...(m.shop?.click_collect_subjects ?? []).map((t) => ['click_collect', subjectMatcher(t)] as const),
      ...(m.invoice?.subjects ?? []).map((t) => ['invoice', subjectMatcher(t)] as const),
    ] as MailRules['subjects'],
    amount: amountFinder(c.money),
    hasAmount: amountTest(c.money),
    startsWithAmount: new RegExp(`^${alternation(c.money.before)}\\s?\\d`, 'iu'),
    summary: startsWith(m.summary),
    unavailable: contains(m.unavailable),
    reply: [
      tester(new RegExp(`^-{2,} ?${alternation(m.reply.separators)}`, 'iu')),
      (l) => /^_{8,}$/.test(l),
      tester(new RegExp(`^${alternation(m.reply.header_labels)} ?: `, 'iu')),
      (l) => attributionStart.test(l) && l.endsWith(':') && attributionVerb(l),
    ],
    quote: q ? {
      field: new RegExp(`^(${alternation([...labels.keys()])})\\s?[:.]\\s?(.*)$`, 'iu'),
      labels,
      split: new RegExp(` / (?=${alternation([...labels.keys()])}(?![\\p{L}\\p{N}]))`, 'iu'),
      confirm: contains(q.confirm_phrases),
      orderNumber: new RegExp(`(?<![\\p{L}\\p{N}])${alternation(q.order_number_labels)}\\s?[:#]?\\s?(\\d{4,12})(?![\\p{L}\\p{N}_])`, 'iu'),
      deliveryLabel: new RegExp(`^${alternation(q.labels.delivery)}\\s?:?\\s?`, 'iu'),
    } : null,
    shop: m.shop ? {
      books: new Set(lower(m.shop.book_kinds)), skip: new Set(lower(m.shop.skip_kinds)), by: ` ${m.shop.by} `,
      right: new RegExp(`^(?:(\\d{1,2}) ?[x×] ?)?${alternation(c.money.before)} ?(\\d{1,4})[.,](\\d{2})$`, 'iu'),
      ean: new RegExp(` ${literal(m.shop.ean_label)}: ?(\\d{13})$`, 'iu'),
    } : null,
    invoice: m.invoice ? { total: startsWith(m.invoice.total_words), postage: startsWith(m.invoice.postage_words), unit: m.invoice.unit.toUpperCase(), currency: c.locale.currency } : null,
  };
  compiled.set(c, r);
  return r;
}

export function classify(r: MailRules, from: string, subject: string | null): Kind {
  for (const [kind, match] of r.subjects) {
    const n = match(subject ?? '');
    if (n != null) return /^\d{4,11}$/.test(n) ? { kind, number: n } : { kind: 'number_unreadable', expected: kind };
  }
  if (r.quoteSenders.includes(from)) return { kind: 'quote_or_confirm' };
  return { kind: 'other' };
}

const refuse = (expected: string, parser: string, reason: string): Parsed => ({ kind: 'unknown_layout', parser, expected, reason });

/**
 * The text's own lines: NFKC, format characters gone, trimmed; the quoted request (from the first reply marker on,
 * and `>` lines) left out. Null when there are too many lines or one too long holds an amount.
 */
export function ownLines(text: string, r: Pick<MailRules, 'hasAmount' | 'reply'>): string[] | null {
  const all = text.split(/\r?\n/);
  if (all.length > LIMITS.lines) return null;
  const out: string[] = [];
  for (const raw of all) {
    const l = raw.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
    if (l.length > LIMITS.lineChars) { if (r.hasAmount(l)) return null; continue; }
    if (r.reply.some((isMarker) => isMarker(l))) break;
    if (l.startsWith('>')) continue;
    out.push(l);
  }
  return out;
}

const digits = (s: string) => s.replace(/[\s-]/g, '');
const EAN = /^(?:97[89]\d{10}|\d{13})$/;
const field = (v: string | null | undefined, address: string[], max = 200) => (v ? safeField(v.slice(0, max), address) : null);

/** Quote replies, the three layouts of contracts/connectors.md (and a block written on one line with ` / `). */
export function parseQuote(text: string, address: string[], r: MailRules): Parsed {
  const P = PARSERS.quote;
  const q = r.quote;
  if (!q) return refuse('bookshop_quote', P, 'its connector reads no quotes');
  const lines = ownLines(text, r);
  if (!lines) return refuse('bookshop_quote', P, 'too long');
  // "Author: X / Title: Y / ISBN: n": a block on one line is the same block.
  const ls = lines.flatMap((l) => l.split(q.split));
  if (ls.some(q.confirm)) {
    const m = ls.map((l) => q.orderNumber.exec(l)).find(Boolean);
    return { kind: 'bookshop_confirm', parser: PARSERS.confirm, orderNumber: field(m?.[1], address) };
  }
  type Block = { author?: string; title?: string; isbn?: string; price?: string; delivery?: string; unavailable?: boolean };
  const out: QuoteLine[] = [];
  let cur: Block | null = null;
  let problem: string | null = null;
  const flush = () => {
    if (!cur) return;
    const b = cur; cur = null;
    if (!b.title) { problem = 'a book without a title'; return; }
    const p = b.price ? r.amount(b.price) : null;
    const unavailable = Boolean(b.unavailable) || r.unavailable(`${b.price ?? ''} ${b.delivery ?? ''}`);
    if (p == null && !unavailable) { problem = 'a book with neither a price nor a status'; return; }
    const ean = b.isbn ? digits(b.isbn) : null;
    if (ean != null && !EAN.test(ean)) { problem = 'an ISBN Philobiblos cannot read'; return; }
    out.push({ title: field(b.title, address), author: field(b.author, address, 120), ean: field(ean, address), priceC: unavailable ? null : p, delivery: field(b.delivery, address, 80), available: !unavailable, ...notBook(ean) });
  };
  const isbnLine = (l: string) => { const x = q.field.exec(l); return Boolean(x && q.labels.get(x[1]!.toLowerCase()) === 'isbn'); };
  // The next non-empty line after each, found in one backward pass (not a search per line: linear).
  const next: (string | undefined)[] = new Array(ls.length);
  for (let i = ls.length - 1, n: string | undefined; i >= 0; i--) { next[i] = n; if (ls[i]) n = ls[i]; }
  for (let i = 0; i < ls.length && !problem; i++) {
    const l = ls[i]!;
    if (!l) continue;
    const f = q.field.exec(l);
    if (f) {
      const label = q.labels.get(f[1]!.toLowerCase())!;
      const v = f[2]!.trim();
      // A second author, title or ISBN starts the next book; a second price or delivery in one book is a layout Philobiblos does not know.
      if (cur && (cur as Block)[label] !== undefined) {
        if (label === 'price' || label === 'delivery') { problem = `two ${label} lines for one book`; continue; }
        flush();
      }
      const b: Block = cur ?? {};
      b[label] = v;
      cur = b;
      continue;
    }
    // "- Okafor, Value Beyond Price, CHF 18.90, delivery time 1-3 days"
    const bullet = /^[-–•*]\s(.+)$/.exec(l);
    if (bullet) {
      flush();
      const parts = bullet[1]!.split(/,\s?/);
      const at = parts.findIndex((p) => r.startsWithAmount.test(p));
      const end = at >= 0 ? at : parts.length - 1;
      if (parts.length < 3 || end < 2 || (at < 0 && !r.unavailable(parts[end]!))) {
        if (r.hasAmount(l)) problem = 'a price Philobiblos cannot place';
        continue;
      }
      cur = { author: parts[0], title: parts.slice(1, end).join(', '), price: at >= 0 ? parts[at] : undefined, delivery: parts.slice(end + (at >= 0 ? 1 : 0)).join(', ').replace(q.deliveryLabel, '') || undefined };
      flush();
      continue;
    }
    // "Paulsen, The Quiet Hedgehog" above an ISBN line
    const head = /^([^,:]{1,80}),\s?([^:]{1,200})$/.exec(l);
    if (head && next[i] && isbnLine(next[i]!)) {
      flush();
      cur = { author: head[1], title: head[2] };
      continue;
    }
    if (cur && r.unavailable(l) && !r.hasAmount(l)) { cur.unavailable = true; continue; }
    if (r.hasAmount(l) && !r.summary(l)) problem = 'a price Philobiblos cannot place';
  }
  if (!problem) flush();
  if (problem) return refuse('bookshop_quote', P, problem);
  if (!out.length) return refuse('bookshop_quote', P, 'no books');
  if (out.length > LIMITS.books) return refuse('bookshop_quote', P, 'too many books');
  return { kind: 'bookshop_quote', parser: P, lines: out };
}

/**
 * Online orders and click & collect: one line per article, `<kind> <title> <by> <author> [<ean label>: <ean>] | [<n> x ]<symbol> <price>`,
 * where the kind is one of the connector's book kinds or one it skips (contracts/connectors.md).
 */
export function parseShop(kind: 'online_order' | 'click_collect', number: string, text: string, address: string[], r: MailRules): Parsed {
  const P = kind === 'online_order' ? PARSERS.online : PARSERS.collect;
  const shop = r.shop;
  if (!shop) return refuse(kind, P, 'its connector reads no web orders');
  const lines = ownLines(text, r);
  if (!lines) return refuse(kind, P, 'too long');
  const out: ShopLine[] = [];
  for (const l of lines) {
    if (!r.hasAmount(l)) continue;
    if (r.summary(l)) continue;
    const bar = l.lastIndexOf(' | ');
    const right = bar >= 0 ? shop.right.exec(l.slice(bar + 3)) : null;
    const sp = l.indexOf(' ');
    const what = sp > 0 ? l.slice(0, sp).toLowerCase() : '';
    if (!right || sp > bar || (!shop.books.has(what) && !shop.skip.has(what))) return refuse(kind, P, 'a price Philobiblos cannot place');
    if (shop.skip.has(what)) continue;
    let left = l.slice(sp + 1, bar);
    const ean = shop.ean.exec(left);
    if (ean) left = left.slice(0, ean.index);
    const by = left.indexOf(shop.by);
    out.push({
      title: field(by >= 0 ? left.slice(0, by) : left, address), author: by >= 0 ? field(left.slice(by + shop.by.length), address, 120) : null,
      ean: field(ean?.[1], address), qty: Number(right[1] ?? 1), priceC: Number(right[2]) * 100 + Number(right[3]), ...notBook(ean?.[1]),
    });
    if (out.length > LIMITS.books) return refuse(kind, P, 'too many books');
  }
  if (!out.length) return refuse(kind, P, 'no articles');
  return { kind, parser: P, orderNumber: field(number, address), lines: out };
}

const money = (s: string) => { const m = /^(\d{1,6})[.,](\d{2})$/.exec(s); return m ? Number(m[1]) * 100 + Number(m[2]) : null; };
const pct = (s: string) => { const m = /^(\d{1,2}(?:[.,]\d{1,2})?)%$/.exec(s); return m ? Number(m[1]!.replace(',', '.')) : null; };

/**
 * An invoice PDF's rows (cells as the worker split them): `EAN  Title  qty <unit>  price  [discount %]  total <currency>  VAT %`.
 * A row that begins with an EAN must read whole, and a stated total must be the rows' sum (with postage), or the
 * invoice is refused.
 */
export function parseInvoice(number: string, rows: string[][], truncated: boolean, address: string[], r: MailRules): Parsed {
  const P = PARSERS.invoice;
  const inv = r.invoice;
  if (!inv) return refuse('invoice', P, 'its connector reads no invoices');
  if (truncated) return refuse('invoice', P, 'the PDF was cut short');
  const out: InvoiceLine[] = [];
  let stated: number | null = null, postage = 0;
  for (const row of rows) {
    const s = row.join(' ').normalize('NFKC').replace(/\s+/g, ' ').trim().replace(/(\d) %/g, '$1%');
    if (s.length > LIMITS.lineChars) return refuse('invoice', P, 'a row too long');
    const tok = s.split(' ');
    const lastAmount = () => { for (let i = tok.length - 1; i >= 0; i--) { const m = money(tok[i]!); if (m != null) return m; } return null; };
    if (inv.total(s)) { stated = lastAmount(); continue; }
    if (inv.postage(s)) { postage += lastAmount() ?? 0; continue; }
    // From the end: VAT %, the currency, total, [discount %], price, the unit, qty; the title is what is left.
    let i = tok.length - 1;
    const vat = pct(tok[i--] ?? '');
    const chf = tok[i--]?.toUpperCase() === inv.currency;
    const total = money(tok[i--] ?? '');
    const discount = pct(tok[i] ?? '');
    if (discount != null) i--;
    const price = money(tok[i--] ?? '');
    const st = tok[i--]?.toUpperCase() === inv.unit;
    const qty = /^\d{1,2}$/.test(tok[i] ?? '') ? Number(tok[i--]) : null;
    const whole = vat != null && chf && total != null && price != null && st && qty;
    if (!/^\d{13}$/.test(tok[0]!)) {
      // A book row but for its EAN (spaced, cut short): read, counted in the total, and sent to the Inbox, never matched.
      if (!whole) continue;
      let from = 0;
      while (from <= i && /^[\d-]+$/.test(tok[from]!)) from++;
      if (from === 0 || from > i) continue;
      out.push({ ean: null, title: field(tok.slice(from, i + 1).join(' '), address), qty, priceC: price, discountPct: discount, totalC: total, vatPct: vat, eanUnreadable: true });
    } else {
      if (!whole || i < 1) return refuse('invoice', P, 'a book row Philobiblos cannot read');
      // A row whose EAN is no ISBN is read whole (it counts in the total) but is not a book (notBook).
      out.push({ ean: field(tok[0], address), title: field(tok.slice(1, i + 1).join(' '), address), qty, priceC: price, discountPct: discount, totalC: total, vatPct: vat, ...notBook(tok[0]) });
    }
    if (out.length > LIMITS.books) return refuse('invoice', P, 'too many books');
  }
  if (!out.length) return refuse('invoice', P, 'no book rows');
  const sum = out.reduce((n, l) => n + l.totalC, 0) + postage;
  if (stated != null && stated !== sum) return refuse('invoice', P, 'the stated total is not the sum of the rows');
  return { kind: 'invoice', parser: P, invoiceNumber: field(number, address), lines: out, totalC: stated ?? sum };
}
