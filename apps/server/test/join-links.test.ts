// Standalone join links (ADR 0011, philobiblos#34 slice 2): made by an admin with a fresh sign-in once a home network is
// listed, the token in the #fragment and kept as SHA-256; one answer and one timing for every link that does not open;
// uses counted at the passkey's enrolment only; rate limits per address and per link; revoking declines; an admin's
// links go with them; 404 under HomersLab; the 10-waiting cap and the 7-day lapse. Every name, id and address is invented.
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp, type BuiltApp } from '../src/app';
import { FRESH_MINUTES, createSession } from '../src/auth/sessions';
import { hashToken } from '../src/auth/tokens';
import { loadConfig } from '../src/config';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { JOIN_LINK } from '../src/household/join-links';
import { WAITING, waitingPeople } from '../src/household/waiting';
import { inHomeNetwork, parseCidr, parseRoutes, proposeNetwork, type Surroundings } from '../src/net/networks';
import { JOIN_ENROL, JOIN_OPEN, NOT_HERE, addressKey, joinName } from '../src/routes/join';
import { spendUse } from '../src/household/join-links';
import { Limiter } from '../src/shares/tokens';
import { JOIN_PUSH } from '../src/push/push';
import type { Egress } from '../src/net/egress';
import { ORIGIN, RFC8291_UA_KEY, TEST_SEALING_KEY, fakeWebAuthn, household, nowherePush, sessionCookie } from './helpers';

const standalone = () => loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY });
const homerslab = () => loadConfig({ PHILOBIBLOS_MODE: 'homerslab', PHILOBIBLOS_EDGE_IDENTITY: 'homerslab-v1', PHILOBIBLOS_TRUSTED_PROXY: '127.0.0.1', PHILOBIBLOS_ORIGIN: ORIGIN, PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY });
const hlHeaders = (person: string, name: string, role: string) => ({ 'x-homerslab-person': person, 'x-homerslab-name': name, 'x-homerslab-role': role });

/** The home network of these tests, a client in it (a direct connection, no proxy) and an address outside it. */
const HOME = '10.20.0.0/16';
const HOME_ADDR = '10.20.0.10';
const AWAY = '198.51.100.7';
const FLOOR = 60;
const DAY = 86_400_000;

let open: BuiltApp[] = [];
/** Where the tests' Philobiblos runs: on a host, not in a container, unless a test says otherwise. */
const HOST: Surroundings = { container: false, gateways: [], localNets: [] };
async function app(cfg = standalone(), db = household(), o: { push?: Egress; floorMs?: number; surroundings?: Surroundings } = {}) {
  const b = await buildApp(cfg, db, { webauthn: fakeWebAuthn(), push: o.push ?? nowherePush, joinFloorMs: o.floorMs ?? 0, surroundings: o.surroundings ?? HOST });
  await b.app.ready();
  open.push(b);
  return { ...b, db };
}
afterEach(async () => { for (const b of open) await b.app.close(); open = []; });

const home = (db: Db, cidr = HOME) => db.insert(t.homeNetwork).values({ cidr, addedBy: 'p_alex', addedAt: new Date().toISOString() }).run();
const sessionAgo = (db: Db, personId: string, minutes: number) => `philobiblos_session=${createSession(db, personId, null, new Date(Date.now() - minutes * 60_000)).token}`;
const post = (a: BuiltApp['app'], url: string, payload: object, o: { remote?: string; cookie?: string } = {}) =>
  a.inject({ method: 'POST', url, payload, remoteAddress: o.remote ?? HOME_ADDR, headers: { origin: ORIGIN, ...(o.cookie ? { cookie: o.cookie } : {}) } });

/** An admin's new link (through the route): its token, from the url's #fragment. */
async function makeLink(a: BuiltApp['app'], db: Db, body: object = {}, by = 'p_alex') {
  const res = await post(a, '/api/people/join-links', body, { cookie: sessionCookie(db, by) });
  expect(res.statusCode, res.body).toBe(201);
  const { id, url } = res.json() as { id: string; url: string };
  return { id, url, token: url.split('#')[1]! };
}

/** Options, then the fake authenticator's response: the person waits. */
async function options(a: BuiltApp['app'], token: string, name: string, remote?: string) {
  return post(a, '/api/join/options', { token, name }, { remote });
}
async function verify(a: BuiltApp['app'], start: { challengeId: string; options: { challenge: string } }, credId: string, remote?: string) {
  return post(a, '/api/join/verify', { challengeId: start.challengeId, response: { id: credId, challenge: start.options.challenge }, label: 'Phone' }, { remote });
}
async function join(a: BuiltApp['app'], token: string, name: string, credId = `cred-${name}-${Math.random()}`) {
  const o = await options(a, token, name);
  expect(o.statusCode, o.body).toBe(200);
  const v = await verify(a, o.json(), credId);
  return v;
}

/** Every household word of household(): none may be in an answer of the join pages. */
const HOUSEHOLD_WORDS = ['Alex', 'Sam', 'Robin', 'Kid 1', 'p_alex', 'p_sam', 'p_del', 'p_kid1', 'partner', 'alex', 'robin', 'Long Tide', 'Ledger', 'Markets', 'pk1', 'pk2', 'quillmere'];
const leaksNothing = (body: string) => { for (const w of HOUSEHOLD_WORDS) expect(body, w).not.toContain(w); };

