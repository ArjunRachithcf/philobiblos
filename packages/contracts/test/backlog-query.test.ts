import { describe, expect, it } from 'vitest';
import { parseQuery, tokenize, withQualifier, DEFAULT_SORT } from '../src/backlog-query';

const terms = (q: string) => parseQuery(q).terms;

// One block per row of the table in contracts/backlog-query.md, each with the row's example.
describe('rows of contracts/backlog-query.md', () => {
  it('is: open (default), closed, adult, kids, fiction', () => {
    expect(parseQuery('').state).toBe('open');
    expect(parseQuery('is:closed').state).toBe('closed');
    expect(parseQuery('is:closed').terms).toEqual([{ key: 'is', value: 'closed', negated: false }]);
    for (const v of ['open', 'closed', 'adult', 'kids', 'fiction']) {
      expect(terms(`is:${v}`)).toEqual([{ key: 'is', value: v, negated: false }]);
    }
    expect(parseQuery('is:closed is:open').state).toBe('open'); // last wins
    expect(parseQuery('is:nope').errors).toHaveLength(1);
  });

  it('for: a handle or me', () => {
    expect(terms('for:me')).toEqual([{ key: 'for', value: 'me', negated: false }]);
    for (const h of ['alex', 'partner', 'kid1']) expect(terms(`for:${h}`)).toEqual([{ key: 'for', value: h, negated: false }]);
    expect(terms('for:Alex')).toEqual([{ key: 'for', value: 'alex', negated: false }]);
  });

  it('move: the seven moves', () => {
    expect(terms('move:connect')).toEqual([{ key: 'move', value: 'connect', negated: false }]);
    for (const v of ['deepen', 'connect', 'broaden', 'counterpoint', 'wildcard', 'intro', 'fiction']) {
      expect(terms(`move:${v}`)).toEqual([{ key: 'move', value: v, negated: false }]);
    }
    expect(parseQuery('move:sideways').errors).toHaveLength(1);
  });

  it('idea: a quoted substring', () => {
    expect(terms('idea:"markets and value"')).toEqual([{ key: 'idea', value: 'markets and value', negated: false }]);
    expect(terms('idea:Bread')).toEqual([{ key: 'idea', value: 'bread', negated: false }]);
  });

  it('layer: intro, core, deep, counterpoint', () => {
    expect(terms('layer:core')).toEqual([{ key: 'layer', value: 'core', negated: false }]);
    for (const v of ['intro', 'core', 'deep', 'counterpoint']) expect(terms(`layer:${v}`)[0]).toMatchObject({ value: v });
    expect(parseQuery('layer:surface').errors).toHaveLength(1);
  });

  it('theme: a substring', () => {
    expect(terms('theme:friendship')).toEqual([{ key: 'theme', value: 'friendship', negated: false }]);
    expect(terms('theme:"loss & healing"')).toEqual([{ key: 'theme', value: 'loss & healing', negated: false }]);
  });

  it('source: instagram, wishlist, to-buy, ai, manual', () => {
    expect(terms('source:instagram')).toEqual([{ key: 'source', value: 'instagram', negated: false }]);
    for (const v of ['instagram', 'wishlist', 'to-buy', 'ai', 'manual']) expect(terms(`source:${v}`)[0]).toMatchObject({ value: v });
    expect(parseQuery('source:tiktok').errors).toHaveLength(1);
  });

  it('by: who added it', () => {
    expect(terms('by:partner')).toEqual([{ key: 'by', value: 'partner', negated: false }]);
  });

  it('author: a substring', () => {
    expect(terms('author:okafor')).toEqual([{ key: 'author', value: 'okafor', negated: false }]);
  });

  it('score: price: links: numbers with <, <=, >, >= or exact', () => {
    expect(terms('score:>50 price:<25')).toEqual([
      { key: 'score', cmp: '>', value: 50, negated: false },
      { key: 'price', cmp: '<', value: 25, negated: false },
    ]);
    expect(terms('links:>=2')).toEqual([{ key: 'links', cmp: '>=', value: 2, negated: false }]);
    expect(terms('price:<=19.9')).toEqual([{ key: 'price', cmp: '<=', value: 19.9, negated: false }]);
    expect(terms('links:3')).toEqual([{ key: 'links', cmp: '=', value: 3, negated: false }]);
    expect(parseQuery('score:high').errors).toHaveLength(1);
  });

  it('added: an age in days', () => {
    expect(terms('added:>90d')).toEqual([{ key: 'added', cmp: '>', days: 90, negated: false }]);
    expect(terms('added:<30d')).toEqual([{ key: 'added', cmp: '<', days: 30, negated: false }]);
    expect(parseQuery('added:>3w').errors).toHaveLength(1);
  });

  it('reason: closed reasons', () => {
    expect(terms('is:closed reason:repeats')).toEqual([
      { key: 'is', value: 'closed', negated: false },
      { key: 'reason', value: 'repeats', negated: false },
    ]);
    for (const v of ['not-for-me', 'snoozed', 'owned', 'repeats', 'picked']) expect(terms(`reason:${v}`)[0]).toMatchObject({ value: v });
    expect(parseQuery('reason:lost').errors).toHaveLength(1);
  });

  it('sort: score (default), links, price, added, title, with -asc/-desc', () => {
    expect(parseQuery('').sort).toEqual(DEFAULT_SORT);
    expect(parseQuery('sort:price-asc').sort).toEqual({ field: 'price', dir: 'asc' });
    expect(parseQuery('sort:score').sort).toEqual({ field: 'score', dir: 'desc' });
    expect(parseQuery('sort:title-desc').sort).toEqual({ field: 'title', dir: 'desc' });
    for (const f of ['score', 'links', 'price', 'added', 'title']) expect(parseQuery(`sort:${f}`).sort.field).toBe(f);
    expect(parseQuery('sort:price').terms).toEqual([]);
    expect(parseQuery('sort:pages').errors).toHaveLength(1);
    expect(parseQuery('-sort:score').errors).toHaveLength(1);
  });
});

