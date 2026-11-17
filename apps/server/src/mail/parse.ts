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
import { hundredths, isType, list, node, schemaNodes, text, type LdNode, type Markup } from '../schemaorg/jsonld';

/** One version per parser: a row records the one that read it (and an unknown layout is read again under a new one). */
export const PARSERS = { quote: 'quote-1', confirm: 'confirm-1', online: 'online-1', collect: 'collect-1', invoice: 'invoice-1', classify: 'classify-1', markupOrder: 'markup-order-1', markupInvoice: 'markup-invoice-1' } as const;
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
export interface InvoiceLine extends NotBook { title: string | null; author?: string | null; ean: string | null; qty: number; priceC: number; discountPct: number | null; totalC: number; vatPct: number | null; eanUnreadable?: true }
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
  /** A part that is an amount with its symbol first (`<symbol> 18.90`). */
  startsWithAmount: RegExp;
  summary: (l: string) => boolean;
  unavailable: (l: string) => boolean;
  reply: ((l: string) => boolean)[];
  quote: { field: RegExp; labels: Map<string, QuoteField>; split: RegExp; confirm: (l: string) => boolean; orderNumber: RegExp; deliveryLabel: RegExp } | null;
  shop: { books: Set<string>; skip: Set<string>; right: RegExp; ean: RegExp; by: string } | null;
  invoice: { total: (l: string) => boolean; postage: (l: string) => boolean; unit: string; currency: string } | null;
  /** schema.org Order and Invoice markup counts (`mail.markup`), its amounts in this currency only. */
  markup: { currency: string } | null;
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
  // A connector read through its markup alone has no words for these: nothing then matches them.
  const never = () => false;
  const reply = m.reply;
  const attributionStart = reply ? new RegExp(`^${alternation(reply.attribution_starts)} `, 'iu') : null;
  const attributionVerb = reply ? contains(reply.attribution_verbs) : never;
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
    summary: m.summary ? startsWith(m.summary) : never,
    unavailable: m.unavailable ? contains(m.unavailable) : never,
    reply: [
      ...(reply ? [tester(new RegExp(`^-{2,} ?${alternation(reply.separators)}`, 'iu'))] : []),
      (l) => /^_{8,}$/.test(l),
      ...(reply ? [tester(new RegExp(`^${alternation(reply.header_labels)} ?: `, 'iu'))] : []),
      (l) => Boolean(attributionStart?.test(l)) && l.endsWith(':') && attributionVerb(l),
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
    markup: m.markup ? { currency: c.locale.currency } : null,
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
 * A schema.org OrderStatus as its name: a string or a `{"@id": …}` reference, `schema:` or the schema.org URL (http or
 * https) stripped; anything else (another vocabulary's, a list, a number, a node) is null, a status that never counts.
 */
export function statusOf(v: unknown): string | null {
  const s = typeof v === 'string' ? v : typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as LdNode)['@id'] === 'string' ? ((v as LdNode)['@id'] as string) : null;
  return s == null ? null : s.trim().replace(/^(?:schema:|https?:\/\/schema\.org\/)/, '');
}
/** An order's own mail counts as the order: no status, processing or payment due (allowlist: a status not here never counts). */
const PLACED = new Set(['OrderProcessing', 'OrderPaymentDue']);
/** The statuses of an order an invoice may count for (allowlist: cancelled, returned, a problem, or any other status never). */
const INVOICED = new Set(['OrderProcessing', 'OrderPaymentDue', 'OrderInTransit', 'OrderPickupAvailable', 'OrderDelivered']);

/** An EAN as kept: 13 digits as they are, an ISBN-10 whose check digit holds as its ISBN-13 (978…); else undefined. */
export function isbn13(s: string): string | undefined {
  if (/^\d{13}$/.test(s)) return s;
  if (!/^\d{9}[\dX]$/i.test(s)) return undefined;
  const d = [...s.toUpperCase()].map((c) => (c === 'X' ? 10 : Number(c)));
  if (d.reduce((n, x, i) => n + x * (10 - i), 0) % 11 !== 0) return undefined;
  const twelve = `978${s.slice(0, 9)}`;
  const sum = [...twelve].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0);
  return twelve + ((10 - (sum % 10)) % 10);
}

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
    // "- Okafor, Value Beyond Price, <symbol> 18.90, delivery time 1-3 days"
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
    const inCurrency = tok[i--]?.toUpperCase() === inv.currency;
    const total = money(tok[i--] ?? '');
    const discount = pct(tok[i] ?? '');
    if (discount != null) i--;
    const price = money(tok[i--] ?? '');
    const st = tok[i--]?.toUpperCase() === inv.unit;
    const qty = /^\d{1,2}$/.test(tok[i] ?? '') ? Number(tok[i--]) : null;
    const whole = vat != null && inCurrency && total != null && price != null && st && qty;
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