describe('making a join link', () => {
  it('with no home network listed no link can be made; once one is, a link of 7 days and 5 uses', async () => {
    const { app: a, db } = await app();
    const cookie = sessionCookie(db, 'p_alex');
    const none = await post(a, '/api/people/join-links', {}, { cookie });
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toMatch(/home network/);
    expect(db.select().from(t.joinLink).all()).toEqual([]);
    // an emptied list is no list either
    expect((await a.inject({ method: 'PUT', url: '/api/people/home-networks', headers: { cookie, origin: ORIGIN }, payload: { networks: [] } })).statusCode).toBe(200);
    expect((await post(a, '/api/people/join-links', {}, { cookie })).statusCode).toBe(409);
    const put = await a.inject({ method: 'PUT', url: '/api/people/home-networks', headers: { cookie, origin: ORIGIN }, payload: { networks: ['192.0.2.77/24'] } });
    expect(put.json()).toMatchObject({ networks: [{ cidr: '192.0.2.0/24' }] });
    const res = await post(a, '/api/people/join-links', {}, { cookie });
    expect(res.statusCode).toBe(201);
    const { url, expiresAt, maxUses } = res.json();
    expect(url).toMatch(new RegExp(`^${ORIGIN}/join#[A-Za-z0-9_-]{43}$`));
    expect(maxUses).toBe(JOIN_LINK.uses);
    expect(Math.round((new Date(expiresAt).getTime() - Date.now()) / DAY)).toBe(JOIN_LINK.days);
  });

  it('keeps only the token\'s SHA-256, and the token is never in a later answer', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db);
    const row = db.select().from(t.joinLink).get()!;
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const list = await a.inject({ url: '/api/people/join-links', headers: { cookie: sessionCookie(db, 'p_alex') } });
    expect(list.body).not.toContain(token);
    expect(list.body).not.toContain(row.tokenHash);
  });

  it('days and uses are editable within bounds', async () => {
    const { app: a, db } = await app();
    home(db);
    const cookie = sessionCookie(db, 'p_alex');
    for (const body of [{ days: 0 }, { days: JOIN_LINK.maxDays + 1 }, { uses: 0 }, { uses: JOIN_LINK.maxUses + 1 }, { days: 1.5 }, { uses: '3' }, { days: 3, rules: [] }]) {
      expect((await post(a, '/api/people/join-links', body, { cookie })).statusCode, JSON.stringify(body)).toBe(400);
    }
    const ok = (await post(a, '/api/people/join-links', { days: JOIN_LINK.maxDays, uses: JOIN_LINK.maxUses }, { cookie })).json();
    expect(ok.maxUses).toBe(JOIN_LINK.maxUses);
    expect(Math.round((new Date(ok.expiresAt).getTime() - Date.now()) / DAY)).toBe(JOIN_LINK.maxDays);
  });

  it('making, revoking and the home network need an admin with a fresh sign-in', async () => {
    const { app: a, db } = await app();
    home(db);
    const { id } = await makeLink(a, db);
    const stale = sessionAgo(db, 'p_alex', FRESH_MINUTES + 1);
    const adult = sessionCookie(db, 'p_sam');
    for (const cookie of [stale, adult]) {
      expect((await post(a, '/api/people/join-links', {}, { cookie })).statusCode).toBe(403);
      expect((await a.inject({ method: 'DELETE', url: `/api/people/join-links/${id}`, headers: { cookie, origin: ORIGIN } })).statusCode).toBe(403);
      expect((await a.inject({ method: 'PUT', url: '/api/people/home-networks', headers: { cookie, origin: ORIGIN }, payload: { networks: ['0.0.0.0/8'] } })).statusCode).toBe(403);
    }
    expect((await a.inject({ url: '/api/people/join-links', headers: { cookie: adult } })).statusCode).toBe(403);
    expect((await a.inject({ url: '/api/people/home-networks', headers: { cookie: adult } })).statusCode).toBe(403);
    expect(db.select().from(t.joinLink).all()).toHaveLength(1);
    expect(db.select().from(t.homeNetwork).all().map((n) => n.cidr)).toEqual([HOME]);
  });
});

describe('the home network', () => {
  it('ranges are CIDRs, normalised, never wider than /8 (IPv4) or /32 (IPv6)', () => {
    expect(parseCidr('192.168.1.77/24')?.cidr).toBe('192.168.1.0/24');
    expect(parseCidr('10.1.2.3/8')?.cidr).toBe('10.0.0.0/8');
    expect(parseCidr('203.0.113.9/32')?.cidr).toBe('203.0.113.9/32');
    expect(parseCidr('fd12:3456:789a:1::5/64')?.cidr).toBe('fd12:3456:789a:1::/64');
    expect(parseCidr('2001:db8::1/32')?.cidr).toBe('2001:db8::/32');
    for (const bad of ['0.0.0.0/0', '10.0.0.0/7', '::ffff:192.168.1.0/120', '::/0', '2001:db8::/31', '192.168.1.0', '192.168.1.0/33', '192.168.1.0/24\n', 'a/24', '', 24, null, 'x'.repeat(80)]) {
      expect(parseCidr(bad), String(bad)).toBeNull();
    }
  });

  it('the list proposes the private range the admin is on, never adds it by itself', async () => {
    expect(proposeNetwork('192.168.1.23')).toBe('192.168.1.0/24');
    expect(proposeNetwork('::ffff:10.4.5.6')).toBe('10.4.5.0/24');
    expect(proposeNetwork('100.70.1.2')).toBe('100.70.1.0/24');
    expect(proposeNetwork('fd12:3456:789a:1::5')).toBe('fd12:3456:789a:1::/64');
    for (const a of ['127.0.0.1', '172.18.0.1', '172.20.5.9', '192.168.1.1', '203.0.113.5', '2001:db8::1', 'fe80::1', '', undefined]) expect(proposeNetwork(a), String(a)).toBeNull();
    const { app: a, db } = await app();
    const res = await a.inject({ url: '/api/people/home-networks', remoteAddress: '192.168.1.23', headers: { cookie: sessionCookie(db, 'p_alex') } });
    expect(res.json()).toEqual({ networks: [], proposal: '192.168.1.0/24', behindProxy: false });
    expect(db.select().from(t.homeNetwork).all()).toEqual([]);
  });

  it('an address is in it or not; an IPv4-mapped address counts as its IPv4 one', () => {
    const db = household();
    expect(inHomeNetwork(db, '192.0.2.5')).toBe(false); // an empty list never means anywhere
    home(db, '192.0.2.0/24');
    expect(inHomeNetwork(db, '192.0.2.5')).toBe(true);
    expect(inHomeNetwork(db, '::ffff:192.0.2.5')).toBe(true);
    expect(inHomeNetwork(db, '192.0.3.5')).toBe(false);
    expect(inHomeNetwork(db, undefined)).toBe(false);
  });

  it('a bad range is refused whole; the list keeps what it had', async () => {
    const { app: a, db } = await app();
    home(db);
    const cookie = sessionCookie(db, 'p_alex');
    for (const payload of [{ networks: ['192.0.2.0/24', '0.0.0.0/0'] }, { networks: 'all' }, { networks: Array(21).fill('192.0.2.0/24') }, { networks: [], extra: 1 }]) {
      expect((await a.inject({ method: 'PUT', url: '/api/people/home-networks', headers: { cookie, origin: ORIGIN }, payload })).statusCode).toBe(400);
    }
    expect(db.select().from(t.homeNetwork).all().map((n) => n.cidr)).toEqual([HOME]);
  });
});

