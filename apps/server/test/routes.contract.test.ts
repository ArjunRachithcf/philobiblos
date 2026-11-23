// Every operation of contracts/openapi.yaml is served, and only those; each answers with a status the spec declares
// and a body that validates against the spec's schema for it; and the security schemes hold (deny by default).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { EDGE_IDENTITY, loadConfig } from '../src/config';
import * as t from '../src/db/schema';
import { seal } from '../src/household/sealed';
import { mailView } from '../src/mail/oauth';
import type { FormEgress } from '../src/net/egress';
import { ORIGIN, RFC8291_UA_KEY, TEST_SEALING_KEY, expectValid, nowherePush, fakeWebAuthn, household, inboxItems, isPublic, ops, request, security, sessionCookie } from './helpers';

/** The mailbox with XOAUTH2 (the admin's own OAuth client, invented here), so POST /mail/oauth/* can answer. */
const XOAUTH2 = {
  PHILOBIBLOS_IMAP_HOST: 'imap.example.org', PHILOBIBLOS_IMAP_USER: 'shelf@example.org', PHILOBIBLOS_IMAP_AUTH: 'xoauth2', PHILOBIBLOS_IMAP_OAUTH_CLIENT_ID: 'contract-client',
  PHILOBIBLOS_IMAP_OAUTH_AUTHORIZE_URL: 'https://auth.example.org/authorize', PHILOBIBLOS_IMAP_OAUTH_TOKEN_URL: 'https://auth.example.org/token', PHILOBIBLOS_IMAP_OAUTH_SCOPE: 'mail.read offline_access',
};
const standalone = () => loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY, ...XOAUTH2 });
/** Its token endpoint, a stand-in: every code and refresh token is good. */
const tokenEndpoint: FormEgress = { form: async (url) => ({ status: 200, type: 'application/json', url, body: Buffer.from(JSON.stringify({ access_token: 'contract-access', refresh_token: 'contract-refresh', token_type: 'Bearer', expires_in: 3600 })) }) };
const homerslab = () => loadConfig({ PHILOBIBLOS_MODE: 'homerslab', PHILOBIBLOS_EDGE_IDENTITY: 'homerslab-v1', PHILOBIBLOS_TRUSTED_PROXY: '127.0.0.1', PHILOBIBLOS_ORIGIN: ORIGIN, PHILOBIBLOS_DATA_DIR: '/nonexistent' });
const HL_ADULT = { 'x-homerslab-person': 'hl-sam', 'x-homerslab-name': 'Sam', 'x-homerslab-role': 'adult' };
const HL_KID = { 'x-homerslab-person': 'hl-kid', 'x-homerslab-name': 'Kid 1', 'x-homerslab-role': 'kid' };

let built: BuiltApp;
let db0: ReturnType<typeof household>;
let admin: string;
let adult: string;
let kid: string;
beforeAll(async () => {
  db0 = household();
  inboxItems(db0);
  seal(db0, Buffer.from(TEST_SEALING_KEY, 'base64'), 'bookshop_email', 'orders@bookshop.example');
  // A plain list made in February (no-shop mode), a book of it still to buy, for PUT /orders/{id}/lines/{bookId}.
  // (Its own book: one in a composed order is no candidate for this month's picks, which POST /orders needs.)
  db0.insert(t.book).values({ id: 'b_tap', title: 'Paper Boats of the Commons', authorsJson: '[]', audience: 'adult', normKey: 'boats', createdAt: new Date().toISOString() }).run();
  db0.insert(t.order).values({ id: 'o_tap', month: '2026-02', status: 'drafted', createdAt: new Date().toISOString() }).run();
  db0.insert(t.orderLine).values({ orderId: 'o_tap', bookId: 'b_tap', forPerson: 'p_alex', estimateC: 2500 }).run();
  admin = sessionCookie(db0, 'p_alex');
  adult = sessionCookie(db0, 'p_sam');
  kid = sessionCookie(db0, 'p_kid1');
  // A device of Alex's for DELETE /push/subscriptions/{id}; the pushes go nowhere (a stand-in push client).
  db0.insert(t.pushSubscription).values({ id: 'ps_alex', personId: 'p_alex', endpoint: 'https://fcm.googleapis.com/fcm/send/contract', p256dh: RFC8291_UA_KEY, auth: 'BTBZMqHH6r4Tts7J_aSIgg', createdAt: new Date().toISOString() }).run();
  built = await buildApp(standalone(), db0, { webauthn: fakeWebAuthn(), push: nowherePush, mailOAuth: { egress: tokenEndpoint } });
  await built.app.ready();
});
afterAll(() => built.app.close());

