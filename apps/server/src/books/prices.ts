// Price estimates (ADR 0008): a read-only lookup behind `PriceSource`, so it can be swapped or turned off. The bookshop's
// quote stays the truth; an estimate only helps the month's plan fit the budget, and an unknown price counts as the
// household's own amount (Settings, household/money.ts), in the plan and in packages/scoring (`priceUnknownC`).
//
// Which shop is asked, and how its page reads, is the connector's (`prices` in connectors/<id>/connector.yaml): the
// search URL, the article links, the print formats, the languages and the availability words. Nothing here names a shop.
// The page is read as text (no script runs, no DOM), only the fields below are kept, and no wishlist, cart or account is
// touched. The page is hostile input; the egress client holds it to 1 MB and 10 s, on its own host, and that host is on
// the allowlist only while an admin has the connector enabled.
import { priceAsks, priceUrlShape, type Connector, type SearchTiles } from '@philobiblos/contracts/connector';
import { bookIsbn } from './isbn';
import type { Egress } from '../net/egress';
import { norm } from '../seed/import';
import { alternation, amountFinder, contains, literal } from '../connectors/text';
import { currencyDigits } from '../household/currency';
import { hundredths, isType, ldBlocks, list, node, schemaNodes, text, type LdNode } from '../schemaorg/jsonld';

export interface Offer { externalId: string | null; priceC: number | null; availability: string | null }
export interface PriceSource {
  /** The source's name in book_offer.source: its connector's id. */
  id: string;
  /** What it sends: a book's title and first author (the default), or its ISBN-13 alone (only books with one are asked). */
  asks?: 'title' | 'isbn';
  /** The offer for this book, or null when the source has no matching edition. Network and refusals are thrown. */
  find(b: { title: string; authors: string[]; isbn13?: string | null }): Promise<Offer | null>;
}

/** How a connector's search page reads: its `prices` and its `money`, as the fixed shapes below. */
export interface TileRules { host: string; article: RegExp; print: (s: string) => boolean; want: (s: string) => boolean; other: (s: string) => boolean; price: (s: string) => number | null; availability: RegExp }

/**
 * The shapes, each built from the connector's words as literals (connectors/text.ts): an article link is
 * `href="[https://<host>]<path><prefix><digits>…"`; an amount is `<symbol> 12.90`; availability is a phrase, then
 * optionally a joiner, up to 12 digits, dots, dashes or spaces, and a unit (`Ships in 2-3 days`).
 */
export function tileRules(c: Pick<Connector, 'money' | 'locale'> & { prices: SearchTiles }): TileRules {
  const p = c.prices;
  const host = new URL(priceUrlShape(p.url)).hostname;
  const [lo, hi] = p.article.id_digits;
  const av = p.availability;
  return {
    host,
    article: new RegExp(`href="(?:https://${literal(host)})?${literal(p.article.path)}(${literal(p.article.id_prefix)}\\d{${lo},${hi}})[^"<>]{0,200}"`, 'g'),
    print: contains(p.print_formats), want: contains(p.want_languages), other: contains(p.other_languages),
    // The currency's own decimals (philobiblos#62); one with a thousandth is no price Philobiblos keeps.
    price: amountFinder({ ...c.money, after: [] }, currencyDigits(c.locale.currency)),
    availability: new RegExp(`(?<![\\p{L}\\p{N}])(${alternation(av.phrases)}(?: ${alternation(av.joiners)} [\\d.\\- ]{1,12}${alternation(av.units)}?)?)`, 'u'),
  };
}

/** The most of a search page that is read, and of each result tile (the egress client stops at its own 1 MB). */
export const PAGE_MAX = 1 << 20;
export const TILE_MAX = 4000;
const SKIP = ['script', 'style', 'template', 'noscript'];

/**
 * Text of an HTML fragment: tags dropped, the content of script, style, template and noscript dropped, the common
 * entities decoded, whitespace folded. One pass with indexOf, each search starting where the last one ended, so the
 * work is linear in the input whatever it holds (no regular expression that can backtrack over a tag).
 */