describe('one answer, and one timing, for every link that does not open', () => {
  /** A household with one link of each kind that does not open, and one that does. */
  async function links(floorMs = 0) {
    const built = await app(standalone(), household(), { floorMs });
    const { app: a, db } = built;
    home(db);
    const good = await makeLink(a, db);
    const revoked = await makeLink(a, db);
    expect((await a.inject({ method: 'DELETE', url: `/api/people/join-links/${revoked.id}`, headers: { cookie: sessionCookie(db, 'p_alex'), origin: ORIGIN } })).statusCode).toBe(204);
    const expired = await makeLink(a, db);
    db.update(t.joinLink).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(t.joinLink.id, expired.id)).run();
    const usedUp = await makeLink(a, db, { uses: 1 });
    db.update(t.joinLink).set({ uses: 1 }).where(eq(t.joinLink.id, usedUp.id)).run();
    const cases: [string, string, string][] = [
      ['revoked', revoked.token, HOME_ADDR], ['expired', expired.token, HOME_ADDR], ['used up', usedUp.token, HOME_ADDR],
      ['unknown', 'A'.repeat(43), HOME_ADDR], ['malformed', 'not a token', HOME_ADDR], ['out of network', good.token, AWAY],
    ];
    return { ...built, good, cases };
  }

  it('opening: the same status and body for revoked, expired, used-up, unknown and out-of-network links', async () => {
    const { app: a, good, cases } = await links();
    expect((await post(a, '/api/join/open', { token: good.token })).statusCode).toBe(204);
    for (const [what, token, remote] of cases) {
      const res = await post(a, '/api/join/open', { token }, { remote });
      expect([res.statusCode, res.json()], what).toEqual([404, NOT_HERE]);
    }
  });

  it('joining: the same answer too, and nothing is stored or counted', async () => {
    const { app: a, db, cases } = await links();
    for (const [what, token, remote] of cases) {
      const res = await options(a, token, 'Jordan', remote);
      expect([res.statusCode, res.json()], what).toEqual([404, NOT_HERE]);
    }
    expect(waitingPeople(db)).toEqual([]);
    expect(db.select().from(t.joinLink).all().map((l) => l.uses).sort()).toEqual([0, 0, 1]);
  });

  it('a full waiting list gets the same answer', async () => {
    const { app: a, db, good } = await links();
    for (let i = 0; i < WAITING.max; i++) db.insert(t.person).values({ id: `p_w${i}`, name: `W${i}`, role: 'adult', state: 'waiting', arrivedAt: new Date().toISOString() }).run();
    for (const url of ['/api/join/open', '/api/join/options']) {
      const res = await post(a, url, { token: good.token, name: 'Jordan' });
      expect([res.statusCode, res.json()], url).toEqual([404, NOT_HERE]);
    }
    // one decided: the link opens again
    db.delete(t.person).where(eq(t.person.id, 'p_w0')).run();
    expect((await post(a, '/api/join/open', { token: good.token })).statusCode).toBe(204);
  });

  it('timing: every one is answered after the same floor, the link that opens too', async () => {
    const { app: a, good, cases } = await links(FLOOR);
    const timed = async (url: string, token: string, remote: string) => {
      const t0 = performance.now();
      const res = await post(a, url, { token, name: 'Jordan' }, { remote });
      return { ms: performance.now() - t0, status: res.statusCode };
    };
    for (const url of ['/api/join/open', '/api/join/options']) {
      const all = [['opens', good.token, HOME_ADDR] as const, ...cases];
      const ms: Record<string, number[]> = {};
      for (let round = 0; round < 3; round++) {
        for (const [what, token, remote] of all) (ms[what] ??= []).push((await timed(url, token, remote)).ms);
      }
      const medians = Object.entries(ms).map(([what, xs]) => [what, xs.sort((x, y) => x - y)[1]!] as const);
      for (const [what, m] of medians) expect(m, `${url} ${what}`).toBeGreaterThanOrEqual(FLOOR - 1);
      const spread = Math.max(...medians.map((x) => x[1])) - Math.min(...medians.map((x) => x[1]));
      expect(spread, `${url}: ${JSON.stringify(medians)}`).toBeLessThan(FLOOR);
    }
  });

  it('a member\'s name gets the same answer as a new one, and is never compared', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db);
    const member = await options(a, token, 'Alex');
    const stranger = await options(a, token, 'Jordan Rivers');
    expect(member.statusCode).toBe(200);
    expect(stranger.statusCode).toBe(200);
    expect(Object.keys(member.json()).sort()).toEqual(Object.keys(stranger.json()).sort());
    const v = await verify(a, member.json(), 'cred-alex-2');
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ signedIn: true, waiting: true, person: { name: 'Alex', role: 'adult', handle: null } });
    expect(db.select().from(t.person).where(eq(t.person.id, 'p_alex')).get()).toMatchObject({ role: 'admin', state: 'active' });
    expect(waitingPeople(db).map((p) => p.name)).toEqual(['Alex']);
    const s = await verify(a, stranger.json(), 'cred-jordan');
    expect(Object.keys(s.json()).sort()).toEqual(Object.keys(v.json()).sort());
  });

  it('a name is 1 to 60 characters, no control characters; the same 400 whatever the link', () => {
    expect(joinName('  Jordan ')).toBe('Jordan');
    for (const bad of ['', '   ', 'x'.repeat(61), 'Jo\nrdan', 'Jo\u2028', '\u202Enaj', 'Jo\u2066rdan', 'Jo\u200Brdan', 'Jo\u00ADrdan', 'Jo\uFE0F', 'Jo\u{E0041}', 'Jo\u061C', 42, null]) expect(joinName(bad), JSON.stringify(bad)).toBeNull();
  });
});

