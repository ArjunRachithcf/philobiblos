// Price estimates (ADR 0008): a read-only lookup behind `PriceSource`, so it can be swapped or turned off. The bookshop's
// quote stays the truth; an estimate only helps the month's plan fit the budget, and an unknown price counts as CHF 25
// in packages/scoring (`priceUnknown`).
//
// Which shop is asked, and how its page reads, is the connector's (`prices` in connectors/<id>/connector.yaml): the
// search URL, the article links, the print formats, the languages and the availability words. Nothing here names a shop.
// The page is read as text (no script runs, no DOM), only the fields below are kept, and no wishlist, cart or account is
// touched. The page is hostile input; the egress client holds it to 1 MB and 10 s, on its own host, and that host is on
// the allowlist only while an admin has the connector enabled.
import type { Connector } from '@philobiblos/contracts/connector';
import type { Egress } from '../net/egress';
import { norm, parsePriceC } from '../seed/import';
import { alternation, contains, literal } from '../connectors/text';

/** What an unknown price counts as in a month's budget, centimes (ADR 0008; packages/scoring's `priceUnknown`). */
export const UNKNOWN_PRICE_C = 2500;

export interface Offer { externalId: string; priceC: number | null; availability: string | null }
export interface PriceSource {
  /** The source's name in book_offer.source: its connector's id. */
  id: string;
  /** The offer for this book, or null when the source has no matching edition. Network and refusals are thrown. */
  find(b: { title: string; authors: string[] }): Promise<Offer | null>;
}

/** How a connector's search page reads: its `prices` and its `money`, as the fixed shapes below. */
export interface TileRules { host: string; article: RegExp; print: (s: string) => boolean; want: (s: string) => boolean; other: (s: string) => boolean; price: RegExp; availability: RegExp }

/**
 * The shapes, each built from the connector's words as literals (connectors/text.ts): an article link is
 * `href="[https://<host>]<path><prefix><digits>…"`; an amount is `<symbol> 12.90`; availability is a phrase, then
 * optionally a joiner, up to 12 digits, dots, dashes or spaces, and a unit (`Lieferbar in 2-3 Tagen`).
 */
export function tileRules(c: Pick<Connector, 'money'> & { prices: NonNullable<Connector['prices']> }): TileRules {
  const p = c.prices;
  const host = new URL(p.url.replace('{query}', 'q')).hostname;
  const [lo, hi] = p.article.id_digits;
  const av = p.availability;
  return {
    host,
    article: new RegExp(`href="(?:https://${literal(host)})?${literal(p.article.path)}(${literal(p.article.id_prefix)}\\d{${lo},${hi}})[^"<>]{0,200}"`, 'g'),
    print: contains(p.print_formats), want: contains(p.want_languages), other: contains(p.other_languages),
    price: new RegExp(`${alternation(c.money.before)}\\s{0,3}(\\d{1,4}[.,]\\d{2})`, 'iu'),
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
  const price = r.price.exec(best.text);
  return { externalId: best.externalId, priceC: price ? parsePriceC(price[1]) : null, availability: r.availability.exec(best.text)?.[1]?.trim() ?? null };
}

/** A connector's price lookup: its search page, asked with the title and first author, through the one egress client. */
export function searchTiles(id: string, c: Pick<Connector, 'money'> & { prices: NonNullable<Connector['prices']> }, egress: Egress): PriceSource {
  const r = tileRules(c);
  return {
    id,
    async find(b) {
      const q = [b.title, b.authors[0] ?? ''].join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      // Form-encoded (spaces as +), into the one place the template leaves for it: the query string.
      const page = await egress.get(c.prices.url.replace('{query}', new URLSearchParams([['q', q]]).toString().slice(2)), 'html');
      return pickOffer(parseTiles(page.body.toString('utf8'), r), b.title, b.authors, r);
    },
  };
}
