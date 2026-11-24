// Kids' candidate score (docs/spec.md §6). Pure and deterministic.
import type { ScorePart } from './types';

export interface KidWeights {
  base: number;
  themeNew: number;
  themeThinPerBook: number;
  authorOnShelf: number;
  lovedAuthor: number;
  toBuy: number;
  share: number;
  waitingCapDays: number;
  waitingDivisor: number;
  /** Points a book at the household's "dear" limit (`priceHighC`) costs; in proportion below and above it. */
  pricePointsAtHigh: number;
  /** Hundredths of the household's currency; null = no limit, and no price points (packages/scoring price.ts). */
  priceHighC: number | null;
  /** Hundredths of the household's currency: the price assumed when it is unknown (ADR 0008). */
  priceUnknownC: number;
}

export const DEFAULT_KID_WEIGHTS: KidWeights = {
  base: 20, themeNew: 15, themeThinPerBook: 5, authorOnShelf: 15, lovedAuthor: 10,
  toBuy: 12, share: 10, waitingCapDays: 150, waitingDivisor: 15,
  // 12 points at 40 (0.3 a unit) in a household whose unknown price is 25 and that sets no limits of its own.
  pricePointsAtHigh: 12, priceHighC: 4000, priceUnknownC: 2500,
};

export interface KidCandidateFacts {
  /** Books the kid has in the candidate's theme with feedback loved or meh. */
  themeBooks: number;
  /** The same books, a loved one counting 2. */
  themeBooksWeighted: number;
  authorOnShelf: boolean;
  /** The kid loved another book by this author. */
  lovedAuthor: boolean;
  toBuy: boolean;
  fromShare: boolean;
  waitingDays: number;
  /** Hundredths of the household's currency; null = unknown. */
  priceC: number | null;
}

export interface KidSettings {
  /** "+10 if k loved another book by this author and the setting allows". */
  lovedAuthorBonus: boolean;
}

export const DEFAULT_KID_SETTINGS: KidSettings = { lovedAuthorBonus: true };

export function scoreKid(f: KidCandidateFacts, s: KidSettings = DEFAULT_KID_SETTINGS, w: KidWeights = DEFAULT_KID_WEIGHTS): { score: number; parts: ScorePart[] } {
  const price = f.priceC ?? w.priceUnknownC;
  const parts: ScorePart[] = [
    { label: 'Base', value: w.base, kind: 'base' },
    { label: 'A new theme for this kid', value: f.themeBooks === 0 ? w.themeNew : 0, kind: 'themeNew' },
    { label: 'Books already in this theme', value: -w.themeThinPerBook * f.themeBooksWeighted, kind: 'themeThin' },
    { label: 'Author already on the shelf', value: f.authorOnShelf ? -w.authorOnShelf : 0, kind: 'author' },
    { label: 'Loved another book by this author', value: f.lovedAuthor && s.lovedAuthorBonus ? w.lovedAuthor : 0, kind: 'author' },
    { label: 'On the To buy list', value: f.toBuy ? w.toBuy : 0, kind: 'source' },
    { label: 'From a share', value: f.fromShare ? w.share : 0, kind: 'source' },
    { label: 'Waiting', value: Math.min(Math.max(0, f.waitingDays), w.waitingCapDays) / w.waitingDivisor, kind: 'waiting' },
    { label: 'Price', value: w.priceHighC != null && w.priceHighC > 0 ? -(w.pricePointsAtHigh * price) / w.priceHighC : 0, kind: 'price' },
  ];
  return { score: parts.reduce((t, p) => t + p.value, 0), parts: parts.filter((p) => p.value !== 0) };
}