const DOCKER: Surroundings = { container: true, gateways: ['172.17.0.1'], localNets: [parseCidr('172.17.0.0/16')!, parseCidr('192.168.16.0/20')!] };
const putNets = (a: BuiltApp['app'], db: Db, networks: string[], remote?: string) =>
  a.inject({ method: 'PUT', url: '/api/people/home-networks', remoteAddress: remote ?? HOME_ADDR, headers: { cookie: sessionCookie(db, 'p_alex'), origin: ORIGIN }, payload: { networks } });

describe('a hop is never home: loopback and the container\'s gateway (until slice 3\'s trusted proxy)', () => {
  it('loopback ranges, and ranges holding the container\'s gateway or the admin\'s own hop, are refused', async () => {
    const { app: a, db } = await app(standalone(), household(), { surroundings: DOCKER });
    for (const bad of ['127.0.0.0/8', '127.0.0.1/32', '::1/128', '172.17.0.0/16', '172.16.0.0/12', '172.17.0.0/24']) {
      expect((await putNets(a, db, [bad])).statusCode, bad).toBe(400);
    }
    const viaGateway = await putNets(a, db, ['10.0.0.0/8'], '10.89.0.1');
    expect(viaGateway.statusCode).toBe(200); // not this container's gateway: the range holds no hop
    const podman = await app(standalone(), household(), { surroundings: { container: true, gateways: ['10.89.0.1'], localNets: [] } });
    expect((await putNets(podman.app, podman.db, ['10.0.0.0/8'], '10.89.0.1')).statusCode).toBe(400);
    expect((await putNets(podman.app, podman.db, ['10.89.0.0/24'])).statusCode).toBe(400);
    // on a host, loopback is still refused; a router's range is fine
    const host = await app();
    expect((await putNets(host.app, host.db, ['127.0.0.0/8'], '127.0.0.1')).statusCode).toBe(400);
    expect((await putNets(host.app, host.db, ['192.168.1.0/24'])).statusCode).toBe(200);
    expect(db.select().from(t.homeNetwork).all().map((n) => n.cidr)).toEqual(['10.0.0.0/8']);
  });

  it('a connection from loopback or the gateway is out of network, even when a range lists it (written by hand)', async () => {
    const { app: a, db } = await app(standalone(), household(), { surroundings: DOCKER });
    home(db, '127.0.0.0/8');
    home(db, '172.17.0.0/16');
    const { token } = await makeLink(a, db);
    for (const remote of ['127.0.0.1', '::ffff:127.0.0.1', '172.17.0.1', '::1']) {
      const res = await post(a, '/api/join/open', { token }, { remote });
      expect([res.statusCode, res.json()], remote).toEqual([404, NOT_HERE]);
    }
    expect((await post(a, '/api/join/open', { token }, { remote: '172.17.0.5' })).statusCode).toBe(204); // a container on the bridge
  });

  it('behind a hop the admin is told join links wait, and nothing is proposed', async () => {
    const { app: a, db } = await app(standalone(), household(), { surroundings: DOCKER });
    const view = async (remote: string) => (await a.inject({ url: '/api/people/home-networks', remoteAddress: remote, headers: { cookie: sessionCookie(db, 'p_alex') } })).json();
    expect(await view('172.17.0.1')).toMatchObject({ behindProxy: true, proposal: null });
    expect(await view('127.0.0.1')).toMatchObject({ behindProxy: true, proposal: null });
    expect(await view('192.168.16.3')).toMatchObject({ behindProxy: false, proposal: null }); // a proxy on a container network
    expect(await view('192.168.1.23')).toMatchObject({ behindProxy: false, proposal: '192.168.1.0/24' });
    expect(proposeNetwork('10.89.0.1', { container: true, gateways: ['10.89.0.1'], localNets: [] })).toBeNull();
    expect(proposeNetwork('10.89.0.7', { container: true, gateways: ['10.89.0.7'], localNets: [] })).toBeNull(); // a gateway not on .1
  });

  it('the gateways and networks come from /proc/net/route', () => {
    const text = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
      'eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
      'garbage',
    ].join('\n');
    expect(parseRoutes(text)).toEqual({ gateways: ['172.17.0.1'], nets: [parseCidr('172.17.0.0/16')] });
  });
});

