// Rules: the location rule and automatic acceptance (ADR 0011, philobiblos#34 slice 3), and the client address behind
// PHILOBIBLOS_TRUSTED_PROXY. The forwarded address counts only from the trusted proxy, right-most untrusted entry first;
// a forged X-Forwarded-For from anywhere else is ignored, and a trusted proxy that sends none it can read fails closed.
// Rules only narrow (a link's add to the household's networks); a match on a link that accepts automatically is an adult
// at once, never an admin; others wait or, outside the networks, are refused. Every name, id and address is invented.
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { RULE_ROLE } from '../src/household/join-links';
import { waitingPeople } from '../src/household/waiting';
import { readSurroundings, surroundingsFrom, surroundingsWarning, type Surroundings, type System } from '../src/net/networks';
import { TRUSTED_PROXY, clientAddress, parseTrustedProxy } from '../src/net/proxy';
import { JOIN_OPEN, NOT_HERE } from '../src/routes/join';
import { ORIGIN, TEST_SEALING_KEY, fakeWebAuthn, household, nowherePush, sessionCookie } from './helpers';

const PROXY = '127.0.0.1';
const standalone = (proxy?: string) => loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY, ...(proxy ? { PHILOBIBLOS_TRUSTED_PROXY: proxy } : {}) });
const homerslab = () => loadConfig({ PHILOBIBLOS_MODE: 'homerslab', PHILOBIBLOS_EDGE_IDENTITY: 'homerslab-v1', PHILOBIBLOS_TRUSTED_PROXY: PROXY, PHILOBIBLOS_ORIGIN: ORIGIN, PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY });

/** The household's network, two parts of it, a client in each, and an address outside it. */
const HOME = '10.20.0.0/16';
const KITCHEN = '10.20.1.0/24';
const IN_KITCHEN = '10.20.1.5';
const IN_GARDEN = '10.20.2.5';
const AWAY = '198.51.100.7';

const HOST: Surroundings = { container: false, known: true, hops: [], onLink: [] };
let open: BuiltApp[] = [];
async function app(cfg = standalone(), db = household(), surroundings: Surroundings = HOST) {
  const b = await buildApp(cfg, db, { webauthn: fakeWebAuthn(), push: nowherePush, joinFloorMs: 0, surroundings });
  await b.app.ready();
  open.push(b);
  return { ...b, db };
}
afterEach(async () => { for (const b of open) await b.app.close(); open = []; });

const home = (db: Db, cidr = HOME) => db.insert(t.homeNetwork).values({ cidr, addedBy: 'p_alex', addedAt: new Date().toISOString() }).run();
type From = { remote?: string; xff?: string; cookie?: string };
const post = (a: BuiltApp['app'], url: string, payload: object, o: From = {}) => a.inject({
  method: 'POST', url, payload, remoteAddress: o.remote ?? IN_KITCHEN,
  headers: { origin: ORIGIN, ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.xff !== undefined ? { 'x-forwarded-for': o.xff } : {}) },
});
async function makeLink(a: BuiltApp['app'], db: Db, body: object = {}) {
  const res = await post(a, '/api/people/join-links', body, { cookie: sessionCookie(db, 'p_alex') });
  expect(res.statusCode, res.body).toBe(201);
  const { id, url } = res.json() as { id: string; url: string };
  return { id, token: url.split('#')[1]! };
}
/** The options, then the fake authenticator's enrolment, from one place; extra fields ride along in both bodies. */
async function join(a: BuiltApp['app'], token: string, name: string, from: From = {}, extra: object = {}) {
  const o = await post(a, '/api/join/options', { token, name, ...extra }, from);
  if (o.statusCode !== 200) return o;
  const s = o.json() as { challengeId: string; options: { challenge: string } };
  return post(a, '/api/join/verify', { challengeId: s.challengeId, response: { id: `cred-${name}-${Math.random()}`, challenge: s.options.challenge }, label: 'Phone', ...extra }, from);
}
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]!;
const personNamed = (db: Db, name: string) => db.select().from(t.person).where(eq(t.person.name, name)).all();