const outsider = () => {
  db0.insert(t.person).values({ id: 'p_out', name: 'Pat', role: 'adult', handle: 'pat' }).run();
  return sessionCookie(db0, 'p_out');
};

describe('contracts/openapi.yaml', () => {
  it('the server has exactly the spec\'s routes', () => {
    const specRoutes = ops.map((o) => `${o.method} /api${o.path.replace(/\{(\w+)\}/g, ':$1')}`).sort();
    const appRoutes = built.apiRoutes.map((r) => `${r.method} ${r.url}`).sort();
    expect(appRoutes).toEqual(specRoutes);
  });

  // In spec order, signed in as the household's admin (public operations without the cookie).
  it.each(ops.map((o) => [`${o.method} ${o.path} (${o.op.operationId})`, o] as const))('%s', async (_name, o) => {
    const req = request(o);
    // Signing out everywhere would end the admin's sessions for the operations after it: someone else signs out.
    const cookie = o.op.operationId === 'signOutEverywhere' ? outsider() : admin;
    // Connecting the mailbox names what Settings showed, and its finish a state its start made.
    const start = async () => {
      const accept = mailView(db0, standalone()).oauth!.allowsVersion;
      return (await built.app.inject({ method: 'POST', url: '/api/mail/oauth/start', headers: { cookie, origin: ORIGIN }, payload: { accept } })).json() as { authorizeUrl: string };
    };
    if (o.op.operationId === 'startMailOAuth') req.payload = JSON.stringify({ accept: mailView(db0, standalone()).oauth!.allowsVersion });
    if (o.op.operationId === 'finishMailOAuth') req.payload = JSON.stringify({ state: new URL((await start()).authorizeUrl).searchParams.get('state'), code: 'contract-code' });
    const res = await built.app.inject({ ...req, headers: { ...req.headers, ...(isPublic(o) ? {} : { cookie }) } });
    if (!isPublic(o)) expect(res.statusCode, res.body).toBeLessThan(300);
    // A JSON answer validates against its schema; the list's CSV is text (its own tests: no-shop.test.ts).
    const json = String(res.headers['content-type'] ?? '').startsWith('application/json');
    if (!json) expect(o.op.responses[String(res.statusCode)]?.content?.['application/json'], `${o.op.operationId}: ${res.headers['content-type']}`).toBeUndefined();
    expectValid(o, res.statusCode, res.body && json ? res.json() : undefined);
    if (o.op.operationId === 'listBacklog') expect(res.json().queryErrors).toEqual(['unknown qualifier "nonsense:"']);
  });
});