describe('limits, the review\'s nits', () => {
  it('the per-link limit holds at the enrolment too, before its step is taken', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db);
    const first = await options(a, token, 'Jordan', '10.20.11.1');
    for (let i = 1; i < JOIN_ENROL.max; i++) expect((await options(a, token, 'Jordan', `10.20.11.${i + 1}`)).statusCode).toBe(200);
    expect((await verify(a, first.json(), 'cred-j', '10.20.12.1')).statusCode).toBe(429);
    expect((await verify(a, first.json(), 'cred-j', '10.20.12.2')).statusCode).toBe(429); // still there: 429, not 'start again'
    expect(waitingPeople(db)).toEqual([]);
  });

  it('spendUse counts only while uses < maxUses and the link is unexpired', () => {
    const db = household();
    const now = new Date();
    const row = (id: string, uses: number, maxUses: number, expires: number) => db.insert(t.joinLink).values({ id, tokenHash: id, createdBy: 'p_alex', createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + expires).toISOString(), uses, maxUses }).run();
    row('l_room', 4, 5, DAY);
    row('l_full', 5, 5, DAY);
    row('l_old', 0, 5, -1000);
    expect(spendUse(db, 'l_room', now)).toBe(true);
    expect(spendUse(db, 'l_room', now)).toBe(false); // now 5 of 5
    expect(spendUse(db, 'l_full', now)).toBe(false);
    expect(spendUse(db, 'l_old', now)).toBe(false);
    expect(db.select().from(t.joinLink).all().map((l) => l.uses)).toEqual([5, 5, 0]);
  });

  it('an IPv6 /64 is one address for the limits; a mapped IPv4 address is its IPv4 one', () => {
    expect(addressKey('2001:db8:1:2::5')).toBe(addressKey('2001:db8:1:2:ffff::9'));
    expect(addressKey('2001:db8:1:2::5')).not.toBe(addressKey('2001:db8:1:3::5'));
    expect(addressKey('::ffff:192.0.2.1')).toBe(addressKey('192.0.2.1'));
  });

  it('a per-link limiter that is full refuses new keys, never forgetting a count', () => {
    const l = new Limiter(1, 60_000, 2, 'refuse');
    expect(l.hit('link-a')).toBe(true);
    expect(l.hit('flood-1')).toBe(true);
    expect(l.hit('flood-2')).toBe(false); // full: refused, link-a kept
    expect(l.hit('link-a')).toBe(false); // its count survived
    const e = new Limiter(1, 60_000, 2);
    e.hit('link-a'); e.hit('flood-1'); e.hit('flood-2');
    expect(e.hit('link-a')).toBe(true); // the default evicts (what the join routes no longer use for links)
  });

  it('the join routes count a link apart from addresses: a flood of addresses never resets it', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db);
    for (let i = 0; i < JOIN_OPEN.max; i++) await post(a, '/api/join/open', { token }, { remote: `10.20.13.${i + 1}` });
    for (let i = 0; i < 300; i++) await post(a, '/api/join/open', { token: 'E'.repeat(43) }, { remote: `10.20.${14 + (i >> 8)}.${(i & 255) + 1}` });
    expect((await post(a, '/api/join/open', { token }, { remote: '10.20.20.1' })).statusCode).toBe(429);
  });
});

describe('what the review found', () => {
  it('a member signed in on this browser is not asked to join (their session stays)', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db);
    const cookie = sessionCookie(db, 'p_sam');
    const res = await post(a, '/api/join/options', { token, name: 'Jordan' }, { cookie });
    expect(res.statusCode).toBe(409);
    expect((await a.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
    expect(waitingPeople(db)).toEqual([]);
  });

  it('an enrolment refused by the address limit keeps its one-time step', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db);
    const o = await options(a, token, 'Jordan', '10.20.8.1');
    for (let i = 0; i < JOIN_ENROL.max; i++) await post(a, '/api/join/verify', { challengeId: 'nothing', response: {} }, { remote: '10.20.9.1' });
    expect((await verify(a, o.json(), 'cred-j', '10.20.9.1')).statusCode).toBe(429);
    // from an address within its limit, the same step still works
    expect((await verify(a, o.json(), 'cred-j', '10.20.8.1')).statusCode).toBe(200);
  });

  it('bogus enrolments never hold back a real link\'s', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db);
    for (let i = 0; i < JOIN_ENROL.max + 2; i++) await post(a, '/api/join/verify', { challengeId: `x${i}`, response: {} }, { remote: `10.20.10.${i + 1}` });
    const o = await options(a, token, 'Jordan');
    expect((await verify(a, o.json(), 'cred-j')).statusCode).toBe(200);
  });

  it('a lapsed person\'s passkey signs no one in, and the request goes', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db);
    const v = await join(a, token, 'Jordan', 'cred-lapsed');
    const id = v.json().person.id as string;
    db.update(t.person).set({ arrivedAt: new Date(Date.now() - WAITING.lapseDays * DAY - 60_000).toISOString() }).where(eq(t.person.id, id)).run();
    const start = (await post(a, '/api/auth/sign-in/options', {})).json();
    const res = await post(a, '/api/auth/sign-in/verify', { challengeId: start.challengeId, response: { id: 'cred-lapsed', challenge: start.options.challenge } });
    expect(res.statusCode).toBe(401);
    expect(db.select().from(t.person).where(eq(t.person.id, id)).all()).toEqual([]);
  });

  it('HomersLab: an unchanged kid\'s requests write seen_at at most hourly, and touch nothing else', async () => {
    const { app: a, db } = await app(homerslab());
    const kid = hlHeaders('hl-kid', 'Kid 1', 'kid');
    expect((await a.inject({ url: '/api/me', headers: kid })).statusCode).toBe(403);
    const first = db.select().from(t.person).where(eq(t.person.id, 'p_kid1')).get()!.seenAt;
    expect(first).toEqual(expect.any(String));
    await new Promise((r) => setTimeout(r, 5));
    expect((await a.inject({ url: '/api/me', headers: kid })).statusCode).toBe(403);
    expect(db.select().from(t.person).where(eq(t.person.id, 'p_kid1')).get()!.seenAt).toBe(first);
  });
});

describe('nothing from the household on the join pages', () => {
  it('opening, the options and the enrolment answer nothing of the household', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db);
    const opened = await post(a, '/api/join/open', { token });
    expect(opened.body).toBe('');
    const o = await options(a, token, 'Jordan');
    leaksNothing(o.body);
    // no one's passkeys are named to exclude, and the user is the name given
    expect(o.json().options).toMatchObject({ user: { name: 'Jordan' } });
    expect(o.json()).not.toHaveProperty('person');
    const v = await verify(a, o.json(), 'cred-jordan');
    leaksNothing(v.body);
    const s = await a.inject({ url: '/api/auth/session', headers: { cookie: String(v.headers['set-cookie']).split(';')[0]! } });
    expect(s.json()).toMatchObject({ waiting: true, person: { name: 'Jordan' } });
    leaksNothing(s.body);
    for (const [what, token2] of [['unknown', 'B'.repeat(43)], ['good', token]] as const) {
      leaksNothing((await post(a, '/api/join/open', { token: token2 })).body + what);
    }
  });
});

