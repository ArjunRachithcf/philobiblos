import { describe, expect, it } from 'vitest';
import { adultPickCount, pickAdults, pickKids, scoreAdult, sinkPoints, type AdultCandidateFacts } from '../src';

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
  it('an unknown price counts as CHF 25; over CHF 60 is excluded; over CHF 40 costs 8', () => {
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
  it('skips authors on the shelf when the setting is on', () => {
    const pool = [k('a1', 'A', 40, 'Friendship', 'x', 2500, { authorOnShelf: true })];
    expect(pickKids(pool, { kids: ['A'], totalC: 0, minC: 0, maxC: 15000, skipShelfAuthors: true }).ids).toEqual([]);
    expect(pickKids(pool, { kids: ['A'], totalC: 0, minC: 0, maxC: 15000, skipShelfAuthors: false }).ids).toEqual(['a1']);
  });
});
