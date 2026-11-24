// The household's money (philobiblos#27, slice 2): its own currency and its own unknown price, never a constant of the
// core. PHILOBIBLOS_CURRENCY is only the currency a household starts with; an admin sets it in Settings after. A connector
// counts only in the household's currency: enabling one in another is refused, one enabled in another counts for
// nothing, and the household's currency does not change under an enabled connector. Each guard has a test that fails
// when the guard is removed. Every name and amount here is invented.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { allCandidates } from '../src/backlog/backlog';
import { loadConfig } from '../src/config';
import { ConnectorError, connectorView, enabledConnectors, setConnector } from '../src/connectors/enabled';
import { readConnector } from '../src/connectors/load';
import { openDb, type Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { AMOUNT_CEILING_C } from '@philobiblos/contracts/money';
import { getMonth } from '../src/month/plan';
import { DEFAULT_UNKNOWN_PRICE_C } from '../src/household/money';
import { ORIGIN, TEST_SEALING_KEY, household, sessionCookie } from './helpers';
import { CONNECTORS } from './mailkit';

const env = (more: Record<string, string> = {}) => loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY, PHILOBIBLOS_EGRESS: 'off', ...more });
const start = (db: Db, more: Record<string, string> = {}) => buildApp(env(more), db, { connectors: CONNECTORS, jobs: { schedule: { start: false } } });
const VERSION = CONNECTORS.get('quillmere')!.version;
/** The price limits of a household that sets none: they follow its unknown price of 25 (packages/scoring price.ts). */
const FOLLOWING = { high: 4000, max: 6000, own: false };

function admins(): Db {
  const db = openDb(':memory:');
  db.insert(t.person).values([
    { id: 'p_admin', name: 'Admin', role: 'admin', handle: 'admin' },
    { id: 'p_adult', name: 'Adult', role: 'adult', handle: 'adult' },
  ]).run();
  return db;
}

async function client(db: Db, more: Record<string, string> = {}) {
  const built = await start(db, more);
  const as = (who: string) => ({ cookie: sessionCookie(db, who), origin: ORIGIN });
  return {
    built,
    get: async (who: string, url: string) => built.app.inject({ url, headers: as(who) }),
    patch: async (who: string, payload: unknown) => built.app.inject({ method: 'PATCH', url: '/api/settings', headers: { ...as(who), 'content-type': 'application/json' }, payload: JSON.stringify(payload) }),
    put: async (who: string, id: string, payload: unknown) => built.app.inject({ method: 'PUT', url: `/api/connectors/${id}`, headers: { ...as(who), 'content-type': 'application/json' }, payload: JSON.stringify(payload) }),
  };
}

