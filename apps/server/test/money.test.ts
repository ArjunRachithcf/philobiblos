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
import { BUDGET_CEILING_C } from '../src/household/budget';
import { DEFAULT_UNKNOWN_PRICE_C } from '../src/household/money';
import { ORIGIN, TEST_SEALING_KEY, household, sessionCookie } from './helpers';
import { CONNECTORS } from './mailkit';

const env = (more: Record<string, string> = {}) => loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY, PHILOBIBLOS_EGRESS: 'off', ...more });
const start = (db: Db, more: Record<string, string> = {}) => buildApp(env(more), db, { connectors: CONNECTORS, jobs: { schedule: { start: false } } });
const VERSION = CONNECTORS.get('quillmere')!.version;

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
    expect((await a.get('p_admin', '/api/settings')).json().money).toEqual({ currency: 'EUR', unknownPrice: DEFAULT_UNKNOWN_PRICE_C });
    await a.built.app.close();
    const b = await client(db, { PHILOBIBLOS_CURRENCY: 'GBP' });
    expect((await b.get('p_admin', '/api/settings')).json().money.currency).toBe('EUR');
    // Everyone signed in sees it (the screens write amounts in it), from /me.
    expect((await b.get('p_adult', '/api/me')).json().money).toEqual({ currency: 'EUR', unknownPrice: DEFAULT_UNKNOWN_PRICE_C });
    await b.built.app.close();
  });

  it('unset, the household has no currency until it is chosen: none is assumed; set at a later start, it fills that in', async () => {
    const db = admins();
    const a = await client(db);
    expect((await a.get('p_admin', '/api/settings')).json().money).toEqual({ currency: null, unknownPrice: DEFAULT_UNKNOWN_PRICE_C });
    expect((await a.get('p_adult', '/api/me')).json().money.currency).toBeNull();
    await a.built.app.close();
    const b = await client(db, { PHILOBIBLOS_CURRENCY: 'SEK' });
    expect((await b.get('p_admin', '/api/settings')).json().money.currency).toBe('SEK');
    await b.built.app.close();
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
  it('25 in the household\'s currency by default; an admin sets it, whole hundredths from 0 to the budget\'s ceiling', async () => {
    expect(DEFAULT_UNKNOWN_PRICE_C).toBe(2500);
    const db = household();
    const a = await client(db);
    expect((await a.patch('p_sam', { money: { unknownPrice: 4000 } })).statusCode).toBe(403);
    for (const bad of [-1, 1.5, BUDGET_CEILING_C + 1, '4000', null]) expect((await a.patch('p_alex', { money: { unknownPrice: bad } })).statusCode, String(bad)).toBe(400);
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

  it('the scores read it too: an unknown price above a person\'s price limit leaves the book out', () => {
    const db = household();
    const tide = () => allCandidates(db, new Date(), 'p_alex').find((r) => r.personId === 'p_alex' && r.book.id === 'b_tide')!;
    expect(tide().score).toBeDefined();
    // Above packages/scoring's priceMax (60): a book whose price nobody knows now counts as too dear.
    db.update(t.householdSettings).set({ unknownPriceC: 7000 }).run();
    expect(tide().score).toBeUndefined();
    expect(tide().scoreParts).toEqual([expect.objectContaining({ kind: 'excluded' })]);
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
    const listed = (await a.get('p_admin', '/api/connectors')).json().connectors[0];
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
    expect((await a.get('p_alex', '/api/connectors')).json().connectors[0]).toMatchObject({ enabled: false, changed: false });
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
    const c = (await built.app.inject({ url: '/api/connectors', headers: h })).json().connectors[0];
    expect(c.enableBlocked).toMatch(/HomersLab/);
    await built.app.close();
  });

  it('standalone, in the household\'s currency: nothing stands in the way', async () => {
    const a = await client(admins(), { PHILOBIBLOS_CURRENCY: 'CHF' });
    const c = (await a.get('p_admin', '/api/connectors')).json().connectors[0];
    expect(c).not.toHaveProperty('enableBlocked');
    expect((await a.put('p_admin', 'quillmere', { enabled: true, acceptVersion: VERSION })).statusCode).toBe(200);
    await a.built.app.close();
  });
});