describe('rate limits: per address and per link, 429 past them', () => {
  it('opening: per address, across links, the unknown ones too', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db);
    for (let i = 0; i < JOIN_OPEN.max; i++) expect((await post(a, '/api/join/open', { token: `${'C'.repeat(40)}${String(i).padStart(3, '0')}` })).statusCode).toBe(404);
    expect((await post(a, '/api/join/open', { token })).statusCode).toBe(429);
    // another address is not held back
    expect((await post(a, '/api/join/open', { token }, { remote: '10.20.0.2' })).statusCode).toBe(204);
  });

  it('opening: per link, across addresses', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db);
    for (let i = 0; i < JOIN_OPEN.max; i++) expect((await post(a, '/api/join/open', { token }, { remote: `10.20.1.${i + 1}` })).statusCode).toBe(204);
    expect((await post(a, '/api/join/open', { token }, { remote: '10.20.2.1' })).statusCode).toBe(429);
    // and an unknown link from those addresses is limited alike, never told apart
    const other = 'D'.repeat(43);
    for (let i = 0; i < JOIN_OPEN.max; i++) await post(a, '/api/join/open', { token: other }, { remote: `10.20.3.${i + 1}` });
    expect((await post(a, '/api/join/open', { token: other }, { remote: '10.20.4.1' })).statusCode).toBe(429);
  });

  it('joining: the options and the enrolment, per address and per link', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db);
    for (let i = 0; i < JOIN_ENROL.max; i++) expect((await options(a, token, 'Jordan', `10.20.5.${i + 1}`)).statusCode).toBe(200);
    expect((await options(a, token, 'Jordan', '10.20.6.1')).statusCode).toBe(429);
    const other = (await makeLink(a, db)).token;
    for (let i = 0; i < JOIN_ENROL.max - 1; i++) expect((await options(a, other, 'Jordan', '10.20.7.1')).statusCode).toBe(200);
    const last = await options(a, other, 'Jordan', '10.20.7.1');
    expect(last.statusCode).toBe(200);
    // the enrolment counts with the options: this address is past its limit now
    expect((await verify(a, last.json(), 'cred-late', '10.20.7.1')).statusCode).toBe(429);
    expect(waitingPeople(db)).toEqual([]);
  });
});