describe('the household\'s currency', () => {
  it('PHILOBIBLOS_CURRENCY is the currency the household starts with; once its settings exist it is never read again', async () => {
    const db = admins();
    const a = await client(db, { PHILOBIBLOS_CURRENCY: 'EUR' });
    expect((await a.get('p_admin', '/api/settings')).json().money).toEqual({ currency: 'EUR', unknownPrice: DEFAULT_UNKNOWN_PRICE_C, priceLimits: FOLLOWING });
    await a.built.app.close();
    const b = await client(db, { PHILOBIBLOS_CURRENCY: 'GBP' });
    expect((await b.get('p_admin', '/api/settings')).json().money.currency).toBe('EUR');
    // Everyone signed in sees it (the screens write amounts in it), from /me.
    expect((await b.get('p_adult', '/api/me')).json().money).toEqual({ currency: 'EUR', unknownPrice: DEFAULT_UNKNOWN_PRICE_C, priceLimits: FOLLOWING });
    await b.built.app.close();
  });

  it('unset, the household has no currency until it is chosen: none is assumed; set at a later start, it fills that in', async () => {
    const db = admins();
    const a = await client(db);
    expect((await a.get('p_admin', '/api/settings')).json().money).toEqual({ currency: null, unknownPrice: DEFAULT_UNKNOWN_PRICE_C, priceLimits: FOLLOWING });
    expect((await a.get('p_adult', '/api/me')).json().money.currency).toBeNull();
    await a.built.app.close();
    // An enabling made while there was no currency (by hand: the server refuses it) does not survive the filling in.
    db.insert(t.connectorEnabled).values({ id: 'quillmere', version: VERSION, enabledAt: new Date().toISOString() }).run();
    const b = await client(db, { PHILOBIBLOS_CURRENCY: 'SEK' });
    expect((await b.get('p_admin', '/api/settings')).json().money.currency).toBe('SEK');
    expect(db.select().from(t.connectorEnabled).all()).toEqual([]);
    await b.built.app.close();
    // A start that fills nothing in leaves the enablings alone.
    db.insert(t.connectorEnabled).values({ id: 'quillmere', version: VERSION, enabledAt: new Date().toISOString() }).run();
    await (await client(db, { PHILOBIBLOS_CURRENCY: 'NOK' })).built.app.close();
    expect(db.select().from(t.connectorEnabled).all()).toHaveLength(1);
  });

  it.each(['ZZZ', 'EU', 'EURO', '€', 'E1R', 'XXX'])('PHILOBIBLOS_CURRENCY must be an ISO 4217 code this server knows, not %s', (code) => {
    expect(() => env({ PHILOBIBLOS_CURRENCY: code })).toThrow(/PHILOBIBLOS_CURRENCY/);
  });

  it('PHILOBIBLOS_CURRENCY is read without its case and spaces; empty is unset', () => {
    expect(env({ PHILOBIBLOS_CURRENCY: ' eur ' }).currency).toBe('EUR');
    expect(env({ PHILOBIBLOS_CURRENCY: '' }).currency).toBeNull();
  });

  it('an admin sets it in Settings, a code this server knows; nobody else, and never back to none', async () => {
    const db = admins();
    const a = await client(db);
    expect((await a.patch('p_adult', { money: { currency: 'EUR' } })).statusCode).toBe(403);
    for (const bad of ['ZZZ', 'eur1', 'XXX', '', 12, null, ['EUR']]) {
      const r = await a.patch('p_admin', { money: { currency: bad } });
      expect(r.statusCode, String(bad)).toBe(400);
      expect(r.json().error).toMatch(/money\.currency/);
    }
    expect((await a.patch('p_admin', { money: { rate: 1 } })).statusCode).toBe(400);
    expect((await a.patch('p_admin', { money: 'EUR' })).statusCode).toBe(400);
    expect((await a.get('p_admin', '/api/settings')).json().money.currency).toBeNull();
    expect((await a.patch('p_admin', { money: { currency: 'eur' } })).statusCode).toBe(200);
    expect((await a.get('p_admin', '/api/settings')).json().money.currency).toBe('EUR');
    await a.built.app.close();
  });
});

describe('the unknown price is the household\'s own', () => {
  it('25 in the household\'s currency by default; an admin sets it, whole hundredths from 0 to any amount\'s ceiling', async () => {
    expect(DEFAULT_UNKNOWN_PRICE_C).toBe(2500);
    const db = household();
    const a = await client(db);
    expect((await a.patch('p_sam', { money: { unknownPrice: 4000 } })).statusCode).toBe(403);
    for (const bad of [-1, 1.5, AMOUNT_CEILING_C + 1, '4000', null]) expect((await a.patch('p_alex', { money: { unknownPrice: bad } })).statusCode, String(bad)).toBe(400);
    expect((await a.patch('p_alex', { money: { unknownPrice: 4000 } })).statusCode).toBe(200);
    expect((await a.get('p_alex', '/api/settings')).json().money.unknownPrice).toBe(4000);
    await a.built.app.close();
  });

  it('the month counts an unknown price at the household\'s amount, not a constant', async () => {
    const db = household();
    const a = await client(db);
    expect((await a.patch('p_alex', { money: { unknownPrice: 1234 } })).statusCode).toBe(200);
    const month = (await a.get('p_alex', '/api/month')).json();
    type Pick = { candidate: { price?: number } };
    const picks: Pick[] = [...month.adults, ...month.kids].flatMap((g: { picks: Pick[] }) => g.picks);
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.every((p) => p.candidate.price === undefined)).toBe(true);
    expect(month.total).toBe(picks.length * 1234);
    await a.built.app.close();
  });

  it('the scores read it too: an unknown price above the household\'s own price limit leaves the book out', () => {
    const db = household();
    const tide = () => allCandidates(db, new Date(), 'p_alex').find((r) => r.personId === 'p_alex' && r.book.id === 'b_tide')!;
    expect(tide().score).toBeDefined();
    // Limits that follow the unknown price never leave out a book whose price nobody knows, at any amount.
    db.update(t.householdSettings).set({ unknownPriceC: 7000 }).run();
    expect(tide().score).toBeDefined();
    // The household's own limit of 60: a book whose price nobody knows now counts as too dear.
    db.update(t.householdSettings).set({ priceHighC: 4000, priceMaxC: 6000 }).run();
    expect(tide().score).toBeUndefined();
    expect(tide().scoreParts).toEqual([expect.objectContaining({ kind: 'excluded' })]);
  });
});