/** An order or invoice number from markup: 4 to 40 letters, digits and dashes, or nothing (never another shape). */
const MARKUP_NUMBER = /^[A-Za-z0-9][A-Za-z0-9-]{2,38}[A-Za-z0-9]$/;

/**
 * schema.org Order and Invoice markup (JSON-LD) in a verified mail of a connector that says it sends it (`mail.markup`):
 * null when there is none (or the connector's markup does not count), so the mail stays `other`. One Order or one
 * Invoice a mail; each book from its offers (`acceptedOffer`, or `orderedItem`): the product's name, first author,
 * ISBN (or GTIN-13), the quantity and the price, in the connector's currency only. Like every parser it fails closed:
 * an amount in another currency or none, a price it cannot read, a book without a title or a price, an ISBN that is
 * not 13 digits, an invoice without a number or whose stated total is not the sum of its lines, is `unknown_layout`.
 * A product that is no Book (and has no ISBN) is a line that is no book. Every string passes `safeField`.
 */
export function parseMarkup(markup: Markup, address: string[], r: MailRules): Parsed | null {
  if (!r.markup || (!markup.blocks.length && !markup.overflow)) return null;
  const currency = r.markup.currency;
  const { nodes, overflow } = schemaNodes(markup);
  // More markup than is read: an unknown layout, never the part that was read (an order's other books may be beyond it).
  if (overflow) return refuse('online_order', PARSERS.markupOrder, 'more markup than Philobiblos reads');
  // A node another one names by its @id (`{"@id": "#order"}`, the same mail's markup only: nothing is looked up).
  const byId = new Map(nodes.flatMap((n) => (typeof n['@id'] === 'string' ? [[n['@id'], n] as const] : [])));
  const resolve = (v: unknown): LdNode | null => { const n = node(v); return n && typeof n['@id'] === 'string' && !('@type' in n) ? byId.get(n['@id']) ?? null : n; };
  const invoices = nodes.filter((n) => isType(n, 'Invoice'));
  // An Order an Invoice references is that invoice's, not a second document.
  const referenced = new Set(invoices.map((i) => resolve(i.referencesOrder)).filter(Boolean));
  // An order's own mail: none, processing or payment due. A cancellation, a return or a shipping update is no order.
  const placed = (o: LdNode) => o.orderStatus === undefined || PLACED.has(statusOf(o.orderStatus) ?? '');
  const allOrders = nodes.filter((n) => isType(n, 'Order') && !referenced.has(n));
  const orders = allOrders.filter(placed);
  if (!orders.length && !invoices.length) return null;
  const isInvoice = invoices.length > 0;
  const P = isInvoice ? PARSERS.markupInvoice : PARSERS.markupOrder;
  const expected = isInvoice ? 'invoice' : 'online_order';
  const no = (reason: string) => refuse(expected, P, reason);
  if (allOrders.length + invoices.length > 1) return no('more than one order or invoice in one mail');
  const inCurrency = (c: unknown) => (typeof c !== 'string' ? 'none' : c === currency ? 'ok' : 'other');
  /** An amount node's value: `price`/`priceCurrency` (an Offer, a PriceSpecification) or `value`/`currency` (a MonetaryAmount). */
  const amountOf = (n: LdNode | null): { c: number } | { problem: string } => {
    if (!n) return { problem: 'a book without a price' };
    const spec = node(n.priceSpecification);
    const [v, cur] = n.price !== undefined ? [n.price, n.priceCurrency] : n.value !== undefined ? [n.value, n.currency] : spec ? [spec.price, spec.priceCurrency] : [undefined, undefined];
    if (v === undefined) return { problem: 'a book without a price' };
    const ok = inCurrency(cur);
    if (ok === 'none') return { problem: 'an amount without its currency' };
    if (ok === 'other') return { problem: 'an amount in another currency' };
    const c = hundredths(v);
    return c == null ? { problem: 'a price Philobiblos cannot read' } : { c };
  };
  const top = isInvoice ? invoices[0]! : orders[0]!;
  // An invoice for one order, which is no cancellation, return or problem: an invoice naming two orders, or for an order
  // that was not delivered as placed, makes no copies.
  if (isInvoice && Array.isArray(top.referencesOrder) && top.referencesOrder.length > 1) return no('an invoice for more than one order');
  const ord = isInvoice ? resolve(top.referencesOrder) ?? top : top;
  if (isInvoice && ord !== top && ord.orderStatus !== undefined && !INVOICED.has(statusOf(ord.orderStatus) ?? '')) return no('an invoice for an order whose status does not count (cancelled, returned, a problem, or one Philobiblos does not know)');
  // Each article: its Offers (their itemOffered), or else its OrderItems (their orderedItem, their own price): an order
  // that lists its books both ways names each book once, not twice.
  const offers = list(ord.acceptedOffer, LIMITS.books + 1);
  const items = offers.length ? offers : list(ord.orderedItem, LIMITS.books + 1);
  if (items.length > LIMITS.books) return no('too many books');
  if (!items.length) return no('no articles');
  type Line = { title: string | null; author: string | null; ean: string | null; qty: number; priceC: number; notBook?: true };
  const lines: Line[] = [];
  for (const it of items) {
    const o = node(it);
    if (!o) return no('an article Philobiblos cannot read');
    const product = node(o.itemOffered) ?? node(o.orderedItem) ?? o;
    const title = text(product.name);
    if (!title || !title.trim()) return no('a book without a title');
    const rawIsbn = text(product.isbn) ?? text(product.gtin13);
    const ean = rawIsbn == null ? null : isbn13(rawIsbn.replace(/[\s-]/g, ''));
    if (ean === undefined) return no('an ISBN Philobiblos cannot read');
    const price = amountOf(o.price !== undefined || o.priceSpecification !== undefined ? o : node(o.offers) ?? node(product.offers));
    if ('problem' in price) return no(price.problem);
    const q = o.eligibleQuantity !== undefined ? node(o.eligibleQuantity)?.value ?? o.eligibleQuantity : o.orderQuantity !== undefined ? node(o.orderQuantity)?.value ?? o.orderQuantity : 1;
    if (!Number.isInteger(q) || (q as number) < 1 || (q as number) > 99) return no('a quantity Philobiblos cannot read');
    // A book: a Book, or anything whose EAN is an ISBN; never one whose EAN is another product's (a toy, a game).
    const isbn = ean != null && /^97[89]/.test(ean);
    const book = ean != null ? isbn : isType(product, 'Book');
    lines.push({ title: field(title, address), author: field(text(product.author), address, 120), ean: field(ean, address), qty: q as number, priceC: price.c, ...(book ? {} : { notBook: true as const }) });
  }
  // The number as it is kept (through safeField: one with a run of 12 digits is dropped there), so that an invoice whose
  // number cannot be kept is refused rather than counted again when it comes twice.
  const numberOf = (v: unknown) => { const s = text(v); return s != null && MARKUP_NUMBER.test(s.trim()) ? field(s.trim(), address) : null; };
  if (!isInvoice) return { kind: 'online_order', parser: P, orderNumber: numberOf(top.orderNumber), lines };
  const number = numberOf(top.confirmationNumber) ?? numberOf(top.identifier);
  if (!number) return no('an invoice without a number Philobiblos can read');
  // The author stays on the line (it is no PDF row's field): a line without an ISBN matches a book by title and author.
  const out: InvoiceLine[] = lines.map((l) => ({ title: l.title, author: l.author, ean: l.ean, qty: l.qty, priceC: l.priceC, discountPct: null, totalC: l.priceC * l.qty, vatPct: null, ...(l.notBook ? { notBook: true as const } : {}) }));
  const sum = out.reduce((n, l) => n + l.totalC, 0);
  let stated: number | null = null;
  if (top.totalPaymentDue !== undefined) {
    const t = amountOf(node(top.totalPaymentDue));
    if ('problem' in t) return no(t.problem === 'a book without a price' ? 'a total Philobiblos cannot read' : t.problem);
    stated = t.c;
  }
  if (stated != null && stated !== sum) return no('the stated total is not the sum of the lines');
  return { kind: 'invoice', parser: P, invoiceNumber: number, lines: out, totalC: stated ?? sum };
}
