// The monthly basket (docs/spec.md §5, steps 2–4). Pure: candidates in, picks out. Money in centimes.
import type { Move } from './types';

/** Step 2: `picks` by default, 1 when the unread pile exceeds the limit, 0 when it exceeds twice the limit. */
export function adultPickCount(unreadPile: number, unreadLimit: number, picks = 2): number {
  if (unreadPile > 2 * unreadLimit) return 0;
  if (unreadPile > unreadLimit) return Math.min(picks, 1);
  return picks;
}

export type Mix = 'deepen_connect' | 'deepen_broaden' | 'ai';

export interface AdultPool {
  id: string;
  score: number | null;
  move: Move | null;
  excluded: boolean;
  /** Filtered out before picking: never owned, never redundant, never fiction unless the person allows it. */
  owned?: boolean;
  redundant?: boolean;
  isFiction?: boolean;
}

export interface AdultPickOptions {
  count: number;
  mix: Mix;
  /** In a Deepen + Connect month, every third month one pick becomes Broaden; the caller decides which months. */
  broadenMonth?: boolean;
  allowFiction?: boolean;
}

function eligible(c: AdultPool, allowFiction: boolean): c is AdultPool & { score: number; move: Move } {
  return !c.excluded && c.score != null && c.move != null && !c.owned && !c.redundant && (allowFiction || !c.isFiction);
}

/** The moves the picks are drawn from, in order. */
export function movesFor(mix: Mix, broadenMonth: boolean): Move[] {
  if (mix === 'deepen_broaden') return ['deepen', 'broaden'];
  if (mix === 'deepen_connect') return broadenMonth ? ['deepen', 'broaden'] : ['deepen', 'connect'];
  return []; // 'ai': no fixed moves, best scores first
}

/**
 * Step 2: the best candidate of each move of the mix, in order; when a move has no candidate (or the mix is 'ai'),
 * the best remaining candidate of a move not yet picked.
 */
export function pickAdults(pool: AdultPool[], o: AdultPickOptions): string[] {
  const ranked = pool.filter((c) => eligible(c, o.allowFiction ?? false)).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const picks: (typeof ranked)[number][] = [];
  const wanted = movesFor(o.mix, o.broadenMonth ?? false);
  for (let i = 0; i < o.count; i++) {
    const usedMoves = new Set(picks.map((p) => p.move));
    const free = ranked.filter((c) => !picks.includes(c));
    const move = wanted[i];
    const pick = (move && free.find((c) => c.move === move)) || free.find((c) => !usedMoves.has(c.move));
    if (!pick) break;
    picks.push(pick);
  }
  return picks.map((p) => p.id);
}

export interface KidPool {
  id: string;
  kidId: string;
  score: number;
  theme: string;
  /** Normalised first author. */
  author: string;
  priceC: number;
  authorOnShelf?: boolean;
  owned?: boolean;
}

export interface KidPickOptions {
  /** Kids in round-robin order. */
  kids: string[];
  /** Total of the adult picks already in the basket. */
  totalC: number;
  minC: number;
  maxC: number;
  /** Household setting `new_authors_only`. */
  skipShelfAuthors: boolean;
}

/**
 * Steps 3 and 4: greedy by score, at most one book per theme and per author in the month, kids taking turns, while the
 * total stays within max. If the total is still under min, the next best kids' book that fits is added, without the
 * theme and author limits.
 */
export function pickKids(pool: KidPool[], o: KidPickOptions): { ids: string[]; totalC: number } {
  const ok = pool.filter((c) => !c.owned && !(o.skipShelfAuthors && c.authorOnShelf));
  const ranked = [...ok].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const picked: KidPool[] = [];
  let total = o.totalC;
  const themes = new Set<string>();
  const authors = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const kid of o.kids) {
      const c = ranked.find((x) => x.kidId === kid && !picked.includes(x) && !themes.has(x.theme) && !authors.has(x.author) && total + x.priceC <= o.maxC);
      if (!c) continue;
      picked.push(c);
      themes.add(c.theme);
      authors.add(c.author);
      total += c.priceC;
      progress = true;
    }
  }
  while (total < o.minC) {
    const c = ranked.find((x) => !picked.includes(x) && total + x.priceC <= o.maxC);
    if (!c) break;
    picked.push(c);
    total += c.priceC;
  }
  return { ids: picked.map((p) => p.id), totalC: total };
}