export function textOf(html: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt) + ' ';
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) break; // an unclosed tag: nothing after it is text
    const name = /^<([a-z]+)/.exec(lower.slice(lt, lt + 12))?.[1];
    if (name && SKIP.includes(name)) {
      const close = lower.indexOf(`</${name}`, gt + 1);
      if (close < 0) break; // unclosed script or style: the rest is its content
      const after = html.indexOf('>', close);
      if (after < 0) break;
      i = after + 1;
    } else {
      i = gt + 1;
    }
  }
  return out
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

export interface Tile { externalId: string; title: string; text: string }

/** The result tiles of a search page: each article link and the page text after it (up to the next one, 4000 characters at most). */
export function parseTiles(html: string, r: Pick<TileRules, 'article'>): Tile[] {
  const page = html.slice(0, PAGE_MAX);
  const hits = [...page.matchAll(r.article)];
  const tiles: Tile[] = [];
  for (let i = 0; i < hits.length && tiles.length < 48; i++) {
    const h = hits[i]!;
    const id = h[1]!;
    if (tiles.some((t) => t.externalId === id)) continue;
    const end = page.indexOf('>', h.index) + 1;
    const close = end > 0 ? page.indexOf('</a>', end) : -1;
    const title = close > 0 && close - end < 2000 ? textOf(page.slice(end, close)).slice(0, 300) : '';
    const next = hits.slice(i + 1).find((x) => x[1] !== id);
    const text = textOf(page.slice(h.index, Math.min(next ? next.index : page.length, h.index + TILE_MAX))).slice(0, 2000);
    tiles.push({ externalId: id, title, text });
  }
  return tiles;
}

/** The print edition in a language the connector wants whose normalised title matches; tiles naming another language are skipped. */
export function pickOffer(tiles: Tile[], title: string, authors: string[], r: TileRules): Offer | null {
  const want = norm(title);
  const surname = authors[0] ? norm(authors[0].split(/\s+/).at(-1) ?? '') : '';
  const matching = tiles.filter((t) => norm(t.title) === want && r.print(t.text) && (!surname || norm(t.text).includes(surname)) && !r.other(t.text));
  const best = matching.find((t) => r.want(t.text)) ?? matching[0];
  if (!best) return null;
  return { externalId: best.externalId, priceC: r.price(best.text), availability: r.availability.exec(best.text)?.[1]?.trim() ?? null };
}

/** The search URL for a book: its title and first author, form-encoded (spaces as +), in the one place the template leaves. */
function titleUrl(template: string, b: { title: string; authors: string[] }): string {
  const q = [b.title, b.authors[0] ?? ''].join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return template.replace('{query}', new URLSearchParams([['q', q]]).toString().slice(2));
}
/** The lookup URL by ISBN: the book's ISBN-13 alone, or null without a valid one (nothing is asked). */
function isbnUrl(template: string, isbn13: string | null | undefined): string | null {
  return isbn13 && bookIsbn(isbn13) === isbn13 ? template.replace('{isbn}', isbn13) : null;
}

/** A connector's price lookup: its search page, asked with the title and first author, through the one egress client. */
export function searchTiles(id: string, c: Pick<Connector, 'money' | 'locale'> & { prices: SearchTiles }, egress: Egress): PriceSource {
  const r = tileRules(c);
  return {
    id,
    async find(b) {
      const page = await egress.get(titleUrl(c.prices.url, b), 'html');
      return pickOffer(parseTiles(page.body.toString('utf8'), r), b.title, b.authors, r);
    },
  };
}

/** schema.org's availability, as the few words Philobiblos shows (any other value is shown as nothing). */
const AVAILABILITY: Record<string, string> = {
  InStock: 'in stock', InStoreOnly: 'in store only', OnlineOnly: 'online only', LimitedAvailability: 'limited availability',
  PreOrder: 'pre-order', PreSale: 'pre-sale', BackOrder: 'back order', MadeToOrder: 'made to order', OutOfStock: 'out of stock',
  SoldOut: 'sold out', Discontinued: 'discontinued',
};
const availabilityOf = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.replace(/^(?:schema:|https?:\/\/schema\.org\/)/, '') : '';
  return Object.hasOwn(AVAILABILITY, s) ? AVAILABILITY[s]! : null;
};
/** A product's id as Philobiblos keeps it: its GTIN-13, ISBN or SKU, a short token of letters, digits, dots and dashes. */
const idOf = (p: LdNode): string | null => {
  for (const v of [p.gtin13, p.isbn, p.sku, p.productID]) { const s = text(v)?.trim(); if (s && /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(s)) return s; }
  return null;
};