describe('the kids\' unknown price is the household\'s too', () => {
  /** household() with a kid's book whose price nobody knows, the unknown price at 10 and a budget of at most 20. */
  function withKidsBook(): Db {
    const db = household();
    db.insert(t.book).values({ id: 'b_fox', title: 'The Quiet Fox', authorsJson: '["Ines Varga"]', audience: 'kids', normKey: 'fox', createdAt: new Date().toISOString() }).run();
    db.insert(t.candidate).values({ personId: 'p_kid1', bookId: 'b_fox', origin: 'wishlist', addedAt: new Date().toISOString(), touchedAt: new Date().toISOString() }).run();
    db.update(t.householdSettings).set({ unknownPriceC: 1000, budgetMinC: 0, budgetMaxC: 2000 }).run();
    return db;
  }

  it('a kid\'s score prices an unknown price at the household\'s amount', () => {
    const db = withKidsBook();
    const fox = allCandidates(db, new Date(), 'p_alex').find((r) => r.book.id === 'b_fox')!;
    // packages/scoring kids: 12 points at the "dear" limit, which follows the unknown price (16 at 10): 10 costs 7.5.
    expect(fox.scoreParts!.find((p) => p.kind === 'price')!.value).toBeCloseTo(-7.5);
    db.update(t.householdSettings).set({ priceHighC: 4000, priceMaxC: 6000 }).run();
    expect(allCandidates(db, new Date(), 'p_alex').find((r) => r.book.id === 'b_fox')!.scoreParts!.find((p) => p.kind === 'price')!.value).toBeCloseTo(-3);
  });

  it('the kids\' basket fits the budget at the household\'s unknown price: at 10 the book fits, at 25 it would not', async () => {
    const db = withKidsBook();
    const a = await client(db);
    const month = (await a.get('p_alex', '/api/month')).json();
    type Pick = { candidate: { book: { id: string } } };
    const adults = month.adults.flatMap((g: { picks: Pick[] }) => g.picks);
    expect(adults).toHaveLength(1); // 10 of the 20 taken by the adult's book
    expect(month.kids.flatMap((g: { picks: Pick[] }) => g.picks).map((p: Pick) => p.candidate.book.id)).toEqual(['b_fox']);
    expect(month.total).toBe(2000);
    await a.built.app.close();
  });
});

