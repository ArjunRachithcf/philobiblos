// contracts/scoring-vectors.json: produced by the prototype's scoring; packages/scoring must reproduce every vector.
// The same vectors with the household's real titles live in the private seed/ and run here when it is present.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import publicVectors from '../../../contracts/scoring-vectors.json' with { type: 'json' };
import { DEFAULT_ADULT_WEIGHTS, householdWeights, layerFillPoints, pickAdults, scoreAdult, scoreKid, type AdultCandidateFacts, type Layer } from '../src';

type Vectors = typeof publicVectors;
type AdultVector = Vectors['adult'][number];
type Household = Vectors['households']['cases'][number];

const layerOf: Record<number, Layer | null> = { 0: null, 12: 'core', 10: 'deep', 14: 'counterpoint' };

/** An amount of the vectors' household in hundredths of another's: times its factor, rounded to its decimals. */
const inHousehold = (h: Household) => (amount: number) => {
  const unit = 10 ** (2 - h.fractionDigits);
  return Math.round((amount * h.factor * 100) / unit) * unit;
};

/**
 * Throws unless `amount`, in the vectors' household, is whole in `h` before any rounding: a case whose factor makes a
 * vector's price a fraction its currency cannot write would test rounding, not the scores (philobiblos#62).
 */
function assertWhole(amount: number, h: Pick<Household, 'name' | 'factor' | 'fractionDigits'>): void {
  const units = (amount * h.factor * 100) / 10 ** (2 - h.fractionDigits);
  if (Math.abs(units - Math.round(units)) > 1e-6) throw new Error(`${amount} is not whole in ${h.name}`);
}

function adultFacts(v: AdultVector, toC: (amount: number) => number): AdultCandidateFacts {
  const fillsLayer = layerOf[v.layerFill];
  if (fillsLayer === undefined) throw new Error(`no layer gives layerFill ${v.layerFill}`);
  return {
    links: v.links, bridge: v.bridge, fillsLayer, introAndCoreRead: fillsLayer === 'counterpoint',
    staleMonths: v.staleMonths, newIdea: v.newIdea, toBuy: v.toBuy, fromShare: v.share,
    waitingDays: v.waitingDays, untouchedMonths: v.untouchedMonths, priceC: toC(v.price),
  };
}

function suite(vectors: Vectors, h: Household) {
  const toC = inHousehold(h);
  // The household's own money: its unknown price, and the price limits that follow it (none of its own in the vectors).
  const w = householdWeights({ unknownPriceC: toC(vectors.household.unknownPrice), priceLimits: null });
  for (const amount of [vectors.household.unknownPrice, vectors.basket.budget.min, vectors.basket.budget.max, ...[...vectors.adult, ...vectors.kids].map((v) => v.price)]) assertWhole(amount, h);
  it('the default weights are the vectors\' weights', () => {
    for (const [k, w] of Object.entries(vectors.weights)) expect(DEFAULT_ADULT_WEIGHTS[k as keyof typeof DEFAULT_ADULT_WEIGHTS]).toBe(w);
  });
  it.each(vectors.adult.map((v) => [v.name, v] as const))('adult: %s', (_name, v) => {
    const f = adultFacts(v, toC);
    expect(layerFillPoints(f)).toBe(v.layerFill);
    const r = scoreAdult(f, w.adult);
    expect(r.excluded).toBe(v.excluded);
    expect(r.score).toBe(v.expectScore);
    expect(r.move).toBe(v.expectMove);
    if (!r.excluded) expect(r.parts.reduce((s, p) => s + p.value, 0)).toBe(v.expectScore);
  });
  it.each(vectors.kids.map((v) => [v.name, v] as const))('kids: %s', (_name, v) => {
    const r = scoreKid({
      themeBooks: v.themeBooks, themeBooksWeighted: v.themeBooksWeighted, authorOnShelf: v.authorOnShelf,
      lovedAuthor: v.lovedAuthor, toBuy: v.toBuy, fromShare: v.share, waitingDays: v.waitingDays, priceC: toC(v.price),
    }, undefined, w.kid);
    expect(r.score).toBeCloseTo(v.expectScore, 2);
  });
  it(`basket: ${vectors.basket.rule}`, () => {
    const pool = vectors.adult.map((v) => ({ id: v.name, ...scoreAdult(adultFacts(v, toC), w.adult) }));
    expect(pickAdults(pool, { count: 2, mix: 'deepen_connect' })).toEqual(vectors.basket.expectAdult);
  });
}

describe('the households\' guard can fail', () => {
  it('a price that is a fraction of a unit in the household\'s currency is refused, not rounded away', () => {
    expect(() => assertWhole(16.9, { name: 'no decimals at factor 1', factor: 1, fractionDigits: 0 })).toThrow(/16\.9 is not whole/);
    expect(() => assertWhole(16.9, { name: 'a tenth', factor: 0.1, fractionDigits: 1 })).toThrow(/not whole/);
    expect(() => assertWhole(16.9, { name: 'the vectors\' own', factor: 1, fractionDigits: 2 })).not.toThrow();
    expect(() => assertWhole(16.9, { name: 'a low-nominal one', factor: 0.1, fractionDigits: 2 })).not.toThrow();
  });
});

describe.each(publicVectors.households.cases.map((h) => [h.name, h] as const))('contracts/scoring-vectors.json in %s', (_name, h) => suite(publicVectors, h));

const privateFile = new URL('../../../seed/scoring-vectors.json', import.meta.url);
describe.skipIf(!existsSync(privateFile))('seed/scoring-vectors.json (private, local only)', () =>
  suite(existsSync(privateFile) ? ({ ...publicVectors, ...(JSON.parse(readFileSync(privateFile, 'utf8')) as Vectors) }) : publicVectors, publicVectors.households.cases[0]!));