describe('deny by default (securitySchemes)', () => {
  it('only /health and the sign-in steps are open; every other operation declares 401 and 403', () => {
    const open = ops.filter(isPublic).map((o) => o.op.operationId).sort();
    expect(open).toEqual(['authSession', 'enrolOptions', 'enrolVerify', 'health', 'signInOptions', 'signInVerify', 'signOut']);
    for (const o of ops.filter((x) => !isPublic(x))) expect(Object.keys(o.op.responses), o.op.operationId).toEqual(expect.arrayContaining(['401', '403']));
  });

  it.each(ops.filter((o) => !isPublic(o)).map((o) => [o.op.operationId, o] as const))('%s: 401 without a session, 403 for a kid', async (_n, o) => {
    const req = request(o);
    const anon = await built.app.inject(req);
    expect(anon.statusCode).toBe(401);
    expectValid(o, 401, anon.json());
    const k = await built.app.inject({ ...req, headers: { ...req.headers, cookie: kid } });
    expect(k.statusCode).toBe(403);
    expectValid(o, 403, k.json());
  });

  it('a change from another origin, or with no Origin, is refused', async () => {
    const body = { name: 'Pat', role: 'adult' };
    for (const origin of ['https://evil.example', undefined]) {
      const headers: Record<string, string> = { cookie: admin, ...(origin ? { origin } : {}) };
      expect((await built.app.inject({ method: 'POST', url: '/api/people', headers, payload: body })).statusCode).toBe(403);
    }
    expect((await built.app.inject({ method: 'POST', url: '/api/auth/sign-in/options', headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
  });

  it('admin routes refuse adults', async () => {
    const r = await built.app.inject({ method: 'POST', url: '/api/people', headers: { cookie: adult, origin: ORIGIN }, payload: { name: 'Pat', role: 'adult' } });
    expect(r.statusCode).toBe(403);
  });

  it('a forged HomersLab header means nothing in standalone mode', async () => {
    expect((await built.app.inject({ url: '/api/me', headers: HL_ADULT })).statusCode).toBe(401);
  });
});

describe('homerslab mode', () => {
  let hl: BuiltApp;
  beforeAll(async () => { hl = await buildApp(homerslab(), household()); await hl.app.ready(); });
  afterAll(() => hl.app.close());

  it('a person from the trusted proxy is added and kept in step', async () => {
    const me = (await hl.app.inject({ url: '/api/me', headers: { 'x-homerslab-person': 'hl-new', 'x-homerslab-name': 'Jo', 'x-homerslab-role': 'adult' } })).json();
    expect(me.person).toMatchObject({ name: 'Jo', role: 'adult' });
    const again = (await hl.app.inject({ url: '/api/me', headers: { 'x-homerslab-person': 'hl-new', 'x-homerslab-name': 'Jo', 'x-homerslab-role': 'admin' } })).json();
    expect(again.person).toMatchObject({ id: me.person.id, role: 'admin' });
  });
  it('the headers count only from the proxy; a kid or a missing role gets 403', async () => {
    expect((await hl.app.inject({ url: '/api/me', headers: HL_ADULT, remoteAddress: '10.0.0.9' })).statusCode).toBe(401);
    expect((await hl.app.inject({ url: '/api/me', headers: HL_KID })).statusCode).toBe(403);
    expect((await hl.app.inject({ url: '/api/me', headers: { 'x-homerslab-person': 'hl-sam' } })).statusCode).toBe(403);
    expect((await hl.app.inject({ url: '/api/me', headers: { ...HL_ADULT, 'x-homerslab-role': 'superuser' } })).statusCode).toBe(403);
  });
  it('a session cookie means nothing under HomersLab', async () => {
    const db = household();
    const app = await buildApp(homerslab(), db);
    expect((await app.app.inject({ url: '/api/me', headers: { cookie: sessionCookie(db, 'p_alex') } })).statusCode).toBe(401);
    await app.app.close();
  });
  it('people are managed in HomersLab; passkey sign-in is not offered', async () => {
    const hlAdmin = { 'x-homerslab-person': 'hl-alex', 'x-homerslab-name': 'Alex', 'x-homerslab-role': 'admin', origin: ORIGIN };
    expect((await hl.app.inject({ method: 'POST', url: '/api/people', headers: hlAdmin, payload: { name: 'Pat', role: 'adult' } })).statusCode).toBe(409);
    expect((await hl.app.inject({ method: 'POST', url: '/api/auth/sign-in/options', headers: { origin: ORIGIN } })).statusCode).toBe(404);
    const session = (await hl.app.inject({ url: '/api/auth/session', headers: HL_ADULT })).json();
    expect(session).toMatchObject({ mode: 'homerslab', signedIn: true, setupNeeded: false, person: { name: 'Sam' } });
  });
  it('passkeys and sessions are not Philobiblos\'s under HomersLab: 404', async () => {
    const h = { ...HL_ADULT, origin: ORIGIN };
    for (const [method, url] of [['GET', '/api/me/passkeys'], ['POST', '/api/me/passkeys/invite'], ['POST', '/api/me/sessions/end'], ['DELETE', '/api/me/passkeys/pk1']] as const) {
      expect((await hl.app.inject({ method, url, headers: h })).statusCode, url).toBe(404);
    }
  });
  it('a change needs Philobiblos\'s Origin under HomersLab too', async () => {
    expect((await hl.app.inject({ method: 'PATCH', url: '/api/settings', headers: HL_ADULT, payload: {} })).statusCode).toBe(403);
  });
  it('the role must be exactly admin, adult or kid', async () => {
    expect((await hl.app.inject({ url: '/api/me', headers: { ...HL_ADULT, 'x-homerslab-person': 'hl-pad', 'x-homerslab-role': ' admin' } })).statusCode).toBe(403);
    expect((await hl.app.inject({ url: '/api/me', headers: { ...HL_ADULT, 'x-homerslab-person': 'hl-up', 'x-homerslab-role': 'Admin' } })).statusCode).toBe(403);
  });
  it('the manifest asks HomersLab for the edge\'s promise and does not make it itself', () => {
    const m = parse(readFileSync(new URL('../../../contracts/homerslab-app.yaml', import.meta.url), 'utf8'));
    expect(m.identity.edge).toBe(EDGE_IDENTITY);
    for (const k of ['PHILOBIBLOS_EDGE_IDENTITY', 'PHILOBIBLOS_TRUSTED_PROXY', 'PHILOBIBLOS_ORIGIN']) expect(Object.keys(m.env ?? {}), k).not.toContain(k);
    expect(m.audience).toBe('adults');
  });
  it('the manifest names every mailbox setting the server reads, the CA file as a mounted file and the port in the egress (philobiblos#49)', () => {
    const m = parse(readFileSync(new URL('../../../contracts/homerslab-app.yaml', import.meta.url), 'utf8'));
    const source = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
    const read = [...new Set(source.match(/env\.PHILOBIBLOS_IMAP_[A-Z0-9_]+/g)!.map((k) => k.slice(4)))];
    expect(read).toEqual(expect.arrayContaining(['PHILOBIBLOS_IMAP_PORT', 'PHILOBIBLOS_IMAP_CA_FILE']));
    const keys = (l: { key: string }[] | undefined) => (l ?? []).map((e) => e.key);
    const named = [...keys(m.config), ...keys(m.secrets), ...keys(m.files)];
    // A secret's *_FILE form is how HomersLab hands a secret it holds as a file: covered by the secret.
    for (const k of read) expect(named.includes(k) || named.includes(k.replace(/_FILE$/, '')), k).toBe(true);
    const ca = m.files.find((f: { key: string }) => f.key === 'PHILOBIBLOS_IMAP_CA_FILE');
    expect(ca).toMatchObject({ optional: true, read_only: true });
    expect(ca.mount).toMatch(/^\/[^\s]+\.pem$/);
    expect(m.volumes.map((v: { mount: string }) => v.mount)).not.toContain(ca.mount);
    expect(m.network.egress).toContain('${PHILOBIBLOS_IMAP_HOST}:${PHILOBIBLOS_IMAP_PORT}');
    // Plain ${VAR} substitution only, as every other entry: the port's default is its config entry's.
    expect(m.config.find((c: { key: string }) => c.key === 'PHILOBIBLOS_IMAP_PORT')).toMatchObject({ optional: true, default: '993' });
    expect(JSON.stringify(m.network)).not.toMatch(/:-/);
  });
  it('needs PHILOBIBLOS_ORIGIN, the edge\'s promise (HomersLab #236) and the trusted proxy', () => {
    expect(() => loadConfig({ PHILOBIBLOS_MODE: 'homerslab' })).toThrow(/PHILOBIBLOS_ORIGIN/);
    expect(() => loadConfig({ PHILOBIBLOS_MODE: 'homerslab', PHILOBIBLOS_ORIGIN: ORIGIN, PHILOBIBLOS_TRUSTED_PROXY: '127.0.0.1' })).toThrow(/PHILOBIBLOS_EDGE_IDENTITY/);
    expect(() => loadConfig({ PHILOBIBLOS_MODE: 'homerslab', PHILOBIBLOS_ORIGIN: ORIGIN, PHILOBIBLOS_EDGE_IDENTITY: 'homerslab-v1' })).toThrow(/PHILOBIBLOS_TRUSTED_PROXY/);
  });
});

describe('share tokens', () => {
  const shares = ops.find((o) => o.op.operationId === 'createShare')!;
  it('the spec allows a share token on POST /shares and nowhere else', () => {
    for (const o of ops) expect(security(o).some((s) => 'shareToken' in s), o.op.operationId).toBe(o === shares);
  });
  it('a token works for POST /shares only (no Origin needed), is shown once, stored hashed, and stops when revoked', async () => {
    const created = await built.app.inject({ method: 'POST', url: '/api/share-tokens', headers: { cookie: admin, origin: ORIGIN }, payload: { label: 'Phone' } });
    expect(created.statusCode).toBe(201);
    const { id, token } = created.json();
    expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}[A-Za-z0-9_-]{43}$/);
    expect(token.slice(0, 26)).toBe(id);
    const auth = { authorization: `Bearer ${token}` };
    const req = request(shares);
    const { origin: _o, ...noOrigin } = req.headers;
    expect((await built.app.inject({ ...req, headers: { ...noOrigin, ...auth } })).statusCode).toBe(202);
    for (const url of ['/api/me', '/api/share-tokens', '/api/settings']) expect((await built.app.inject({ url, headers: auth })).statusCode).toBe(401);
    const listed = (await built.app.inject({ url: '/api/share-tokens', headers: { cookie: admin } })).json();
    expect(listed.find((x: { id: string }) => x.id === id)).toMatchObject({ label: 'Phone', revoked: false });
    expect(JSON.stringify(listed)).not.toContain(token);
    expect((await built.app.inject({ method: 'DELETE', url: `/api/share-tokens/${id}`, headers: { cookie: admin, origin: ORIGIN } })).statusCode).toBe(204);
    expect((await built.app.inject({ ...req, headers: { ...noOrigin, ...auth } })).statusCode).toBe(401);
  });
});

describe('share upload limits', () => {
  const files = (n: number, size: number, cookie: string) => {
    const b = 'limit-boundary';
    const parts = Array.from({ length: n }, (_, i) => [`--${b}`, `Content-Disposition: form-data; name="media"; filename="${i}.jpg"`, 'Content-Type: image/jpeg', '', 'x'.repeat(size)].join('\r\n'));
    return { payload: [...parts, `--${b}--`, ''].join('\r\n'), headers: { 'content-type': `multipart/form-data; boundary=${b}`, cookie, origin: ORIGIN } };
  };
  // Within the limits, the files are read to their end; without a media worker here the share is then refused (503).
  it('30 files pass, 31 are refused with 413', async () => {
    expect((await built.app.inject({ method: 'POST', url: '/api/shares', ...files(30, 10, admin) })).statusCode).toBe(503);
    expect((await built.app.inject({ method: 'POST', url: '/api/shares', ...files(31, 10, admin) })).statusCode).toBe(413);
  });
  it('a file over the size limit is refused with 413', async () => {
    const db = household();
    const small = await buildApp(standalone(), db, { shareLimits: { fileSize: 1024 } });
    const c = sessionCookie(db, 'p_alex');
    expect((await small.app.inject({ method: 'POST', url: '/api/shares', ...files(1, 1000, c) })).statusCode).toBe(503);
    expect((await small.app.inject({ method: 'POST', url: '/api/shares', ...files(1, 2000, c) })).statusCode).toBe(413);
    await small.app.close();
  });
});

describe('no secrets in responses', () => {
  it('settings and the household carry no secret field', async () => {
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
    };
    for (const url of ['/api/settings', '/api/me', '/api/me/passkeys']) walk((await built.app.inject({ url, headers: { cookie: admin } })).json());
    expect(keys.filter((k) => /password|apikey|api_key|secret|^card|cardnumber|address|token|publickey|hash/i.test(k))).toEqual([]);
  });
  it('the delivery address is sealed at rest and never sent back', async () => {
    const addr = 'Alex Example\nExample Street 1\n8000 Zurich';
    const r = await built.app.inject({ method: 'PATCH', url: '/api/settings', headers: { cookie: admin, origin: ORIGIN }, payload: { order: { deliveryAddress: addr } } });
    expect(r.statusCode, r.body).toBe(200);
    const s = await built.app.inject({ url: '/api/settings', headers: { cookie: admin } });
    expect(s.json().order).toMatchObject({ hasDelivery: true, bookshopEmail: 'orders@bookshop.example' });
    expect(s.body).not.toContain('Example Street');
    const row = db0.select().from(t.sealedSecret).all().find((x) => x.key === 'delivery_address')!;
    expect(row.ciphertext.toString('latin1')).not.toContain('Example');
    expect((await built.app.inject({ method: 'PATCH', url: '/api/settings', headers: { cookie: adult, origin: ORIGIN }, payload: { order: { deliveryAddress: 'x' } } })).statusCode).toBe(403);
  });
  it('responses carry the security headers', async () => {
    const r = await built.app.inject({ url: '/api/health' });
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
  it('no Gmail route exists; the only OAuth routes connect the mailbox (XOAUTH2, the admin\'s own client)', () => {
    expect(built.apiRoutes.filter((r) => /gmail|google/i.test(r.url))).toEqual([]);
    expect(built.apiRoutes.filter((r) => /oauth/i.test(r.url)).map((r) => `${r.method} ${r.url}`).sort()).toEqual(['DELETE /api/mail/oauth', 'POST /api/mail/oauth/finish', 'POST /api/mail/oauth/start']);
  });
});