describe('price limits in the household\'s currency (philobiblos#40)', () => {
  it('a household that sets none has limits that follow its unknown price; an admin sets its own, or follows again', async () => {
    const db = household();
    const a = await client(db);
    expect((await a.get('p_alex', '/api/settings')).json().money.priceLimits).toEqual(FOLLOWING);
    expect((await a.patch('p_alex', { money: { unknownPrice: 3000 } })).statusCode).toBe(200);
    expect((await a.get('p_alex', '/api/settings')).json().money.priceLimits).toEqual({ high: 4800, max: 7200, own: false });
    expect((await a.patch('p_sam', { money: { priceLimits: { high: 3000, max: 5000 } } })).statusCode).toBe(403);
    expect((await a.patch('p_alex', { money: { priceLimits: { high: 3000, max: 5000 } } })).statusCode).toBe(200);
    expect((await a.get('p_alex', '/api/settings')).json().money.priceLimits).toEqual({ high: 3000, max: 5000, own: true });
    expect((await a.get('p_sam', '/api/me')).json().money.priceLimits).toEqual({ high: 3000, max: 5000, own: true });
    // Its own limits stay when the unknown price changes.
    expect((await a.patch('p_alex', { money: { unknownPrice: 1000 } })).statusCode).toBe(200);
    expect((await a.get('p_alex', '/api/settings')).json().money.priceLimits).toEqual({ high: 3000, max: 5000, own: true });
    expect((await a.patch('p_alex', { money: { priceLimits: null } })).statusCode).toBe(200);
    expect((await a.get('p_alex', '/api/settings')).json().money.priceLimits).toEqual({ high: 1600, max: 2400, own: false });
    // An unknown price of 0 has none that follow it.
    expect((await a.patch('p_alex', { money: { unknownPrice: 0 } })).statusCode).toBe(200);
    expect((await a.get('p_alex', '/api/settings')).json().money.priceLimits).toEqual({ high: null, max: null, own: false });
    await a.built.app.close();
  });

  it('its own limits: whole amounts in its currency, the "dear" one at most the other, both or neither', async () => {
    const db = household();
    const a = await client(db);
    for (const bad of [{ high: 5000 }, { high: 6000, max: 5000 }, { high: -1, max: 5000 }, { high: 1.5, max: 5000 }, { high: 1000, max: AMOUNT_CEILING_C + 1 },
      { high: '1000', max: 5000 }, { high: 1000, max: 5000, ratio: 2 }, [1000, 5000], 'none']) {
      const r = await a.patch('p_alex', { money: { priceLimits: bad } });
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect(r.json().error).toMatch(/priceLimits/);
    }
    // 0 is no limit's value: every book with a price would be dear, or left out (null follows the unknown price).
    for (const zero of [{ high: 0, max: 0 }, { high: 0, max: 5000 }]) expect((await a.patch('p_alex', { money: { priceLimits: zero } })).statusCode).toBe(400);
    expect(() => db.update(t.householdSettings).set({ priceHighC: 0, priceMaxC: 5000 }).run()).toThrow(/CHECK/);
    expect((await a.patch('p_alex', { money: { priceLimits: { high: 1, max: 1 } } })).statusCode).toBe(200);
    expect(() => db.update(t.householdSettings).set({ priceHighC: 1000, priceMaxC: null }).run()).toThrow(/CHECK/);
    expect(() => db.update(t.householdSettings).set({ priceHighC: 2000, priceMaxC: 1000 }).run()).toThrow(/CHECK/);
    await a.built.app.close();
  });

  it('in a currency without decimals, every amount an admin sets is whole: no fraction of a unit it cannot write', async () => {
    const db = household();
    db.delete(t.connectorEnabled).run();
    const a = await client(db);
    expect((await a.patch('p_alex', { money: { currency: 'JPY', unknownPrice: 250000 } })).statusCode).toBe(200);
    for (const body of [{ money: { unknownPrice: 250050 } }, { money: { priceLimits: { high: 400000, max: 600050 } } }, { budget: { min: 1000050, max: 2000000 } }]) {
      const r = await a.patch('p_alex', body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json().error).toMatch(/whole/);
    }
    expect((await a.patch('p_alex', { money: { priceLimits: { high: 400000, max: 600000 } }, budget: { min: 1000000, max: 2000000 } })).statusCode).toBe(200);
    // A month's own budget too.
    const month = (await a.get('p_alex', '/api/month')).json().month;
    const put = (b: unknown) => a.built.app.inject({ method: 'PUT', url: `/api/month/${month}/budget`, headers: { cookie: sessionCookie(db, 'p_alex'), origin: ORIGIN, 'content-type': 'application/json' }, payload: JSON.stringify(b) });
    expect((await put({ min: 1000050, max: 2000000 })).statusCode).toBe(400);
    expect((await put({ min: 1000000, max: 2000000 })).statusCode).toBe(200);
    // Nothing is converted: an end kept from the old currency stays, and the other end alone still changes.
    db.update(t.householdSettings).set({ budgetMinC: 1000050 }).run();
    expect((await a.patch('p_alex', { budget: { max: 3000000 } })).statusCode).toBe(200);
    await a.built.app.close();
  });

  it('a household in a currency without decimals and one in a high-nominal currency rank and pick as the two-decimal one does', () => {
    /** household() with priced books for an adult and a kid, every amount times `factor`, in `currency`. */
    function priced(factor: number, currency: string): Db {
      const db = household();
      const now = new Date().toISOString();
      const books: [string, 'adult' | 'kids', string, number | null][] = [
        ['b_a1', 'adult', 'p_alex', 1990], ['b_a2', 'adult', 'p_alex', 4490], ['b_a3', 'adult', 'p_alex', 6500], ['b_a4', 'adult', 'p_alex', null],
        ['b_k1', 'kids', 'p_kid1', 1690], ['b_k2', 'kids', 'p_kid1', 2690], ['b_k3', 'kids', 'p_kid1', 3990],
      ];
      for (const [id, audience, personId, priceC] of books) {
        db.insert(t.book).values({ id, title: `Invented ${id}`, authorsJson: `["Author ${id}"]`, audience, normKey: id, createdAt: now }).run();
        db.insert(t.candidate).values({ personId, bookId: id, origin: 'wishlist', addedAt: now, touchedAt: now }).run();
        if (priceC != null) db.insert(t.bookOffer).values({ bookId: id, source: 'invented', priceC: priceC * factor, seenAt: now }).run();
      }
      db.delete(t.connectorEnabled).run();
      db.update(t.householdSettings).set({ currency, unknownPriceC: 2500 * factor, budgetMinC: 10000 * factor, budgetMaxC: 15000 * factor }).run();
      return db;
    }
    const outcome = (db: Db) => {
      const rows = allCandidates(db, new Date('2026-11-20T12:00:00Z'), 'p_alex').map((r) => [r.personId, r.book.id, r.score === undefined ? 'left out' : Math.round(r.score * 1e6) / 1e6]);
      const m = getMonth(db, '2026-12', 'p_alex');
      const ids = (gs: { picks?: { candidate?: { book?: { id: string } } }[] }[] | undefined) => (gs ?? []).flatMap((g) => (g.picks ?? []).map((p) => p.candidate?.book?.id));
      return { rows, adults: ids(m.adults), kids: ids(m.kids) };
    };
    const two = outcome(priced(1, 'CHF'));
    expect(two.rows.some((r) => r[2] === 'left out')).toBe(true);
    expect(two.kids.length).toBeGreaterThan(0);
    expect(outcome(priced(100, 'JPY'))).toEqual(two);
    expect(outcome(priced(10000, 'IDR'))).toEqual(two);
  });
});

