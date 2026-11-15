// Every operation of contracts/openapi.yaml is served, and only those; each answers with a status the spec declares
// and a body that validates against the spec's schema for it; and the security schemes hold (deny by default).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import { ORIGIN, expectValid, fakeWebAuthn, household, isPublic, ops, request, security, sessionCookie } from './helpers';

const standalone = () => loadConfig({ SHELF_MODE: 'standalone', SHELF_DATA_DIR: '/nonexistent' });
const homerslab = () => loadConfig({ SHELF_MODE: 'homerslab', SHELF_TRUSTED_PROXY: '127.0.0.1', SHELF_ORIGIN: ORIGIN, SHELF_DATA_DIR: '/nonexistent' });
const HL_ADULT = { 'x-homerslab-person': 'hl-sam', 'x-homerslab-name': 'Sam', 'x-homerslab-role': 'adult' };
const HL_KID = { 'x-homerslab-person': 'hl-kid', 'x-homerslab-name': 'Kid 1', 'x-homerslab-role': 'kid' };

let built: BuiltApp;
let admin: string;
let adult: string;
let kid: string;
beforeAll(async () => {
  const db = household();
  admin = sessionCookie(db, 'p_alex');
  adult = sessionCookie(db, 'p_sam');
  kid = sessionCookie(db, 'p_kid1');
  built = await buildApp(standalone(), db, { webauthn: fakeWebAuthn() });
  await built.app.ready();
});
afterAll(() => built.app.close());

describe('contracts/openapi.yaml', () => {
  it('the server has exactly the spec\'s routes', () => {
    const specRoutes = ops.map((o) => `${o.method} /api${o.path.replace(/\{(\w+)\}/g, ':$1')}`).sort();
    const appRoutes = built.apiRoutes.map((r) => `${r.method} ${r.url}`).sort();
    expect(appRoutes).toEqual(specRoutes);
  });

  // In spec order, signed in as the household's admin (public operations without the cookie).
  it.each(ops.map((o) => [`${o.method} ${o.path} (${o.op.operationId})`, o] as const))('%s', async (_name, o) => {
    const req = request(o);
    const res = await built.app.inject({ ...req, headers: { ...req.headers, ...(isPublic(o) ? {} : { cookie: admin }) } });
    if (!isPublic(o)) expect(res.statusCode, res.body).toBeLessThan(300);
    expectValid(o, res.statusCode, res.body ? res.json() : undefined);
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
  it('needs SHELF_ORIGIN', () => {
    expect(() => loadConfig({ SHELF_MODE: 'homerslab' })).toThrow(/SHELF_ORIGIN/);
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
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
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
  it('30 files pass, 31 are refused with 413', async () => {
    expect((await built.app.inject({ method: 'POST', url: '/api/shares', ...files(30, 10, admin) })).statusCode).toBe(202);
    expect((await built.app.inject({ method: 'POST', url: '/api/shares', ...files(31, 10, admin) })).statusCode).toBe(413);
  });
  it('a file over the size limit is refused with 413', async () => {
    const db = household();
    const small = await buildApp(standalone(), db, { shareLimits: { fileSize: 1024 } });
    const c = sessionCookie(db, 'p_alex');
    expect((await small.app.inject({ method: 'POST', url: '/api/shares', ...files(1, 1000, c) })).statusCode).toBe(202);
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
  it('responses carry the security headers', async () => {
    const r = await built.app.inject({ url: '/api/health' });
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
  it('no Gmail or OAuth route exists', () => {
    expect(built.apiRoutes.filter((r) => /gmail|oauth|google/i.test(r.url))).toEqual([]);
  });
});