describe('the examples and saved filters in the contract', () => {
  it('the bar example', () => {
    const p = parseQuery('is:open is:adult move:deepen price:<30 sort:score');
    expect(p.errors).toEqual([]);
    expect(p.state).toBe('open');
    expect(p.sort).toEqual({ field: 'score', dir: 'desc' });
    expect(p.terms.map((t) => t.key)).toEqual(['is', 'is', 'move', 'price']);
  });
  it.each([
    ['To buy now', 'is:open is:adult score:>40'],
    ['Kids', 'is:open is:kids'],
    ['Cheap & good', 'is:open score:>30 price:<25'],
    ['From Instagram', 'is:open source:instagram sort:added'],
  ])('%s parses without errors', (_name, q) => {
    expect(parseQuery(q).errors).toEqual([]);
  });
});

describe('quoting', () => {
  it('a quoted phrase is one free-text term', () => {
    expect(terms('"the long tide of markets"')).toEqual([{ key: 'text', value: 'the long tide of markets', negated: false }]);
  });
  it('a quoted qualifier is text, not a qualifier', () => {
    expect(terms('"is:closed"')).toEqual([{ key: 'text', value: 'is:closed', negated: false }]);
    expect(parseQuery('"is:closed"').state).toBe('open');
  });
  it('quotes in the middle of a token join the words', () => {
    expect(terms('author:"mira okafor" ledger')).toEqual([
      { key: 'author', value: 'mira okafor', negated: false },
      { key: 'text', value: 'ledger', negated: false },
    ]);
  });
  it('free words match title and author', () => {
    expect(terms('Tide Okafor')).toEqual([
      { key: 'text', value: 'tide', negated: false },
      { key: 'text', value: 'okafor', negated: false },
    ]);
  });
});

describe('negation', () => {
  it('a leading - negates a qualifier', () => {
    expect(terms('-move:wildcard')).toEqual([{ key: 'move', value: 'wildcard', negated: true }]);
    expect(terms('-idea:"markets and value"')).toEqual([{ key: 'idea', value: 'markets and value', negated: true }]);
  });
  it('negated free words', () => {
    expect(terms('-bread')).toEqual([{ key: 'text', value: 'bread', negated: true }]);
  });
  it('-is:open means the closed tab, -is:closed the open one', () => {
    expect(parseQuery('-is:open').state).toBe('closed');
    expect(parseQuery('-is:closed').state).toBe('open');
  });
  it('a lone - is ignored', () => {
    expect(parseQuery('- ledger')).toEqual({ terms: [{ key: 'text', value: 'ledger', negated: false }], state: 'open', sort: DEFAULT_SORT, errors: [] });
  });
});

describe('error recovery', () => {
  it('unknown qualifiers are reported and ignored, the rest still applies', () => {
    const p = parseQuery('colour:red is:kids pages:<100 ledger');
    expect(p.errors).toEqual(['unknown qualifier "colour:"', 'unknown qualifier "pages:"']);
    expect(p.terms).toEqual([
      { key: 'is', value: 'kids', negated: false },
      { key: 'text', value: 'ledger', negated: false },
    ]);
  });
  it('a missing value is reported', () => {
    expect(parseQuery('is: ledger').errors).toEqual(['missing value for "is:"']);
  });
  it('an unclosed quote runs to the end and is reported', () => {
    const p = parseQuery('idea:"markets and value');
    expect(p.terms).toEqual([{ key: 'idea', value: 'markets and value', negated: false }]);
    expect(p.errors).toHaveLength(1);
  });
  it('never throws on odd input', () => {
    for (const q of ['::', '-', '"', '""', ' :x', '-:', 'is:"', 'sort:-asc', '\t\n', 'a:b:c']) {
      expect(() => parseQuery(q)).not.toThrow();
    }
  });
  it('keys are case-insensitive', () => {
    expect(terms('IS:Closed')).toEqual([{ key: 'is', value: 'closed', negated: false }]);
  });
});

describe('clicking a label (withQualifier)', () => {
  it('appends the qualifier', () => {
    expect(withQualifier('is:open', 'move', 'deepen')).toBe('is:open move:deepen');
  });
  it('replaces an existing one of the same key', () => {
    expect(withQualifier('is:open move:connect ledger', 'move', 'deepen')).toBe('is:open ledger move:deepen');
    expect(withQualifier('-move:connect', 'move', 'deepen')).toBe('move:deepen');
  });
  it('quotes values with spaces', () => {
    expect(withQualifier('', 'idea', 'markets and value')).toBe('idea:"markets and value"');
    expect(parseQuery(withQualifier('', 'idea', 'markets and value')).terms[0]).toMatchObject({ value: 'markets and value' });
  });
  it('is: replaces only within its group (open/closed, adult/kids)', () => {
    expect(withQualifier('is:open is:adult', 'is', 'kids')).toBe('is:open is:kids');
    expect(withQualifier('is:open is:adult', 'is', 'closed')).toBe('is:adult is:closed');
  });
  it('tokenize keeps the raw text of each term', () => {
    expect(tokenize('a  -idea:"x y"').map((t) => t.raw)).toEqual(['a', '-idea:"x y"']);
  });
});
