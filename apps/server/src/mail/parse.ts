// The bookshop's mails, read into structured fields (ADR 0007, contracts/connectors.md "Kind"). Pure: a verified mail's
// text (or an invoice PDF's rows from the media worker) in, fields out; nothing here touches the database.
//
// Every parser is bounded (lines, line length, books per mail) and linear: lines are split and matched with anchored
// expressions that cannot backtrack, never one pattern over the whole text. Each fails closed: a mail whose kind is
// recognised but whose layout is not (a price Shelf cannot place, a book row it cannot read, a stated total that is
// not the sum of the rows) is `unknown_layout`, stamped with the parser's version, and changes nothing. Every string
// field passes `safeField` (read.ts) on its way out. The household's own request, quoted below a reply, is never read:
// lines from the first reply marker on, and any line starting with `>`, are left out.
import { safeField } from './read';

/** One version per parser: a row records the one that read it (and an unknown layout is read again under a new one). */
export const PARSERS = { quote: 'quote-1', confirm: 'confirm-1', online: 'online-1', collect: 'collect-1', invoice: 'invoice-1', classify: 'classify-1' } as const;
export const LIMITS = { lines: 5000, lineChars: 1000, books: 100 } as const;

export interface QuoteLine { title: string | null; author: string | null; ean: string | null; priceC: number | null; delivery: string | null; available: boolean }
export interface ShopLine { title: string | null; author: string | null; ean: string | null; qty: number; priceC: number }
export interface InvoiceLine { title: string | null; ean: string | null; qty: number; priceC: number; discountPct: number | null; totalC: number; vatPct: number }

export type Parsed =
  | { kind: 'bookshop_quote'; parser: string; lines: QuoteLine[] }
  | { kind: 'bookshop_confirm'; parser: string; orderNumber: string | null }
  | { kind: 'online_order' | 'click_collect'; parser: string; orderNumber: string | null; lines: ShopLine[] }
  | { kind: 'invoice'; parser: string; invoiceNumber: string | null; lines: InvoiceLine[]; totalC: number | null }
  | { kind: 'unknown_layout'; parser: string; expected: string; reason: string }
  | { kind: 'other'; parser: string };

/** What the mail is, from its signed sender and subject; an invoice waits for its PDF rows (`parseInvoice`). */
export type Kind = { kind: 'quote_or_confirm' } | { kind: 'online_order' | 'click_collect'; number: string } | { kind: 'invoice'; number: string } | { kind: 'other' };

const QUOTE_SENDER = 'english-orders@orellfuessli.ch';
// The subject as kept: through safeField, so diacritics are folded (Füssli, Fuessli or Fussli).
const SHOP = 'Orell ?F(?:ü|ue|u)ssli';
const SUBJECTS: [Exclude<Kind['kind'], 'quote_or_confirm' | 'other'>, RegExp][] = [
  ['online_order', new RegExp(`^Ihre ${SHOP} Bestellung \\((\\d{4,12})\\)$`, 'i')],
  ['click_collect', /^Wir bearbeiten Ihre Bestellung \((\d{4,12})\)$/i],
  ['invoice', new RegExp(`^Ihre ${SHOP.replace(' ?', '-? ?')}-Rechnung Nr\\.? ?(\\d{4,12})$`, 'i')],
];