describe('PHILOBIBLOS_TRUSTED_PROXY: exact addresses or narrow ranges, checked at start', () => {
  it('takes addresses and CIDRs, comma-separated; unset or empty is none', () => {
    expect(parseTrustedProxy(undefined)).toBeNull();
    expect(parseTrustedProxy(' ')).toBeNull();
    expect(standalone().trustedProxy).toBeNull();
    expect(parseTrustedProxy('127.0.0.1, 172.21.1.11,fd00::5, 192.0.2.77/24, 2001:db8:1:2::/64')!.map((c) => c.cidr))
      .toEqual(['127.0.0.1/32', '172.21.1.11/32', 'fd00::5/128', '192.0.2.0/24', '2001:db8:1:2::/64']);
  });

  it('refuses anything else, so Philobiblos does not start', () => {
    const bad = ['proxy.example.org', '0.0.0.0', '::', '0.0.0.0/0', '::/0', '10.0.0.0/8', '192.0.2.0/23', '2001:db8::/48', '127.0.0.1,', ',127.0.0.1',
      '127.0.0.1:8080', '[::1]', '::ffff:127.0.0.1', 'fe80::1%eth0', '127.0.0.1 10.0.0.1', Array.from({ length: TRUSTED_PROXY.max + 1 }, (_, i) => `192.0.2.${i + 1}`).join(',')];
    for (const v of bad) {
      expect(() => parseTrustedProxy(v), v).toThrow(/PHILOBIBLOS_TRUSTED_PROXY/);
      expect(() => standalone(v), v).toThrow(/PHILOBIBLOS_TRUSTED_PROXY/);
    }
  });
});

describe('the client address: forwarded only by the trusted proxy, right-most untrusted entry', () => {
  const list = parseTrustedProxy('127.0.0.1, 10.9.9.9');

  it('from anywhere else it is the connection\'s, whatever X-Forwarded-For says (a forged one is ignored)', () => {
    expect(clientAddress(null, AWAY, IN_KITCHEN)).toBe(AWAY);
    expect(clientAddress(null, PROXY, IN_KITCHEN)).toBe(PROXY);
    expect(clientAddress(list, AWAY, IN_KITCHEN)).toBe(AWAY);
    expect(clientAddress(list, `::ffff:${AWAY}`, IN_KITCHEN)).toBe(AWAY);
    expect(clientAddress(list, undefined, IN_KITCHEN)).toBeNull();
  });

  it('from the trusted proxy, the entry it appended: never the left-most, which the client wrote', () => {
    expect(clientAddress(list, PROXY, IN_KITCHEN)).toBe(IN_KITCHEN);
    expect(clientAddress(list, `::ffff:${PROXY}`, IN_KITCHEN)).toBe(IN_KITCHEN);
    expect(clientAddress(list, PROXY, `${IN_KITCHEN}, ${AWAY}`)).toBe(AWAY);
    // a chain of our own proxies is passed over; the first one that is not ours is the client
    expect(clientAddress(list, PROXY, `${IN_KITCHEN}, ${AWAY}, 10.9.9.9`)).toBe(AWAY);
    expect(clientAddress(list, PROXY, `garbage, ${IN_KITCHEN}`)).toBe(IN_KITCHEN); // left of the client: never read
    expect(clientAddress(list, PROXY, [IN_KITCHEN, AWAY])).toBe(AWAY); // repeated headers, in order
    expect(clientAddress(list, PROXY, `::ffff:${IN_KITCHEN}`)).toBe(IN_KITCHEN);
    expect(clientAddress(list, PROXY, '2001:db8::7')).toBe('2001:db8::7');
  });

  it('a trusted proxy that sends none, or one that cannot be read, names no one (fail closed)', () => {
    for (const xff of [undefined, '', ' ', ',', `${IN_KITCHEN},`, `${IN_KITCHEN}, `, `${IN_KITCHEN}:5000`, `[2001:db8::7]`, '[2001:db8::7]:443', 'fe80::1%eth0',
      'unknown', 'client.example.org', `${IN_KITCHEN} ${AWAY}`, PROXY, `${AWAY}, 10.9.9.9, ${PROXY}x`, `1.2.3.4, ${'9'.repeat(TRUSTED_PROXY.headerMax)}`, `${PROXY}, 10.9.9.9`]) {
      expect(clientAddress(list, PROXY, xff), String(xff)).toBeNull();
    }
    expect(clientAddress(list, PROXY, `${' '.repeat(TRUSTED_PROXY.headerMax)}${IN_KITCHEN}`)).toBeNull();
  });
});