/**
 * The offer for this book among a page's schema.org markup: Books and Products (on their own, in an ItemList's
 * ListItems, or in @graph) whose normalised name is the title and, when an author is known, whose author holds the
 * first author's surname, never an e-book or an audiobook (`bookFormat`); their offers (an Offer, a list of them, or an AggregateOffer's lowPrice) in this currency only;
 * the cheapest of those. With `by.isbn13` (a lookup by ISBN), the product that carries that ISBN instead, whatever its name. A price it cannot read is no price. Nothing of the page but these fields is kept.
 */
export function pickProduct(nodes: LdNode[], title: string, authors: string[], currency: string, by?: { isbn13: string }): Offer | null {
  const want = norm(title);
  const surname = authors[0] ? norm(authors[0].split(/\s+/).at(-1) ?? '') : '';
  const products = nodes.flatMap((n) => (isType(n, 'ItemList') ? list(n.itemListElement, 100).map((e) => node(e)).map((e) => (e && isType(e, 'ListItem') ? node(e.item) : e)) : [n]))
    .filter((p): p is LdNode => isType(p, 'Book', 'Product'));
  let best: (Offer & { at: number }) | null = null;
  for (const p of products.slice(0, 100)) {
    if (by) {
      // Asked by ISBN: the product that carries the book's ISBN (its GTIN-13 or ISBN, an ISBN-10 read as its ISBN-13),
      // whatever its name; one with another ISBN or none is never the book.
      if (![p.gtin13, p.isbn].some((v) => { const s = text(v); return s != null && bookIsbn(s) === by.isbn13; })) continue;
    } else {
      if (norm(text(p.name) ?? '') !== want) continue;
      // The author as the tiles' lookup takes it: the surname anywhere in the name ("Okafor, Mira" too).
      if (surname && !list(p.author, 8).some((a) => norm(text(a) ?? '').includes(surname))) continue;
    }
    // A printed book only, as the household orders: never an e-book's or an audiobook's price.
    if (list(p.bookFormat, 4).some((f) => /(?:^|[/:])(?:EBook|AudiobookFormat)$/.test(String(f)))) continue;
    for (const o of list(p.offers, 20).map(node)) {
      if (!o || o.priceCurrency !== currency) continue;
      const priceC = hundredths(o[isType(o, 'AggregateOffer') ? 'lowPrice' : 'price'], currency);
      const at = priceC ?? Number.MAX_SAFE_INTEGER;
      if (!best || at < best.at) best = { externalId: idOf(p), priceC, availability: availabilityOf(o.availability), at };
    }
  }
  if (!best) return null;
  return { externalId: best.externalId, priceC: best.priceC, availability: best.availability };
}

/** The offer for this book on a search page (pickProduct), or none when the page holds more markup than is read. */
export function pageOffer(html: string, title: string, authors: string[], currency: string, by?: { isbn13: string }): Offer | null {
  const { nodes, overflow } = schemaNodes(ldBlocks(html.slice(0, PAGE_MAX), html.length > PAGE_MAX));
  return overflow ? null : pickProduct(nodes, title, authors, currency, by);
}

/** A connector's price lookup through its search page's Product markup (`prices.kind: jsonld`), in its currency. */
export function markupPrices(id: string, c: Pick<Connector, 'locale'> & { prices: { url: string } }, egress: Egress): PriceSource {
  const asks = priceAsks(c.prices.url);
  return {
    id,
    asks,
    async find(b) {
      if (asks === 'title') {
        const page = await egress.get(titleUrl(c.prices.url, b), 'html');
        return pageOffer(page.body.toString('utf8'), b.title, b.authors, c.locale.currency);
      }
      const url = isbnUrl(c.prices.url, b.isbn13);
      if (url === null) return null;
      const page = await egress.get(url, 'html');
      return pageOffer(page.body.toString('utf8'), b.title, b.authors, c.locale.currency, { isbn13: b.isbn13! });
    },
  };
}