describe('a connector counts only in the household\'s currency', () => {
  it('enabling one is refused while the household has no currency, and when its currency is another', () => {
    const db = admins();
    db.insert(t.householdSettings).values({ id: 1 }).run();
    const enable = () => setConnector(db, CONNECTORS, 'quillmere', { enabled: true, acceptVersion: VERSION }, 'p_admin');
    expect(enable).toThrow(ConnectorError);
    expect(enable).toThrow(/currency/);
    db.update(t.householdSettings).set({ currency: 'EUR' }).run();
    expect(enable).toThrow(/CHF.*EUR|EUR.*CHF/);
    expect(db.select().from(t.connectorEnabled).all()).toEqual([]);
    db.update(t.householdSettings).set({ currency: 'CHF' }).run();
    expect(enable()).toMatchObject({ enabled: true });
  });

  it('through PUT /connectors/{id}: 409, and Settings says why before anyone tries', async () => {
    const db = admins();
    const a = await client(db, { PHILOBIBLOS_CURRENCY: 'EUR' });
    const listed = (await a.get('p_admin', '/api/connectors')).json().connectors.find((c: { id: string }) => c.id === 'quillmere');
    expect(listed).toMatchObject({ id: 'quillmere', currency: 'CHF', enabled: false });
    expect(listed.enableBlocked).toMatch(/CHF/);
    const r = await a.put('p_admin', 'quillmere', { enabled: true, acceptVersion: VERSION });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/currency/);
    expect(db.select().from(t.connectorEnabled).all()).toEqual([]);
    await a.built.app.close();
  });

  it('one enabled in another currency (the setting changed underneath it) counts for nothing, and Settings says so', () => {
    const db = household();
    expect(enabledConnectors(db, CONNECTORS).map((e) => e.id)).toEqual(['quillmere']);
    db.update(t.householdSettings).set({ currency: 'EUR' }).run();
    expect(enabledConnectors(db, CONNECTORS)).toEqual([]);
    const view = connectorView(db, CONNECTORS.get('quillmere')!);
    expect(view.enabled).toBe(false);
    expect(view.enableBlocked).toMatch(/currency/);
    db.update(t.householdSettings).set({ currency: null }).run();
    expect(enabledConnectors(db, CONNECTORS)).toEqual([]);
  });

  it('the household\'s currency does not change while a connector in another currency is enabled', async () => {
    const db = household();
    const a = await client(db);
    const r = await a.patch('p_alex', { money: { currency: 'EUR' } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/Quillmere Books/);
    expect((await a.get('p_alex', '/api/settings')).json().money.currency).toBe('CHF');
    // The same currency again changes nothing and is no conflict.
    expect((await a.patch('p_alex', { money: { currency: 'CHF', unknownPrice: 3000 } })).statusCode).toBe(200);
    // Nothing is half-written: a refused currency takes the request's other parts with it.
    expect((await a.patch('p_alex', { money: { currency: 'EUR', unknownPrice: 1 }, budget: { min: 1, max: 2 } })).statusCode).toBe(409);
    expect((await a.get('p_alex', '/api/settings')).json()).toMatchObject({ money: { currency: 'CHF', unknownPrice: 3000 }, budget: { min: 10000, max: 15000 } });
    expect((await a.put('p_alex', 'quillmere', { enabled: false })).statusCode).toBe(200);
    expect((await a.patch('p_alex', { money: { currency: 'EUR' } })).statusCode).toBe(200);
    await a.built.app.close();
  });

  it('a new currency turns every connector off: one that counted for nothing never comes back by itself', async () => {
    // An upgrade's case: the row says enabled, the household's currency (written by the migration) is another.
    const db = household();
    db.update(t.householdSettings).set({ currency: 'EUR' }).run();
    expect(enabledConnectors(db, CONNECTORS)).toEqual([]);
    const a = await client(db);
    // The same currency again keeps what is enabled.
    expect((await a.patch('p_alex', { money: { currency: 'EUR' } })).statusCode).toBe(200);
    expect(db.select().from(t.connectorEnabled).all()).toHaveLength(1);
    // Back to the shop's own currency: it stays off until an admin enables it again, having read what it allows.
    expect((await a.patch('p_alex', { money: { currency: 'CHF' } })).statusCode).toBe(200);
    expect(db.select().from(t.connectorEnabled).all()).toEqual([]);
    expect(enabledConnectors(db, CONNECTORS)).toEqual([]);
    expect((await a.get('p_alex', '/api/connectors')).json().connectors.find((c: { id: string }) => c.id === 'quillmere')).toMatchObject({ enabled: false, changed: false });
    await a.built.app.close();
  });

  it('a connector whose currency this server does not know can never be used', () => {
    const text = readFileSync(new URL('../../../connectors/quillmere/connector.yaml', import.meta.url), 'utf8');
    expect(text).toContain('currency: CHF');
    const r = readConnector(Buffer.from(text.replace('currency: CHF', 'currency: ZZZ')), 'quillmere');
    expect(r).toMatchObject({ problem: expect.stringMatching(/currency ZZZ/) });
  });
});