describe('the join routes behind the trusted proxy', () => {
  it('the forwarded client is on the home network: the link opens, and the person waits', async () => {
    const { app: a, db } = await app(standalone(PROXY));
    home(db);
    const { token } = await makeLink(a, db);
    expect((await post(a, '/api/join/open', { token }, { remote: PROXY, xff: IN_KITCHEN })).statusCode).toBe(204);
    const v = await join(a, token, 'Jordan', { remote: PROXY, xff: IN_KITCHEN });
    expect(v.json()).toMatchObject({ waiting: true });
    expect(waitingPeople(db).map((p) => p.name)).toEqual(['Jordan']);
  });

  it('a forged X-Forwarded-For from anywhere but the trusted proxy is ignored, at every step', async () => {
    for (const cfg of [standalone(), standalone(PROXY)]) {
      const { app: a, db } = await app(cfg);
      home(db);
      const { token } = await makeLink(a, db);
      for (const url of ['/api/join/open', '/api/join/options']) {
        const res = await post(a, url, { token, name: 'Jordan' }, { remote: AWAY, xff: IN_KITCHEN });
        expect([res.statusCode, res.json()], url).toEqual([404, NOT_HERE]);
      }
      // the step taken from home, the enrolment sent from away with home's address forged: refused
      const o = await post(a, '/api/join/options', { token, name: 'Jordan' }, { remote: IN_KITCHEN });
      expect(o.statusCode).toBe(200);
      const s = o.json();
      const v = await post(a, '/api/join/verify', { challengeId: s.challengeId, response: { id: 'cred-j', challenge: s.options.challenge } }, { remote: AWAY, xff: IN_KITCHEN });
      expect(v.statusCode).toBe(404);
      expect(waitingPeople(db)).toEqual([]);
    }
  });

  it('the trusted proxy\'s left-most entry (the client\'s own) is never believed', async () => {
    const { app: a, db } = await app(standalone(PROXY));
    home(db);
    const { token } = await makeLink(a, db);
    expect((await post(a, '/api/join/open', { token }, { remote: PROXY, xff: `${IN_KITCHEN}, ${AWAY}` })).statusCode).toBe(404);
  });

  it('a trusted proxy that sends no address, or a garbled one, opens nothing', async () => {
    const { app: a, db } = await app(standalone(PROXY));
    home(db);
    const { token } = await makeLink(a, db);
    for (const xff of [undefined, '', 'nonsense', `${IN_KITCHEN}:5000`, `${IN_KITCHEN}, `, PROXY]) {
      const res = await post(a, '/api/join/open', { token }, { remote: PROXY, xff });
      expect([res.statusCode, res.json()], String(xff)).toEqual([404, NOT_HERE]);
    }
  });

  it('a forwarded hop is still a hop: a proxy beside the container forwarding the container\'s own network opens nothing', async () => {
    const docker = surroundingsFrom({ container: true, interfaces: [{ cidr: '172.17.0.2/16', internal: false }], route: 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000', ipv6Route: '' });
    const { app: a, db } = await app(standalone('172.17.0.5'), household(), docker);
    home(db);
    const { token } = await makeLink(a, db);
    expect((await post(a, '/api/join/open', { token }, { remote: '172.17.0.5', xff: IN_KITCHEN })).statusCode).toBe(204);
    expect((await post(a, '/api/join/open', { token }, { remote: '172.17.0.5', xff: '172.17.0.9' })).statusCode).toBe(404);
    expect((await post(a, '/api/join/open', { token }, { remote: '172.17.0.5', xff: '127.0.0.1' })).statusCode).toBe(404);
    expect((await post(a, '/api/join/open', { token }, { remote: '172.17.0.6', xff: IN_KITCHEN })).statusCode).toBe(404);
  });

  it('limits count the forwarded client; whoever the proxy names no one for counts as the proxy', async () => {
    const { app: a, db } = await app(standalone(PROXY));
    home(db);
    const tokens = Array.from({ length: JOIN_OPEN.max + 1 }, (_, i) => `t${i}`.padEnd(43, 'x'));
    for (const token of tokens.slice(0, JOIN_OPEN.max)) expect((await post(a, '/api/join/open', { token }, { remote: PROXY, xff: IN_KITCHEN })).statusCode).toBe(404);
    expect((await post(a, '/api/join/open', { token: tokens.at(-1) }, { remote: PROXY, xff: IN_KITCHEN })).statusCode).toBe(429);
    expect((await post(a, '/api/join/open', { token: tokens.at(-1) }, { remote: PROXY, xff: IN_GARDEN })).statusCode).toBe(404);
    for (const token of tokens.slice(0, JOIN_OPEN.max)) expect((await post(a, '/api/join/open', { token: `${token}y` }, { remote: PROXY, xff: 'garbled' })).statusCode).toBe(404);
    expect((await post(a, '/api/join/open', { token: 'z'.repeat(43) }, { remote: PROXY })).statusCode).toBe(429);
  });

  it('People: behind the trusted proxy the admin is seen as themselves; without its address, behind a proxy', async () => {
    const { app: a, db } = await app(standalone(PROXY));
    const view = async (xff?: string, remote = PROXY) => (await a.inject({ url: '/api/people/home-networks', remoteAddress: remote, headers: { cookie: sessionCookie(db, 'p_alex'), ...(xff ? { 'x-forwarded-for': xff } : {}) } })).json();
    expect(await view('192.168.1.23')).toMatchObject({ behindProxy: false, proposal: '192.168.1.0/24', trustedProxy: true, surroundings: 'known' });
    expect(await view()).toMatchObject({ behindProxy: true, proposal: null, trustedProxy: true });
    expect(await view('192.168.1.23', '127.0.0.2')).toMatchObject({ behindProxy: true, proposal: null }); // loopback, not ours
    const plain = await app();
    expect((await plain.app.inject({ url: '/api/people/home-networks', remoteAddress: PROXY, headers: { cookie: sessionCookie(plain.db, 'p_alex'), 'x-forwarded-for': '192.168.1.23' } })).json())
      .toMatchObject({ behindProxy: true, proposal: null, trustedProxy: false });
  });
});

describe('surroundings that cannot be read fail closed, and say why', () => {
  const sys = (o: Partial<System> & { files?: Record<string, string | Error> } = {}): System => ({
    exists: (p) => p === '/.dockerenv',
    interfaces: () => [{ cidr: '172.17.0.2/16', internal: false }],
    read: (p) => {
      const f = o.files?.[p] ?? (p === '/proc/net/route' ? 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n' : '');
      if (f instanceof Error) throw f;
      return f;
    },
    ...o,
  });
  const enoent = () => Object.assign(new Error('no such file'), { code: 'ENOENT' });

  it('a container that reads both route tables knows its surroundings', () => {
    expect(readSurroundings(sys())).toMatchObject({ container: true, known: true });
    expect(readSurroundings(sys()).unknown).toBeUndefined();
  });

  it('ipv6.disable=1 (no /proc/net/ipv6_route): every address a hop, the reason named for the log and People', () => {
    const s = readSurroundings(sys({ files: { '/proc/net/ipv6_route': enoent() } }));
    expect(s).toEqual({ container: true, known: false, hops: [], onLink: [], unknown: 'no-ipv6-route' });
    expect(surroundingsWarning(s)).toMatch(/ipv6\.disable=1.*no join link opens/);
  });

  it('any other failure in a container fails closed too (the catch never says known)', () => {
    for (const s of [
      readSurroundings(sys({ files: { '/proc/net/route': enoent() } })),
      readSurroundings(sys({ files: { '/proc/net/ipv6_route': Object.assign(new Error('denied'), { code: 'EACCES' }) } })),
      readSurroundings(sys({ interfaces: () => { throw new Error('no interfaces'); } })),
    ]) {
      expect(s).toEqual({ container: true, known: false, hops: [], onLink: [], unknown: 'unreadable' });
      expect(surroundingsWarning(s)).toMatch(/no join link opens/);
    }
    expect(surroundingsWarning(readSurroundings(sys()))).toBeNull();
  });

  it('on a host, missing route tables are only no next hops', () => {
    const s = readSurroundings(sys({ exists: () => false, files: { '/proc/net/route': enoent(), '/proc/net/ipv6_route': enoent() } }));
    expect(s).toMatchObject({ container: false, known: true, hops: [] });
  });

  it('People tells the admin why no link opens', async () => {
    const { app: a, db } = await app(standalone(PROXY), household(), readSurroundings(sys({ files: { '/proc/net/ipv6_route': enoent() } })));
    home(db);
    const view = (await a.inject({ url: '/api/people/home-networks', remoteAddress: PROXY, headers: { cookie: sessionCookie(db, 'p_alex'), 'x-forwarded-for': IN_KITCHEN } })).json();
    expect(view).toMatchObject({ behindProxy: true, surroundings: 'no-ipv6-route' });
    const { token } = await makeLink(a, db);
    expect((await post(a, '/api/join/open', { token }, { remote: PROXY, xff: IN_KITCHEN })).statusCode).toBe(404);
  });
});

describe('a link\'s rules', () => {
  it('by default: the household\'s networks and approval; the list shows each link\'s rules', async () => {
    const { app: a, db } = await app();
    home(db);
    await makeLink(a, db);
    await makeLink(a, db, { accept: 'automatic', nonMatches: 'refuse', networks: ['10.20.1.77/24'] });
    const list = (await a.inject({ url: '/api/people/join-links', headers: { cookie: sessionCookie(db, 'p_alex') } })).json();
    expect(list.map((l: { accept: string; nonMatches: string; networks: string[] | null }) => [l.accept, l.nonMatches, l.networks]))
      .toEqual(expect.arrayContaining([['approval', 'wait', null], ['automatic', 'refuse', [KITCHEN]]]));
  });

  it('accepting automatically: whoever matches is an adult at once, with immediate use; the use is counted', async () => {
    const { app: a, db } = await app();
    home(db);
    const { id, token } = await makeLink(a, db, { accept: 'automatic' });
    const v = await join(a, token, 'Jordan');
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ signedIn: true, waiting: false, person: { name: 'Jordan', role: 'adult' } });
    const cookie = cookieOf(v);
    for (const url of ['/api/me', '/api/settings', '/api/me/passkeys']) {
      expect((await a.inject({ url, headers: { cookie } })).statusCode, url).toBe(200);
    }
    const [p] = personNamed(db, 'Jordan');
    expect(p).toMatchObject({ state: 'active', role: RULE_ROLE, handle: expect.any(String) });
    expect(RULE_ROLE).toBe('adult');
    expect(db.select().from(t.joinRequest).all()).toEqual([]);
    expect(db.select().from(t.joinLink).where(eq(t.joinLink.id, id)).get()!.uses).toBe(1);
    expect(waitingPeople(db)).toEqual([]);
  });

  it('a waiting one has nothing: on a link that waits for approval, a match waits too', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db, { networks: [KITCHEN] });
    const v = await join(a, token, 'Jordan');
    expect(v.json()).toMatchObject({ waiting: true });
    for (const url of ['/api/settings', '/api/people/waiting']) expect((await a.inject({ url, headers: { cookie: cookieOf(v) } })).statusCode, url).toBe(403);
    const list = (await a.inject({ url: '/api/people/waiting', headers: { cookie: sessionCookie(db, 'p_alex') } })).json();
    expect(list).toEqual([expect.objectContaining({ name: 'Jordan', fromHomeNetwork: true, matchesRules: true })]);
  });

  it('a link\'s own ranges narrow it: outside them a person waits, or is refused when the link refuses non-matches', async () => {
    const { app: a, db } = await app();
    home(db);
    const waits = await makeLink(a, db, { accept: 'automatic', networks: [KITCHEN] });
    expect((await join(a, waits.token, 'Kit', { remote: IN_KITCHEN })).json()).toMatchObject({ waiting: false });
    expect((await join(a, waits.token, 'Gale', { remote: IN_GARDEN })).json()).toMatchObject({ waiting: true });
    const list = (await a.inject({ url: '/api/people/waiting', headers: { cookie: sessionCookie(db, 'p_alex') } })).json();
    expect(list).toEqual([expect.objectContaining({ name: 'Gale', matchesRules: false })]);
    const refuses = await makeLink(a, db, { accept: 'automatic', nonMatches: 'refuse', networks: [KITCHEN] });
    for (const url of ['/api/join/open', '/api/join/options']) {
      const res = await post(a, url, { token: refuses.token, name: 'Gale' }, { remote: IN_GARDEN });
      expect([res.statusCode, res.json()], url).toEqual([404, NOT_HERE]);
    }
    expect((await post(a, '/api/join/open', { token: refuses.token }, { remote: IN_KITCHEN })).statusCode).toBe(204);
  });

  it('outside the household\'s networks everyone is refused, whatever the link says', async () => {
    const { app: a, db } = await app();
    home(db);
    for (const body of [{}, { accept: 'automatic' }, { nonMatches: 'wait' }, { accept: 'automatic', networks: [KITCHEN] }]) {
      const { token } = await makeLink(a, db, body);
      const res = await post(a, '/api/join/options', { token, name: 'Jordan' }, { remote: AWAY });
      expect([res.statusCode, res.json()], JSON.stringify(body)).toEqual([404, NOT_HERE]);
    }
  });

  it('the rules are judged again at the enrolment: a range dropped since the options lets no one in', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db, { accept: 'automatic' });
    const o = await post(a, '/api/join/options', { token, name: 'Jordan' });
    db.delete(t.homeNetwork).run();
    const s = o.json();
    expect((await post(a, '/api/join/verify', { challengeId: s.challengeId, response: { id: 'cred-j', challenge: s.options.challenge } })).statusCode).toBe(404);
    expect(personNamed(db, 'Jordan')).toEqual([]);
  });
});

