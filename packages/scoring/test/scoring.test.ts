import { describe, expect, it } from 'vitest';
import { adultPickCount, derivedPriceLimits, householdWeights, pickAdults, pickKids, scoreAdult, scoreKid, sinkPoints, type AdultCandidateFacts, type KidCandidateFacts } from '../src';

const base: AdultCandidateFacts = {
  links: 0, bridge: 0, fillsLayer: null, introAndCoreRead: false, staleMonths: 0, newIdea: false,
  toBuy: false, fromShare: false, waitingDays: 0, untouchedMonths: 0, priceC: 2000,
};

describe('adult score rules', () => {
  it('counterpoint fills only when intro and core are read', () => {
    expect(scoreAdult({ ...base, links: 1, fillsLayer: 'counterpoint' })).toMatchObject({ score: 15, move: 'intro' });
    expect(scoreAdult({ ...base, links: 1, fillsLayer: 'counterpoint', introAndCoreRead: true })).toMatchObject({ score: 29, move: 'counterpoint' });
  });
  it('the sink floors at -20', () => {
    expect(sinkPoints(3)).toBe(0);
    expect(sinkPoints(4)).toBe(-4);
    expect(sinkPoints(30)).toBe(-20);
  });
  it('stale is capped at 4 months', () => {
    expect(scoreAdult({ ...base, staleMonths: 9 }).score).toBe(8);
  });
  it('by default an unknown price counts as 25; over 60 is excluded; over 40 costs 8 (hundredths of any currency)', () => {
    expect(scoreAdult({ ...base, priceC: null }).excluded).toBe(false);
    expect(scoreAdult({ ...base, priceC: 6001 })).toMatchObject({ excluded: true, score: null, move: null });
    expect(scoreAdult({ ...base, priceC: 6000 }).score).toBe(-8);
    expect(scoreAdult({ ...base, priceC: 4000 }).score).toBe(0);
  });
  it('connect needs dense ideas', () => {
    expect(scoreAdult({ ...base, links: 2, bridge: 1, ideasDense: false }).move).toBe('intro');
    expect(scoreAdult({ ...base, links: 2, bridge: 1, ideasDense: true }).move).toBe('connect');
  });
  it('a negative bridge counts as 0', () => {
    expect(scoreAdult({ ...base, bridge: -1 }).score).toBe(0);
  });
});

describe('price limits in the household\'s currency (philobiblos#40)', () => {
  const kid: KidCandidateFacts = { themeBooks: 1, themeBooksWeighted: 1, authorOnShelf: false, lovedAuthor: false, toBuy: false, fromShare: false, waitingDays: 0, priceC: 2000 };
  const price = (r: { parts: { kind: string; value: number }[] }) => r.parts.find((p) => p.kind === 'price')?.value ?? 0;

  it('without limits of its own, a household\'s follow its unknown price: dear above 1.6 times it, left out above 2.4 times', () => {
    expect(derivedPriceLimits(2500)).toEqual({ highC: 4000, maxC: 6000 });
    expect(derivedPriceLimits(250000)).toEqual({ highC: 400000, maxC: 600000 });
    expect(derivedPriceLimits(3)).toEqual({ highC: 5, maxC: 7 }); // whole hundredths
    const w = householdWeights({ unknownPriceC: 250000, priceLimits: null });
    expect(scoreAdult({ ...base, priceC: 600001 }, w.adult).excluded).toBe(true);
    expect(scoreAdult({ ...base, priceC: 600000 }, w.adult).score).toBe(-8);
    expect(scoreAdult({ ...base, priceC: 400000 }, w.adult).score).toBe(0);
    expect(scoreAdult({ ...base, priceC: 400001 }, w.adult).score).toBe(-8);
  });

  it('a household\'s own limits replace them, whatever its unknown price', () => {
    const w = householdWeights({ unknownPriceC: 2500, priceLimits: { highC: 1000, maxC: 2000 } });
    expect(scoreAdult({ ...base, priceC: 1001 }, w.adult).score).toBe(-8);
    expect(scoreAdult({ ...base, priceC: 2001 }, w.adult).excluded).toBe(true);
    expect(scoreAdult({ ...base, priceC: null }, w.adult).excluded).toBe(true); // unknown = 25, over its own 20
  });

  it('an unknown price is the household\'s, for adults and kids', () => {
    const w = householdWeights({ unknownPriceC: 7000, priceLimits: { highC: 4000, maxC: 6000 } });
    expect(scoreAdult({ ...base, priceC: null }, w.adult).excluded).toBe(true);
    expect(price(scoreKid({ ...kid, priceC: null }, undefined, w.kid))).toBeCloseTo(-21); // 12 points at 40, 70 unknown
  });

  it('a kid\'s book costs 12 points at the household\'s "dear" limit, in proportion below and above it', () => {
    const w = householdWeights({ unknownPriceC: 2500, priceLimits: null });
    expect(price(scoreKid({ ...kid, priceC: 4000 }, undefined, w.kid))).toBeCloseTo(-12);
    expect(price(scoreKid({ ...kid, priceC: 2000 }, undefined, w.kid))).toBeCloseTo(-6);
    expect(price(scoreKid({ ...kid, priceC: 2000 }))).toBeCloseTo(-6); // the defaults are that household
    const own = householdWeights({ unknownPriceC: 2500, priceLimits: { highC: 8000, maxC: 9000 } });
    expect(price(scoreKid({ ...kid, priceC: 2000 }, undefined, own.kid))).toBeCloseTo(-3);
  });

  it('an unknown price of 0 (free unless known) sets no limits that follow it: nothing is left out or dear for its price', () => {
    const w = householdWeights({ unknownPriceC: 0, priceLimits: null });
    expect(derivedPriceLimits(0)).toEqual({ highC: null, maxC: null });
    expect(scoreAdult({ ...base, priceC: 10_000_000 }, w.adult)).toMatchObject({ excluded: false, score: 0 });
    expect(price(scoreKid({ ...kid, priceC: 10_000_000 }, undefined, w.kid))).toBe(0);
  });

  it('every household ranks the same when every amount is scaled together', () => {
    const facts = [2490, 1990, 5290, 18900, 4000, 4010, null];
    const rank = (factor: number) => {
      const w = householdWeights({ unknownPriceC: 2500 * factor, priceLimits: null });
      const adults = facts.map((p) => scoreAdult({ ...base, links: 2, priceC: p == null ? null : p * factor }, w.adult));
      const kids = facts.map((p) => scoreKid({ ...kid, priceC: p == null ? null : p * factor }, undefined, w.kid).score);
      return { adults: adults.map((a) => [a.excluded, a.score]), kids: kids.map((s) => Math.round(s * 1e6) / 1e6) };
    };
    expect(rank(100)).toEqual(rank(1));
    expect(rank(10000)).toEqual(rank(1));
  });
});