describe('Settings says when an admin cannot enable a connector now (philobiblos#38)', () => {
  it('under HomersLab: enabling waits for the edge\'s recent sign-in, and the list says so', async () => {
    const db = openDb(':memory:');
    db.insert(t.person).values({ id: 'p_admin', externalId: 'hl-admin', name: 'Admin', role: 'admin', handle: 'admin' }).run();
    const built = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'homerslab', PHILOBIBLOS_EDGE_IDENTITY: 'homerslab-v1', PHILOBIBLOS_TRUSTED_PROXY: '127.0.0.1', PHILOBIBLOS_ORIGIN: ORIGIN, PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_CURRENCY: 'CHF' }), db, { connectors: CONNECTORS, jobs: { schedule: { start: false } } });
    const h = { 'x-homerslab-person': 'hl-admin', 'x-homerslab-name': 'Admin', 'x-homerslab-role': 'admin' };
    const c = (await built.app.inject({ url: '/api/connectors', headers: h })).json().connectors.find((c: { id: string }) => c.id === 'quillmere');
    expect(c.enableBlocked).toMatch(/HomersLab/);
    await built.app.close();
  });

  it('standalone, in the household\'s currency: nothing stands in the way', async () => {
    const a = await client(admins(), { PHILOBIBLOS_CURRENCY: 'CHF' });
    const c = (await a.get('p_admin', '/api/connectors')).json().connectors.find((c: { id: string }) => c.id === 'quillmere');
    expect(c).not.toHaveProperty('enableBlocked');
    expect((await a.put('p_admin', 'quillmere', { enabled: true, acceptVersion: VERSION })).statusCode).toBe(200);
    await a.built.app.close();
  });
});
