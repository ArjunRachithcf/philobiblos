// Adult candidate score (docs/spec.md §6). Pure and deterministic; the AI never sets scores (ADR 0004).
import type { Layer, Move, ScorePart } from './types';

export interface AdultWeights {
  links: number;
  bridge: number;
  stale: number;
  layerCore: number;
  layerDeep: number;
  layerCounterpoint: number;
  newIdea: number;
  toBuy: number;
  share: number;
  age: number;
  /** `age` applies when the candidate has waited more than this many days. */
  ageAfterDays: number;
  staleCapMonths: number;
  sinkPerMonth: number;
  sinkAfterMonths: number;
  sinkFloor: number;
  pricePenalty: number;
  /** In the household's currency: above this, `pricePenalty` applies. */
  priceHigh: number;
  /** In the household's currency: above this, the candidate is excluded (a per-person setting). */
  priceMax: number;
  /** In the household's currency: the price assumed when it is unknown (ADR 0008; the household's own, Settings). */
  priceUnknown: number;
}

export const DEFAULT_ADULT_WEIGHTS: AdultWeights = {
  links: 15, bridge: 8, stale: 2,
  layerCore: 12, layerDeep: 10, layerCounterpoint: 14,
  newIdea: 15, toBuy: 5, share: 5,
  age: 6, ageAfterDays: 90, staleCapMonths: 4,
  sinkPerMonth: 4, sinkAfterMonths: 3, sinkFloor: -20,
  pricePenalty: 8, priceHigh: 40, priceMax: 60, priceUnknown: 25,
};

export interface AdultCandidateFacts {
  /** Read books of the person that the candidate builds on (confirmed, or one of the seed's guesses at ≥ 0.8; never an AI proposal on its own: spec §6). */
  links: number;
  /** Distinct ideas of the person touched by those links, minus one (never below 0). */
  bridge: number;
  /** The empty layer of the candidate's main idea that it fills, or null. */
  fillsLayer: Layer | null;
  /** The person has read the intro and core layers of that idea (a counterpoint counts only then). */
  introAndCoreRead: boolean;
  /** Months since the person last finished a book in the candidate's main idea. */
  staleMonths: number;
  /** The candidate starts an idea the person has no read books in. */
  newIdea: boolean;
  toBuy: boolean;
  fromShare: boolean;
  waitingDays: number;
  untouchedMonths: number;
  /** Centimes; null = unknown. */
  priceC: number | null;
  /** Both ideas of the bridge have at least two read books (needed for Connect). Unknown = true. */
  ideasDense?: boolean;
  isFiction?: boolean;
}

export interface AdultScore {
  excluded: boolean;
  score: number | null;
  move: Move | null;
  parts: ScorePart[];
}

export function layerFillPoints(f: Pick<AdultCandidateFacts, 'fillsLayer' | 'introAndCoreRead'>, w: AdultWeights = DEFAULT_ADULT_WEIGHTS): number {
  switch (f.fillsLayer) {
    case 'core': return w.layerCore;
    case 'deep': return w.layerDeep;
    case 'counterpoint': return f.introAndCoreRead ? w.layerCounterpoint : 0;
    default: return 0;
  }
}

export function sinkPoints(untouchedMonths: number, w: AdultWeights = DEFAULT_ADULT_WEIGHTS): number {
  const over = Math.max(0, untouchedMonths - w.sinkAfterMonths);
  return over === 0 ? 0 : Math.max(w.sinkFloor, -w.sinkPerMonth * over);
}

/**
 * The move a candidate makes. docs/spec.md §6 lists the conditions without an order; this order is the one that
 * reproduces contracts/scoring-vectors.json: fiction, wildcard, broaden, counterpoint, deepen, connect, else intro.
 */
export function adultMove(f: AdultCandidateFacts, layerFill: number): Move {
  if (f.isFiction) return 'fiction';
  if (f.newIdea && f.links === 0) return 'wildcard';
  if (f.newIdea) return 'broaden';
  if (layerFill > 0 && f.fillsLayer === 'counterpoint') return 'counterpoint';
  if (layerFill > 0) return 'deepen';
  if (f.bridge >= 1 && (f.ideasDense ?? true)) return 'connect';
  return 'intro';
}

export function scoreAdult(f: AdultCandidateFacts, w: AdultWeights = DEFAULT_ADULT_WEIGHTS): AdultScore {
  const price = f.priceC == null ? w.priceUnknown : f.priceC / 100;
  if (price > w.priceMax) return { excluded: true, score: null, move: null, parts: [{ label: `Over the price limit (${w.priceMax})`, value: 0, kind: 'excluded' }] };

  const layerFill = layerFillPoints(f, w);
  const bridge = Math.max(0, f.bridge);
  const parts: ScorePart[] = [
    { label: 'Builds on books read', value: w.links * f.links, kind: 'links' },
    { label: 'Bridges ideas', value: w.bridge * bridge, kind: 'bridge' },
    { label: 'Fills a layer', value: layerFill, kind: 'layerFill' },
    { label: 'Idea not fed lately', value: w.stale * Math.min(Math.max(0, f.staleMonths), w.staleCapMonths), kind: 'stale' },
    { label: 'New idea', value: f.newIdea ? w.newIdea : 0, kind: 'newIdea' },
    { label: 'On the To buy list', value: f.toBuy ? w.toBuy : 0, kind: 'source' },
    { label: 'From a share', value: f.fromShare ? w.share : 0, kind: 'source' },
    { label: 'Waiting long', value: f.waitingDays > w.ageAfterDays ? w.age : 0, kind: 'age' },
    { label: 'Untouched', value: sinkPoints(f.untouchedMonths, w), kind: 'sink' },
    { label: 'Price', value: price > w.priceHigh ? -w.pricePenalty : 0, kind: 'price' },
  ];
  const score = parts.reduce((s, p) => s + p.value, 0);
  return { excluded: false, score, move: adultMove(f, layerFill), parts: parts.filter((p) => p.value !== 0) };
}