export function classify(from: string, subject: string | null): Kind {
  const s = (subject ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  for (const [kind, re] of SUBJECTS) { const m = re.exec(s); if (m) return { kind, number: m[1]! } as Kind; }
  if (from === QUOTE_SENDER) return { kind: 'quote_or_confirm' };
  return { kind: 'other' };
}

const refuse = (expected: string, parser: string, reason: string): Parsed => ({ kind: 'unknown_layout', parser, expected, reason });

/** "CHF 19.90", "Fr. 16.90", "19.90 CHF" → centimes (up to 9999.99), or null. */
export function priceC(s: string): number | null {
  const m = /(?:CHF|Fr\.)\s?(\d{1,4})[.,](\d{2})(?!\d)|(?<![\d.,])(\d{1,4})[.,](\d{2})\s?CHF\b/i.exec(s);
  if (!m) return null;
  return Number(m[1] ?? m[3]) * 100 + Number(m[2] ?? m[4]);
}
const HAS_PRICE = /(?:CHF|Fr\.)\s?\d|\d[.,]\d{2}\s?CHF\b/i;
/** Lines with an amount that is no book's: totals, postage, discounts, VAT. */
const SUMMARY = /^(?:total|sub-?total|sum|gesamt\w*|zwischensumme|rechnungsbetrag|totalbetrag|shipping|postage|delivery charge|versand\w*|porto|rabatt|discount|mwst|vat)\b/i;
const UNAVAILABLE = /\b(?:not in stock|out of stock|back-?order(?:ed)?|not available|unavailable|out of print|nicht lieferbar|vergriffen)\b/i;
/** Where the household's quoted request begins (each test linear: anchored, or a plain search). */
const REPLY: ((l: string) => boolean)[] = [
  (l) => /^-{2,} ?(?:original message|ursprüngliche nachricht|message d'origine|messaggio originale)/i.test(l),
  (l) => /^_{8,}$/.test(l),
  (l) => /^(?:from|von|de|da|sent|gesendet|envoyé|inviato) ?: /i.test(l),
  (l) => /^(?:on|am|le|il) /i.test(l) && l.endsWith(':') && /\b(?:wrote|schrieb|a écrit|ha scritto)\b/i.test(l),
];
/**
 * The text's own lines: NFKC, format characters gone, trimmed; the quoted request (from the first reply marker on,
 * and `>` lines) left out. Null when there are too many lines or one too long holds an amount.
 */
export function ownLines(text: string): string[] | null {
  const all = text.split(/\r?\n/);
  if (all.length > LIMITS.lines) return null;
  const out: string[] = [];
  for (const raw of all) {
    const l = raw.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
    if (l.length > LIMITS.lineChars) { if (HAS_PRICE.test(l)) return null; continue; }
    if (REPLY.some((r) => r(l))) break;
    if (l.startsWith('>')) continue;
    out.push(l);
  }
  return out;
}

const digits = (s: string) => s.replace(/[\s-]/g, '');
const EAN = /^(?:97[89]\d{10}|\d{13})$/;
const field = (v: string | null | undefined, address: string[], max = 200) => (v ? safeField(v.slice(0, max), address) : null);

/** Quote replies, the three layouts of contracts/connectors.md (and a block written on one line with ` / `). */
export function parseQuote(text: string, address: string[]): Parsed {
  const P = PARSERS.quote;
  const lines = ownLines(text);
  if (!lines) return refuse('bookshop_quote', P, 'too long');
  // "Author: X / Title: Y / ISBN: n": a block on one line is the same block.
  const ls = lines.flatMap((l) => l.split(/ \/ (?=(?:author|title|isbn|price|delivery|availability)\b)/i));
  if (/\bwe have now ordered\b/i.test(ls.join('\n'))) {
    const m = ls.map((l) => /\border (?:number|no\.?)\s?[:#]?\s?(\d{4,12})\b/i.exec(l)).find(Boolean);
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
    const p = b.price ? priceC(b.price) : null;
    const unavailable = Boolean(b.unavailable) || UNAVAILABLE.test(`${b.price ?? ''} ${b.delivery ?? ''}`);
    if (p == null && !unavailable) { problem = 'a book with neither a price nor a status'; return; }
    const ean = b.isbn ? digits(b.isbn) : null;
    if (ean != null && !EAN.test(ean)) { problem = 'an ISBN Shelf cannot read'; return; }
    out.push({ title: field(b.title, address), author: field(b.author, address, 120), ean: field(ean, address), priceC: unavailable ? null : p, delivery: field(b.delivery, address, 80), available: !unavailable });
  };
  for (let i = 0; i < ls.length && !problem; i++) {
    const l = ls[i]!;
    if (!l) continue;
    const f = /^(author|title|isbn|price|delivery(?: due| time)?|availability)\s?[:.]\s?(.*)$/i.exec(l);
    if (f) {
      const name = f[1]!.toLowerCase();
      const label = (name.startsWith('delivery') || name === 'availability' ? 'delivery' : name) as 'author' | 'title' | 'isbn' | 'price' | 'delivery';
      const v = f[2]!.trim();
      // A second author, title or ISBN starts the next book; a second price or delivery in one book is a layout Shelf does not know.
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
      const at = parts.findIndex((p) => /^(?:CHF|Fr\.)\s?\d/i.test(p));
      const end = at >= 0 ? at : parts.length - 1;
      if (parts.length < 3 || end < 2 || (at < 0 && !UNAVAILABLE.test(parts[end]!))) {
        if (HAS_PRICE.test(l)) problem = 'a price Shelf cannot place';
        continue;
      }
      cur = { author: parts[0], title: parts.slice(1, end).join(', '), price: at >= 0 ? parts[at] : undefined, delivery: parts.slice(end + (at >= 0 ? 1 : 0)).join(', ').replace(/^delivery (?:time|due)\s?:?\s?/i, '') || undefined };
      flush();
      continue;
    }
    // "Paulsen, The Quiet Hedgehog" above an ISBN line
    const next = ls.slice(i + 1).find((x) => x);
    const head = /^([^,:]{1,80}),\s?([^:]{1,200})$/.exec(l);
    if (head && next && /^isbn\b/i.test(next)) {
      flush();
      cur = { author: head[1], title: head[2] };
      continue;
    }
    if (cur && UNAVAILABLE.test(l) && !HAS_PRICE.test(l)) { cur.unavailable = true; continue; }
    if (HAS_PRICE.test(l) && !SUMMARY.test(l)) problem = 'a price Shelf cannot place';
  }
  if (!problem) flush();
  if (problem) return refuse('bookshop_quote', P, problem);
  if (!out.length) return refuse('bookshop_quote', P, 'no books');
  if (out.length > LIMITS.books) return refuse('bookshop_quote', P, 'too many books');
  return { kind: 'bookshop_quote', parser: P, lines: out };
}

/** Kinds of article in the shop's mails; only the first two are books, the others are skipped (contracts/connectors.md). */
const BOOKS = new Set(['buch', 'taschenbuch']);
const NOT_BOOKS = new Set(['spielwaren', 'spiel', 'geschenk', 'papeterie', 'ebook', 'hörbuch', 'film', 'musik', 'kalender', 'tonie']);

/**
 * Online orders and click & collect: one line per article, `Buch <title> von <author> [EAN: <ean>] | [<n> x ]Fr. <price>`.
 */
export function parseShop(kind: 'online_order' | 'click_collect', number: string, text: string, address: string[]): Parsed {
  const P = kind === 'online_order' ? PARSERS.online : PARSERS.collect;
  const lines = ownLines(text);
  if (!lines) return refuse(kind, P, 'too long');
  const out: ShopLine[] = [];
  for (const l of lines) {
    if (!HAS_PRICE.test(l)) continue;
    if (SUMMARY.test(l)) continue;
    const bar = l.lastIndexOf(' | ');
    const right = bar >= 0 ? /^(?:(\d{1,2}) ?[x×] ?)?Fr\. ?(\d{1,4})[.,](\d{2})$/i.exec(l.slice(bar + 3)) : null;
    const sp = l.indexOf(' ');
    const what = sp > 0 ? l.slice(0, sp).toLowerCase() : '';
    if (!right || sp > bar || (!BOOKS.has(what) && !NOT_BOOKS.has(what))) return refuse(kind, P, 'a price Shelf cannot place');
    if (NOT_BOOKS.has(what)) continue;
    let left = l.slice(sp + 1, bar);
    const ean = / EAN: ?(\d{13})$/i.exec(left);
    if (ean) left = left.slice(0, ean.index);
    const von = left.indexOf(' von ');
    out.push({
      title: field(von >= 0 ? left.slice(0, von) : left, address), author: von >= 0 ? field(left.slice(von + 5), address, 120) : null,
      ean: field(ean?.[1], address), qty: Number(right[1] ?? 1), priceC: Number(right[2]) * 100 + Number(right[3]),
    });
    if (out.length > LIMITS.books) return refuse(kind, P, 'too many books');
  }
  if (!out.length) return refuse(kind, P, 'no articles');
  return { kind, parser: P, orderNumber: field(number, address), lines: out };
}

const money = (s: string) => { const m = /^(\d{1,6})[.,](\d{2})$/.exec(s); return m ? Number(m[1]) * 100 + Number(m[2]) : null; };
const pct = (s: string) => { const m = /^(\d{1,2}(?:[.,]\d{1,2})?)%$/.exec(s); return m ? Number(m[1]!.replace(',', '.')) : null; };

/**
 * An invoice PDF's rows (cells as the worker split them): `EAN  Title  qty ST  price  [discount %]  total CHF  VAT %`.
 * A row that begins with an EAN must read whole, and a stated total must be the rows' sum (with postage), or the
 * invoice is refused.
 */
export function parseInvoice(number: string, rows: string[][], truncated: boolean, address: string[]): Parsed {
  const P = PARSERS.invoice;
  if (truncated) return refuse('invoice', P, 'the PDF was cut short');
  const out: InvoiceLine[] = [];
  let stated: number | null = null, postage = 0;
  for (const row of rows) {
    const s = row.join(' ').normalize('NFKC').replace(/\s+/g, ' ').trim().replace(/(\d) %/g, '$1%');
    if (s.length > LIMITS.lineChars) return refuse('invoice', P, 'a row too long');
    const tok = s.split(' ');
    const lastAmount = () => { for (let i = tok.length - 1; i >= 0; i--) { const m = money(tok[i]!); if (m != null) return m; } return null; };
    if (/^(?:total|gesamt\w*|rechnungsbetrag|totalbetrag)\b/i.test(s)) { stated = lastAmount(); continue; }
    if (/^(?:versand\w*|porto|shipping)\b/i.test(s)) { postage += lastAmount() ?? 0; continue; }
    if (!/^\d{13}$/.test(tok[0]!)) continue;
    // From the end: VAT %, CHF, total, [discount %], price, ST, qty; the title is what is left.
    let i = tok.length - 1;
    const vat = pct(tok[i--] ?? '');
    const chf = tok[i--]?.toUpperCase() === 'CHF';
    const total = money(tok[i--] ?? '');
    const discount = pct(tok[i] ?? '');
    if (discount != null) i--;
    const price = money(tok[i--] ?? '');
    const st = tok[i--]?.toUpperCase() === 'ST';
    const qty = /^\d{1,2}$/.test(tok[i] ?? '') ? Number(tok[i--]) : null;
    if (vat == null || !chf || total == null || price == null || !st || !qty || i < 1) return refuse('invoice', P, 'a book row Shelf cannot read');
    out.push({ ean: field(tok[0], address), title: field(tok.slice(1, i + 1).join(' '), address), qty, priceC: price, discountPct: discount, totalC: total, vatPct: vat });
    if (out.length > LIMITS.books) return refuse('invoice', P, 'too many books');
  }
  if (!out.length) return refuse('invoice', P, 'no book rows');
  const sum = out.reduce((n, l) => n + l.totalC, 0) + postage;
  if (stated != null && stated !== sum) return refuse('invoice', P, 'the stated total is not the sum of the rows');
  return { kind: 'invoice', parser: P, invoiceNumber: field(number, address), lines: out, totalC: stated ?? sum };
}