describe('a household rule cannot be loosened by a link', () => {
  const cookie = (db: Db) => ({ cookie: sessionCookie(db, 'p_alex') });

  it('a link\'s ranges must lie inside the household\'s networks; none means all of them, never anywhere', async () => {
    const { app: a, db } = await app();
    home(db);
    for (const networks of [['10.0.0.0/8'], ['10.20.0.0/15'], ['192.0.2.0/24'], [KITCHEN, '192.0.2.0/24'], [], ['0.0.0.0/0'], ['anywhere'], 'anywhere', [7], ['127.0.0.0/8'],
      Array.from({ length: 21 }, (_, i) => `10.20.${i}.0/24`)]) {
      expect((await post(a, '/api/people/join-links', { networks }, cookie(db))).statusCode, JSON.stringify(networks)).toBe(400);
    }
    expect(db.select().from(t.joinLink).all()).toEqual([]);
    expect((await post(a, '/api/people/join-links', { networks: [HOME] }, cookie(db))).statusCode).toBe(201);
  });

  it('with no home network a link with its own ranges cannot be made either', async () => {
    const { app: a, db } = await app();
    expect((await post(a, '/api/people/join-links', { accept: 'automatic', networks: [KITCHEN] }, cookie(db))).statusCode).toBe(409);
  });

  it('the household\'s networks shrink after a link is made: the link\'s ranges outside them open for no one', async () => {
    const { app: a, db } = await app();
    home(db);
    home(db, '192.0.2.0/24');
    const { token } = await makeLink(a, db, { accept: 'automatic', networks: [KITCHEN] });
    expect((await a.inject({ method: 'PUT', url: '/api/people/home-networks', headers: { ...cookie(db), origin: ORIGIN }, payload: { networks: ['192.0.2.0/24'] } })).statusCode).toBe(200);
    expect((await post(a, '/api/join/open', { token }, { remote: IN_KITCHEN })).statusCode).toBe(404);
    // in the household's networks, not the link's: a non-match, who waits (the link lets non-matches wait)
    expect((await join(a, token, 'Gale', { remote: '192.0.2.9' })).json()).toMatchObject({ waiting: true });
  });

  it('stored ranges wider than the household\'s never widen it; ones that do not parse match no one', async () => {
    const { app: a, db } = await app();
    home(db);
    const wide = await makeLink(a, db, { accept: 'automatic', networks: [KITCHEN] });
    db.update(t.joinLink).set({ networksJson: JSON.stringify(['198.51.100.0/24', '10.0.0.0/8']) }).where(eq(t.joinLink.id, wide.id)).run();
    expect((await post(a, '/api/join/open', { token: wide.token }, { remote: AWAY })).statusCode).toBe(404);
    expect((await join(a, wide.token, 'Kit', { remote: IN_GARDEN })).json()).toMatchObject({ waiting: false }); // inside both
    const broken = await makeLink(a, db, { accept: 'automatic', networks: [KITCHEN] });
    for (const json of ['not json', '"10.20.0.0/16"', '["10.20.1.0/24", "nonsense"]', '{}']) {
      db.update(t.joinLink).set({ networksJson: json }).where(eq(t.joinLink.id, broken.id)).run();
      const v = await join(a, broken.token, `Gale ${json.length}`, { remote: IN_KITCHEN });
      expect(v.json(), json).toMatchObject({ waiting: true });
    }
  });
});

