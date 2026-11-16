// Price estimates (ADR 0008): a read-only lookup behind `PriceSource`, so it can be swapped or turned off. The bookshop's
// quote stays the truth; an estimate only helps the month's plan fit the budget, and an unknown price counts as CHF 25
// in packages/scoring (`priceUnknown`).
//
// Orell Füssli has no API: the source reads its search page as text (no script runs, no DOM), keeps only the fields
// below, and never touches a wishlist, cart or account. The page is hostile input; the egress client holds it to 2 MB
// and 10 s, on its own host.
import type { Egress } from '../net/egress';
import { norm, parsePriceC } from '../seed/import';

/** What an unknown price counts as in a month's budget, centimes (ADR 0008; packages/scoring's `priceUnknown`). */
export const UNKNOWN_PRICE_C = 2500;

export interface Offer { externalId: string; priceC: number | null; availability: string | null }
export interface PriceSource {
  /** The source's name in book_offer.source. */
  id: string;
  /** The offer for this book, or null when the source has no matching edition. Network and refusals are thrown. */
  find(b: { title: string; authors: string[] }): Promise<Offer | null>;
}

const ARTICLE = /href="(?:https:\/\/www\.orellfuessli\.ch)?\/shop\/home\/artikeldetails\/(A\d{6,14})[^"]*"/g;
const PRINT = /\bBuch \((?:Taschenbuch|Gebundene Ausgabe)\)/;
const PRICE = /(?:Fr\.|CHF)\s*(\d{1,4}[.,]\d{2})/;
const ENGLISH = /\b(?:Englisch|English)\b/;
const AVAILABILITY = /\b((?:Sofort lieferbar|Lieferbar|Versandfertig|Nicht lieferbar|Vorbestellbar|Erscheint)(?: (?:in|innerhalb|ab|am) [\d.\- ]{1,12}(?:Werktagen|Tagen|Tag|Wochen|Woche)?)?)/;

/** Text of an HTML fragment: tags dropped, the common entities decoded, whitespace folded. */
export function textOf(html: string): string {
  return html
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

export interface Tile { externalId: string; title: string; text: string }

/** The result tiles of a search page: each article link and the page text up to the next one. */
export function parseTiles(html: string): Tile[] {
  const page = html.slice(0, 2 << 20);
  const hits = [...page.matchAll(ARTICLE)];
  const tiles: Tile[] = [];
  for (let i = 0; i < hits.length && tiles.length < 48; i++) {
    const h = hits[i]!;
    const id = h[1]!;
    if (tiles.some((t) => t.externalId === id)) continue;
    const end = page.indexOf('>', h.index) + 1;
    const close = page.indexOf('</a>', end);
    const title = close > 0 ? textOf(page.slice(end, close)).slice(0, 300) : '';
    const next = hits.slice(i + 1).find((x) => x[1] !== id);
    const text = textOf(page.slice(h.index, next ? next.index : Math.min(page.length, h.index + 4000))).slice(0, 2000);
    tiles.push({ externalId: id, title, text });
  }
  return tiles;
}

/** The English print edition whose normalised title matches; tiles that name another language are skipped. */
export function pickOffer(tiles: Tile[], title: string, authors: string[]): Offer | null {
  const want = norm(title);
  const surname = authors[0] ? norm(authors[0].split(/\s+/).at(-1) ?? '') : '';
  const matching = tiles.filter((t) => norm(t.title) === want && PRINT.test(t.text) && (!surname || norm(t.text).includes(surname))
    && !/\b(?:Deutsch|Französisch|Italienisch|Spanisch)\b/.test(t.text));
  const best = matching.find((t) => ENGLISH.test(t.text)) ?? matching[0];
  if (!best) return null;
  const price = PRICE.exec(best.text);
  return { externalId: best.externalId, priceC: price ? parsePriceC(price[1]) : null, availability: AVAILABILITY.exec(best.text)?.[1]?.trim() ?? null };
}

export function orellFuessli(egress: Egress): PriceSource {
  return {
    id: 'orellfuessli',
    async find(b) {
      const q = [b.title, b.authors[0] ?? ''].join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      const page = await egress.get(`https://www.orellfuessli.ch/suche?${new URLSearchParams({ sq: q })}`, 'html');
      return pickOffer(parseTiles(page.body.toString('utf8')), b.title, b.authors);
    },
  };
}