describe('a link\'s uses count only at the passkey\'s enrolment, in the same transaction', () => {
  it('opening and asking for options count nothing; the enrolment counts one', async () => {
    const { app: a, db } = await app();
    home(db);
    const { id, token } = await makeLink(a, db);
    for (let i = 0; i < 3; i++) await post(a, '/api/join/open', { token });
    const o = await options(a, token, 'Jordan');
    await options(a, token, 'Jordan');
    expect(db.select().from(t.joinLink).where(eq(t.joinLink.id, id)).get()!.uses).toBe(0);
    expect((await verify(a, o.json(), 'cred-jordan')).statusCode).toBe(200);
    expect(db.select().from(t.joinLink).where(eq(t.joinLink.id, id)).get()!.uses).toBe(1);
  });

  it('used up between the options and the enrolment: the same answer, and nothing kept', async () => {
    const { app: a, db } = await app();
    home(db);
    const { id, token } = await makeLink(a, db, { uses: 1 });
    const first = await options(a, token, 'Jordan');
    const second = await options(a, token, 'Casey');
    expect((await verify(a, first.json(), 'cred-1')).statusCode).toBe(200);
    const late = await verify(a, second.json(), 'cred-2');
    expect([late.statusCode, late.json()]).toEqual([404, NOT_HERE]);
    expect(db.select().from(t.joinLink).where(eq(t.joinLink.id, id)).get()!.uses).toBe(1);
    expect(waitingPeople(db).map((p) => p.name)).toEqual(['Jordan']);
    expect(db.select().from(t.passkey).where(eq(t.passkey.id, 'cred-2')).all()).toEqual([]);
  });

  it('an enrolment that fails (a passkey already enrolled) counts no use and stores no one', async () => {
    const { app: a, db } = await app();
    home(db);
    const { id, token } = await makeLink(a, db);
    const o = await options(a, token, 'Jordan');
    const res = await verify(a, o.json(), 'pk1'); // Alex's passkey
    expect(res.statusCode).toBe(409);
    expect(db.select().from(t.joinLink).where(eq(t.joinLink.id, id)).get()!.uses).toBe(0);
    expect(waitingPeople(db)).toEqual([]);
  });

  it('the count, the person, the request and the passkey are one transaction', async () => {
    const { app: a, db } = await app();
    home(db);
    const { id, token } = await makeLink(a, db);
    const o = await options(a, token, 'Jordan');
    // The use cannot be counted (a CHECK fails): the person and the passkey are rolled back with it.
    db.update(t.joinLink).set({ maxUses: 1, uses: 0 }).where(eq(t.joinLink.id, id)).run();
    db.$client.exec("CREATE TRIGGER no_use BEFORE UPDATE OF uses ON join_link BEGIN SELECT RAISE(ABORT, 'no'); END");
    await expect(verify(a, o.json(), 'cred-jordan').then((r) => r.statusCode)).resolves.toBe(500);
    expect(waitingPeople(db)).toEqual([]);
    expect(db.select().from(t.passkey).where(eq(t.passkey.id, 'cred-jordan')).all()).toEqual([]);
    expect(db.select().from(t.joinRequest).all()).toEqual([]);
  });

  it('the person waits: one page, signed in, and the admins see the link and the network on the list', async () => {
    const { app: a, db } = await app();
    home(db);
    const { id, token } = await makeLink(a, db);
    const v = await join(a, token, 'Jordan');
    expect(v.json()).toMatchObject({ signedIn: true, waiting: true });
    const cookie = String(v.headers['set-cookie']).split(';')[0]!;
    expect((await a.inject({ url: '/api/me', headers: { cookie } })).json()).toMatchObject({ waiting: true });
    const list = (await a.inject({ url: '/api/people/waiting', headers: { cookie: sessionCookie(db, 'p_alex') } })).json();
    expect(list).toEqual([expect.objectContaining({ name: 'Jordan', via: 'join_link', joinLink: { id, createdAt: expect.any(String), createdBy: 'Alex' }, fromHomeNetwork: true })]);
    // approved: what the request said goes, the person stays
    expect((await post(a, `/api/people/waiting/${list[0].id}/approve`, {}, { cookie: sessionCookie(db, 'p_alex') })).statusCode).toBe(200);
    expect(db.select().from(t.joinRequest).all()).toEqual([]);
    expect((await a.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
  });
});

describe('revoking, and an admin who goes', () => {
  it('revoking a link declines its waiting people, with their passkeys and sessions; another link\'s stay', async () => {
    const { app: a, db } = await app();
    home(db);
    const one = await makeLink(a, db);
    const two = await makeLink(a, db);
    const j1 = await join(a, one.token, 'Jordan');
    await join(a, one.token, 'Casey');
    await join(a, two.token, 'Morgan');
    const cookie = String(j1.headers['set-cookie']).split(';')[0]!;
    expect((await a.inject({ method: 'DELETE', url: `/api/people/join-links/${one.id}`, headers: { cookie: sessionCookie(db, 'p_alex'), origin: ORIGIN } })).statusCode).toBe(204);
    expect(waitingPeople(db).map((p) => p.name)).toEqual(['Morgan']);
    expect(db.select().from(t.passkey).all().map((k) => k.personId).filter((p) => !p.startsWith('p_'))).toHaveLength(1);
    expect((await a.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    expect((await post(a, '/api/join/open', { token: one.token })).statusCode).toBe(404);
    expect((await a.inject({ method: 'DELETE', url: `/api/people/join-links/${one.id}`, headers: { cookie: sessionCookie(db, 'p_alex'), origin: ORIGIN } })).statusCode).toBe(404);
  });

  /** A second admin, Lee, who can sign in; Lee's link, and someone who came with it. */
  async function withLee() {
    const built = await app();
    const { app: a, db } = built;
    home(db);
    db.insert(t.person).values({ id: 'p_lee', name: 'Lee', role: 'admin', handle: 'lee' }).run();
    db.insert(t.passkey).values({ id: 'pk-lee', personId: 'p_lee', publicKey: Buffer.from([1]), label: 'Lee', createdAt: new Date().toISOString() }).run();
    const lees = await makeLink(a, db, {}, 'p_lee');
    const alexs = await makeLink(a, db);
    await join(a, lees.token, 'Jordan');
    await join(a, alexs.token, 'Casey');
    return { ...built, lees, alexs };
  }

  it('an admin who stops being one takes their links along, as revoked', async () => {
    const { app: a, db, lees, alexs } = await withLee();
    const res = await a.inject({ method: 'PATCH', url: '/api/people/p_lee', headers: { cookie: sessionCookie(db, 'p_alex'), origin: ORIGIN }, payload: { role: 'adult' } });
    expect(res.statusCode).toBe(200);
    expect(db.select().from(t.joinLink).all().map((l) => l.id)).toEqual([alexs.id]);
    expect(waitingPeople(db).map((p) => p.name)).toEqual(['Casey']);
    expect((await post(a, '/api/join/open', { token: lees.token })).statusCode).toBe(404);
  });

  it('an admin who is removed takes their links along too', async () => {
    const { app: a, db, alexs } = await withLee();
    expect((await a.inject({ method: 'DELETE', url: '/api/people/p_lee', headers: { cookie: sessionCookie(db, 'p_alex'), origin: ORIGIN } })).statusCode).toBe(204);
    expect(db.select().from(t.joinLink).all().map((l) => l.id)).toEqual([alexs.id]);
    expect(waitingPeople(db).map((p) => p.name)).toEqual(['Casey']);
  });
});

describe('under HomersLab every join route answers 404', () => {
  it('the public steps and the admins\' routes alike', async () => {
    const { app: a, db } = await app(homerslab());
    home(db);
    const admin = hlHeaders('hl-alex', 'Alex', 'admin');
    const routes: [string, string, object?][] = [
      ['POST', '/api/join/open', { token: 'A'.repeat(43) }], ['POST', '/api/join/options', { token: 'A'.repeat(43), name: 'Jo' }],
      ['POST', '/api/join/verify', { challengeId: 'x', response: {} }], ['GET', '/api/people/join-links'], ['POST', '/api/people/join-links', {}],
      ['DELETE', '/api/people/join-links/jl_x'], ['GET', '/api/people/home-networks'], ['PUT', '/api/people/home-networks', { networks: [HOME] }],
    ];
    for (const [method, url, payload] of routes) {
      for (const headers of [admin, {}]) {
        const res = await a.inject({ method: method as 'GET', url, headers: { origin: ORIGIN, ...headers }, ...(payload ? { payload } : {}) });
        // the admins' routes need a person first: anonymous is 401, as for any route
        const expected = url.startsWith('/api/join/') || Object.keys(headers).length ? 404 : 401;
        expect(res.statusCode, `${method} ${url} ${JSON.stringify(headers)}`).toBe(expected);
      }
    }
    expect(db.select().from(t.joinLink).all()).toEqual([]);
  });
});

describe('at most 10 wait; a request lapses after 7 days', () => {
  it('the eleventh joiner is refused at the enrolment when the list filled after their options', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db, { uses: JOIN_LINK.maxUses });
    const late = await options(a, token, 'Late');
    for (let i = 0; i < WAITING.max; i++) db.insert(t.person).values({ id: `p_w${i}`, name: `W${i}`, role: 'adult', state: 'waiting', arrivedAt: new Date().toISOString() }).run();
    const res = await verify(a, late.json(), 'cred-late');
    expect([res.statusCode, res.json()]).toEqual([404, NOT_HERE]);
    expect(waitingPeople(db)).toHaveLength(WAITING.max);
  });

  it('a join link\'s request lapses after 7 days: the person, their passkey and session go, and a place frees', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db);
    const v = await join(a, token, 'Jordan');
    const cookie = String(v.headers['set-cookie']).split(';')[0]!;
    const id = v.json().person.id as string;
    db.update(t.person).set({ arrivedAt: new Date(Date.now() - WAITING.lapseDays * DAY - 60_000).toISOString() }).where(eq(t.person.id, id)).run();
    expect((await a.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    expect(db.select().from(t.person).where(eq(t.person.id, id)).all()).toEqual([]);
    expect(db.select().from(t.passkey).where(eq(t.passkey.personId, id)).all()).toEqual([]);
    expect(db.select().from(t.joinRequest).all()).toEqual([]);
  });

  it('a lapsed request is gone from the list and the Inbox, and frees its place on a full list', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db);
    const old = new Date(Date.now() - WAITING.lapseDays * DAY - 60_000).toISOString();
    for (let i = 0; i < WAITING.max; i++) db.insert(t.person).values({ id: `p_w${i}`, name: `W${i}`, role: 'adult', state: 'waiting', arrivedAt: i === 0 ? old : new Date().toISOString() }).run();
    expect((await post(a, '/api/join/open', { token })).statusCode).toBe(204);
    const list = (await a.inject({ url: '/api/people/waiting', headers: { cookie: sessionCookie(db, 'p_alex') } })).json();
    expect(list.map((p: { id: string }) => p.id)).not.toContain('p_w0');
    expect(list).toHaveLength(WAITING.max - 1);
  });

  it('HomersLab waiting rows lapse too; coming again after that is a new request', async () => {
    const sent: string[] = [];
    const push: Egress = { ...nowherePush, push: async (url) => { sent.push(url); return { status: 201, type: '', body: Buffer.alloc(0), url }; } };
    const db = household();
    db.insert(t.pushSubscription).values({ id: 'ps-alex', personId: 'p_alex', endpoint: 'https://fcm.googleapis.com/fcm/send/ps-alex', p256dh: RFC8291_UA_KEY, auth: 'BTBZMqHH6r4Tts7J_aSIgg', createdAt: new Date().toISOString() }).run();
    const { app: a } = await app(homerslab(), db, { push });
    await a.inject({ url: '/api/me', headers: hlHeaders('hl-alex', 'Alex', 'admin') });
    const jo = hlHeaders('hl-jo', 'Jo', 'adult');
    expect((await a.inject({ url: '/api/me', headers: jo })).statusCode).toBe(403);
    const first = waitingPeople(db)[0]!;
    db.update(t.person).set({ arrivedAt: new Date(Date.now() - WAITING.lapseDays * DAY - 60_000).toISOString() }).where(eq(t.person.id, first.id)).run();
    // nobody comes: the list and the sweep lapse it
    expect(waitingPeople(db)).toEqual([]);
    expect(db.select().from(t.person).where(eq(t.person.externalId, 'hl-jo')).all()).toEqual([]);
    // Jo comes again: a new request, and the admins are told again
    expect((await a.inject({ url: '/api/me', headers: jo })).statusCode).toBe(403);
    const again = waitingPeople(db)[0]!;
    expect(again.id).not.toBe(first.id);
    expect(Date.now() - new Date(again.arrivedAt!).getTime()).toBeLessThan(60_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(2);
  });

  it('HomersLab: a waiting row that lapsed while the person kept coming is a new request on their next one', async () => {
    const { app: a, db } = await app(homerslab());
    const jo = hlHeaders('hl-jo', 'Jo', 'adult');
    await a.inject({ url: '/api/me', headers: jo });
    const first = waitingPeople(db)[0]!;
    db.update(t.person).set({ arrivedAt: new Date(Date.now() - WAITING.lapseDays * DAY - 60_000).toISOString() }).where(eq(t.person.id, first.id)).run();
    expect((await a.inject({ url: '/api/me', headers: jo })).statusCode).toBe(403);
    const rows = db.select().from(t.person).where(eq(t.person.externalId, 'hl-jo')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(first.id);
  });
});

describe('join pushes under HomersLab: only to admins the edge still sends', () => {
  it('an admin the edge has not sent for JOIN_PUSH.seenDays gets no join push; one it sends does', async () => {
    const sent: string[] = [];
    const push: Egress = { ...nowherePush, push: async (url) => { sent.push(url); return { status: 201, type: '', body: Buffer.alloc(0), url }; } };
    const db = household();
    db.insert(t.person).values({ id: 'p_gone', externalId: 'hl-gone', name: 'Gone', role: 'admin', handle: 'gone', seenAt: new Date(Date.now() - (JOIN_PUSH.seenDays + 1) * DAY).toISOString() }).run();
    const sub = (id: string, personId: string) => ({ id, personId, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, p256dh: RFC8291_UA_KEY, auth: 'BTBZMqHH6r4Tts7J_aSIgg', createdAt: new Date().toISOString() });
    db.insert(t.pushSubscription).values([sub('ps-alex', 'p_alex'), sub('ps-gone', 'p_gone')]).run();
    const { app: a } = await app(homerslab(), db, { push });
    await a.inject({ url: '/api/me', headers: hlHeaders('hl-alex', 'Alex', 'admin') });
    expect(db.select().from(t.person).where(eq(t.person.id, 'p_alex')).get()!.seenAt).toEqual(expect.any(String));
    await a.inject({ url: '/api/me', headers: hlHeaders('hl-new', 'New', 'adult') });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual(['https://fcm.googleapis.com/fcm/send/ps-alex']);
  });

  it('standalone: a joiner tells every admin (removed admins are gone there)', async () => {
    const sent: string[] = [];
    const push: Egress = { ...nowherePush, push: async (url) => { sent.push(url); return { status: 201, type: '', body: Buffer.alloc(0), url }; } };
    const db = household();
    db.insert(t.pushSubscription).values({ id: 'ps-alex', personId: 'p_alex', endpoint: 'https://fcm.googleapis.com/fcm/send/ps-alex', p256dh: RFC8291_UA_KEY, auth: 'BTBZMqHH6r4Tts7J_aSIgg', createdAt: new Date().toISOString() }).run();
    const { app: a } = await app(standalone(), db, { push });
    home(db);
    const { token } = await makeLink(a, db);
    await join(a, token, 'Jordan');
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual(['https://fcm.googleapis.com/fcm/send/ps-alex']);
  });
});