describe('a match can never make an admin', () => {
  it('whatever the bodies say, whatever name, whoever is an admin or not: always an adult', async () => {
    const { app: a, db } = await app();
    home(db);
    const extras = [{}, { role: 'admin' }, { role: 'admin', admin: true, state: 'active' }, { person: { role: 'admin' } }, { ceiling: 'admin' }];
    const names = ['Alex', 'admin', 'Admin', 'Robin'];
    let i = 0;
    for (const extra of extras) {
      for (const name of names) {
        const { token } = await makeLink(a, db, { accept: 'automatic' });
        const n = i++;
        const v = await join(a, token, n ? `${name} ${n}` : name, { remote: `10.20.3.${n + 1}` }, extra);
        expect(v.statusCode, JSON.stringify([name, extra])).toBe(200);
        expect(v.json().person.role).toBe('adult');
      }
    }
    const roles = db.select({ role: t.person.role, name: t.person.name }).from(t.person).all();
    expect(roles.filter((r) => r.role === 'admin').map((r) => r.name)).toEqual(['Alex']);
  });

  it('a link that would make an admin cannot be made', async () => {
    const { app: a, db } = await app();
    home(db);
    for (const body of [{ accept: 'automatic', role: 'admin' }, { accept: 'admin' }, { accept: 'automatic', as: 'admin' }, { accept: ['automatic'] }]) {
      expect((await post(a, '/api/people/join-links', body, { cookie: sessionCookie(db, 'p_alex') })).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('a household left with no admin still gets an adult (no lock-out rescue through a rule)', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db, { accept: 'automatic' });
    db.update(t.person).set({ role: 'adult' }).where(eq(t.person.id, 'p_alex')).run(); // by hand, past the last-admin rule
    const v = await join(a, token, 'Jordan');
    expect(v.json().person.role).toBe('adult');
    expect(db.select().from(t.person).where(eq(t.person.role, 'admin')).all()).toEqual([]);
  });

  it('the person a rule let in cannot raise themselves: approving, roles and links are an admin\'s', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db, { accept: 'automatic' });
    const v = await join(a, token, 'Jordan');
    const cookie = cookieOf(v);
    const me = v.json().person.id as string;
    const h = { cookie, origin: ORIGIN };
    expect((await a.inject({ method: 'PATCH', url: `/api/people/${me}`, headers: h, payload: { role: 'admin' } })).statusCode).toBe(403);
    expect((await a.inject({ method: 'POST', url: `/api/people/waiting/${me}/approve`, headers: h, payload: { role: 'admin' } })).statusCode).toBe(403);
    expect((await a.inject({ method: 'POST', url: '/api/people/join-links', headers: h, payload: { accept: 'automatic' } })).statusCode).toBe(403);
    expect(personNamed(db, 'Jordan')[0]!.role).toBe('adult');
  });

  it('an admin\'s passkey presented at the enrolment signs no one in as them', async () => {
    const { app: a, db } = await app();
    home(db);
    const { token } = await makeLink(a, db, { accept: 'automatic' });
    const o = (await post(a, '/api/join/options', { token, name: 'Jordan' })).json();
    const v = await post(a, '/api/join/verify', { challengeId: o.challengeId, response: { id: 'pk1', challenge: o.options.challenge } });
    expect(v.statusCode).toBe(409);
    expect(v.headers['set-cookie']).toBeUndefined();
    expect(personNamed(db, 'Jordan')).toEqual([]);
  });

  it('under HomersLab no rule applies: a Homeward adult on the home network waits, and the location rule is not offered', async () => {
    const { app: a, db } = await app(homerslab());
    home(db);
    const res = await a.inject({ url: '/api/me', remoteAddress: PROXY, headers: { 'x-homerslab-person': 'hl-new', 'x-homerslab-name': 'Jordan', 'x-homerslab-role': 'adult', 'x-forwarded-for': IN_KITCHEN } });
    expect(res.statusCode).toBe(403);
    expect(personNamed(db, 'Jordan')).toEqual([expect.objectContaining({ state: 'waiting', role: 'adult' })]);
    const admin = { 'x-homerslab-person': 'hl-alex', 'x-homerslab-name': 'Alex', 'x-homerslab-role': 'admin', origin: ORIGIN };
    expect((await a.inject({ url: '/api/people/home-networks', remoteAddress: PROXY, headers: admin })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: '/api/people/join-links', remoteAddress: PROXY, headers: admin, payload: { accept: 'automatic', networks: [KITCHEN] } })).statusCode).toBe(404);
  });
});