describe('adult picks', () => {
  const pool = [
    { id: 'd1', score: 80, move: 'deepen' as const, excluded: false },
    { id: 'd2', score: 70, move: 'deepen' as const, excluded: false },
    { id: 'c1', score: 40, move: 'connect' as const, excluded: false },
    { id: 'b1', score: 60, move: 'broaden' as const, excluded: false },
    { id: 'f1', score: 99, move: 'fiction' as const, excluded: false, isFiction: true },
    { id: 'o1', score: 98, move: 'deepen' as const, excluded: false, owned: true },
    { id: 'r1', score: 97, move: 'connect' as const, excluded: false, redundant: true },
  ];
  it('deepen + connect by default, broaden every third month', () => {
    expect(pickAdults(pool, { count: 2, mix: 'deepen_connect' })).toEqual(['d1', 'c1']);
    expect(pickAdults(pool, { count: 2, mix: 'deepen_connect', broadenMonth: true })).toEqual(['d1', 'b1']);
    expect(pickAdults(pool, { count: 2, mix: 'deepen_broaden' })).toEqual(['d1', 'b1']);
  });
  it('a missing move falls back to the best of another move', () => {
    expect(pickAdults(pool.filter((p) => p.move !== 'connect'), { count: 2, mix: 'deepen_connect' })).toEqual(['d1', 'b1']);
  });
  it('fiction only when allowed', () => {
    expect(pickAdults(pool, { count: 1, mix: 'ai', allowFiction: true })).toEqual(['f1']);
    expect(pickAdults(pool, { count: 1, mix: 'ai' })).toEqual(['d1']);
  });
  it('the unread pile limits the count', () => {
    expect(adultPickCount(5, 6)).toBe(2);
    expect(adultPickCount(7, 6)).toBe(1);
    expect(adultPickCount(13, 6)).toBe(0);
    expect(pickAdults(pool, { count: 0, mix: 'deepen_connect' })).toEqual([]);
  });
});

describe('kids picks', () => {
  const k = (id: string, kidId: string, score: number, theme: string, author: string, priceC: number, extra = {}) =>
    ({ id, kidId, score, theme, author, priceC, ...extra });
  it('greedy, one per theme and author, kids taking turns, within max', () => {
    const pool = [
      k('a1', 'A', 40, 'Friendship', 'x', 2500), k('a2', 'A', 35, 'Friendship', 'y', 2000), k('a3', 'A', 30, 'Gender', 'z', 2000),
      k('b1', 'B', 38, 'Courage', 'x', 2000), k('b2', 'B', 20, 'Mindfulness', 'w', 2000),
    ];
    const r = pickKids(pool, { kids: ['A', 'B'], totalC: 5000, minC: 10000, maxC: 15000, skipShelfAuthors: true });
    expect(r.ids).toEqual(['a1', 'b2', 'a3']);
    expect(r.totalC).toBe(11500);
  });
  it('tops up to min without the theme limit', () => {
    const pool = [k('a1', 'A', 40, 'Friendship', 'x', 2500), k('a2', 'A', 35, 'Friendship', 'y', 2000)];
    const r = pickKids(pool, { kids: ['A'], totalC: 6000, minC: 10000, maxC: 15000, skipShelfAuthors: false });
    expect(r.ids).toEqual(['a1', 'a2']);
  });
  it('the same picks in a household whose amounts are 10,000 times larger', () => {
    const pool = (f: number) => [
      k('a1', 'A', 40, 'Friendship', 'x', 2500 * f), k('a2', 'A', 35, 'Friendship', 'y', 2000 * f), k('a3', 'A', 30, 'Gender', 'z', 2000 * f),
      k('b1', 'B', 38, 'Courage', 'x', 2000 * f), k('b2', 'B', 20, 'Mindfulness', 'w', 2000 * f),
    ];
    const r = pickKids(pool(10000), { kids: ['A', 'B'], totalC: 5000 * 10000, minC: 10000 * 10000, maxC: 15000 * 10000, skipShelfAuthors: true });
    expect(r).toEqual({ ids: ['a1', 'b2', 'a3'], totalC: 11500 * 10000 });
  });
  it('skips authors on the shelf when the setting is on', () => {
    const pool = [k('a1', 'A', 40, 'Friendship', 'x', 2500, { authorOnShelf: true })];
    expect(pickKids(pool, { kids: ['A'], totalC: 0, minC: 0, maxC: 15000, skipShelfAuthors: true }).ids).toEqual([]);
    expect(pickKids(pool, { kids: ['A'], totalC: 0, minC: 0, maxC: 15000, skipShelfAuthors: false }).ids).toEqual(['a1']);
  });
});
