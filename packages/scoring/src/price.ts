// A household's price limits (docs/spec.md §6, philobiblos#40): in hundredths of its own currency, never a built-in one.
// A household that sets none has limits that follow its unknown price, the one amount it always has (ADR 0008): the
// rule is a ratio, so a household in any currency, with decimals or without, scores and ranks the same.
import { DEFAULT_ADULT_WEIGHTS, type AdultWeights } from './adult';
import { DEFAULT_KID_WEIGHTS, type KidWeights } from './kids';

/** Hundredths of the household's currency; null = no limit. */
export interface PriceLimits { highC: number | null; maxC: number | null }

/** Above `HIGH` times the unknown price a book is dear, above `MAX` times it an adult's candidate is left out (25 → 40, 60). */
export const PRICE_RATIO = { high: 8 / 5, max: 12 / 5 } as const;

/**
 * The limits that follow an unknown price of `unknownC` hundredths, rounded to whole hundredths. An unknown price of 0
 * (a book counts as free until its price is known) gives no limits: 0 would leave out every book with a price.
 */
export function derivedPriceLimits(unknownC: number): PriceLimits {
  if (!(unknownC > 0)) return { highC: null, maxC: null };
  return { highC: Math.round(unknownC * PRICE_RATIO.high), maxC: Math.round(unknownC * PRICE_RATIO.max) };
}

export interface HouseholdMoney {
  /** What a price nobody knows counts as. */
  unknownPriceC: number;
  /** The household's own limits, or null to follow its unknown price. */
  priceLimits: { highC: number; maxC: number } | null;
}

/** The weights a household scores with: the defaults, with its own money. */
export function householdWeights(m: HouseholdMoney, adult: AdultWeights = DEFAULT_ADULT_WEIGHTS, kid: KidWeights = DEFAULT_KID_WEIGHTS): { adult: AdultWeights; kid: KidWeights } {
  const l = m.priceLimits ?? derivedPriceLimits(m.unknownPriceC);
  return {
    adult: { ...adult, priceUnknownC: m.unknownPriceC, priceHighC: l.highC, priceMaxC: l.maxC },
    kid: { ...kid, priceUnknownC: m.unknownPriceC, priceHighC: l.highC },
  };
}
