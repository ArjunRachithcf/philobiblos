// Sign-in, step by step (ADR 0010), with a stand-in authenticator (helpers.fakeWebAuthn); the real WebAuthn runs in
// the e2e tests.
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp, type BuiltApp } from '../src/app';
import { createInvite, ensureSetupLink, findInvite, SETUP_FILE } from '../src/auth/invites';
import { IDLE_DAYS, createSession, sessionPerson } from '../src/auth/sessions';
import { Challenges } from '../src/auth/webauthn';
import { loadConfig, type Config } from '../src/config';
import { openDb, type Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { ORIGIN, fakeWebAuthn, household } from './helpers';

const H = { origin: ORIGIN };
let cfg: Config;
let db: Db;
let app: BuiltApp['app'];

beforeEach(async () => {
  cfg = loadConfig({ SHELF_MODE: 'standalone', SHELF_DATA_DIR: mkdtempSync(join(tmpdir(), 'shelf-auth-')) });
  db = openDb(':memory:');
  app = (await buildApp(cfg, db, { webauthn: fakeWebAuthn() })).app;
});
afterEach(() => app.close());

const post = (url: string, payload?: object, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload, headers: { ...H, ...headers } });

async function enrol(token: string, name?: string, credId = 'cred-1') {
  const o = await post('/api/auth/enrol/options', { token, ...(name ? { name } : {}) });
  expect(o.statusCode, o.body).toBe(200);
  const { challengeId, options } = o.json();
  return post('/api/auth/enrol/verify', { challengeId, response: { id: credId, challenge: options.challenge }, label: 'Laptop' });
}
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === 'shelf_session');
  return c ? `shelf_session=${c.value}` : '';
};
const setupToken = () => readFileSync(join(cfg.dataDir, SETUP_FILE), 'utf8').trim().split('#')[1]!;

describe('first admin', () => {
  it('the setup link is written to a private file, used once, then removed', async () => {
    const file = ensureSetupLink(db, cfg)!;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toMatch(new RegExp(`^${ORIGIN}/setup#[A-Za-z0-9_-]{43}\\n$`));
    expect((await app.inject({ url: '/api/auth/session' })).json()).toMatchObject({ setupNeeded: true, signedIn: false });

    const token = setupToken();
    const res = await enrol(token, 'Alex');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ signedIn: true, person: { name: 'Alex', role: 'admin', signsIn: true } });
    const raw = res.cookies.find((c) => c.name === 'shelf_session')!;
    expect(raw).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    expect(existsSync(file)).toBe(false);
    expect((await app.inject({ url: '/api/auth/session', headers: { cookie: cookieOf(res) } })).json()).toMatchObject({ setupNeeded: false, signedIn: true });

    expect((await post('/api/auth/enrol/options', { token, name: 'Mallory' })).statusCode).toBe(401);
    expect(ensureSetupLink(db, cfg)).toBeNull();
  });

  it('a new start-up replaces the setup link', () => {
    ensureSetupLink(db, cfg);
    const first = setupToken();
    ensureSetupLink(db, cfg);
    expect(findInvite(db, first)).toBeNull();
    expect(findInvite(db, setupToken())).not.toBeNull();
  });

  it('claims an imported admin of the same name instead of adding one', async () => {
    db.insert(t.person).values({ id: 'p_alex', name: 'Alex', role: 'admin', handle: 'alex' }).run();
    ensureSetupLink(db, cfg);
    const res = await enrol(setupToken(), 'Alex');
    expect(res.json().person.id).toBe('p_alex');
    expect(db.select().from(t.person).all()).toHaveLength(1);
  });

  it('needs a name; a wrong or reused challenge fails', async () => {
    ensureSetupLink(db, cfg);
    expect((await post('/api/auth/enrol/options', { token: setupToken() })).statusCode).toBe(400);
    const o = (await post('/api/auth/enrol/options', { token: setupToken(), name: 'Alex' })).json();
    expect((await post('/api/auth/enrol/verify', { challengeId: o.challengeId, response: { id: 'c', challenge: 'other' } })).statusCode).toBe(401);
    // the challenge is gone after one try
    expect((await post('/api/auth/enrol/verify', { challengeId: o.challengeId, response: { id: 'c', challenge: o.options.challenge } })).statusCode).toBe(401);
  });
});

describe('sign-in', () => {
  async function adminWithPasskey() {
    ensureSetupLink(db, cfg);
    await enrol(setupToken(), 'Alex', 'cred-alex');
  }

  it('a passkey signs in, sign-out ends the session', async () => {
    await adminWithPasskey();
    const o = (await post('/api/auth/sign-in/options')).json();
    const res = await post('/api/auth/sign-in/verify', { challengeId: o.challengeId, response: { id: 'cred-alex', challenge: o.options.challenge } });
    expect(res.statusCode, res.body).toBe(200);
    const cookie = cookieOf(res);
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
    expect(db.select().from(t.passkey).where(eq(t.passkey.id, 'cred-alex')).get()!.counter).toBe(1);
    expect((await post('/api/auth/sign-out', undefined, { cookie })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('an unknown passkey and a bad signature get the same answer', async () => {
    await adminWithPasskey();
    for (const response of [{ id: 'nobody', challenge: 'x' }, { id: 'cred-alex', challenge: 'wrong' }]) {
      const o = (await post('/api/auth/sign-in/options')).json();
      const res = await post('/api/auth/sign-in/verify', { challengeId: o.challengeId, response });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'that passkey did not sign you in' });
    }
  });

  it('a kid\'s passkey never signs in', async () => {
    await adminWithPasskey();
    db.insert(t.person).values({ id: 'p_kid', name: 'Kid 1', role: 'kid' }).run();
    db.insert(t.passkey).values({ id: 'cred-kid', personId: 'p_kid', publicKey: Buffer.from([1]), label: 'x', createdAt: new Date().toISOString() }).run();
    const o = (await post('/api/auth/sign-in/options')).json();
    expect((await post('/api/auth/sign-in/verify', { challengeId: o.challengeId, response: { id: 'cred-kid', challenge: o.options.challenge } })).statusCode).toBe(401);
  });

  it('sign-in steps are rate limited', async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await post('/api/auth/sign-in/options')).statusCode;
    expect(last).toBe(429);
  });
});

describe('invites and the household', () => {
  it('an admin invites an adult, who enrols their own passkey; kids cannot be invited', async () => {
    const hh = household();
    const a = await buildApp(cfg, hh, { webauthn: fakeWebAuthn() });
    const cookie = `shelf_session=${createSession(hh, 'p_alex').token}`;
    const inv = await a.app.inject({ method: 'POST', url: '/api/people/p_sam/invites', headers: { ...H, cookie } });
    expect(inv.statusCode).toBe(201);
    const token = inv.json().url.split('#')[1];
    expect(inv.json().url).toMatch(new RegExp(`^${ORIGIN}/enrol#`));
    const o = (await a.app.inject({ method: 'POST', url: '/api/auth/enrol/options', headers: H, payload: { token } })).json();
    expect(o.person).toEqual({ name: 'Sam' });
    const v = await a.app.inject({ method: 'POST', url: '/api/auth/enrol/verify', headers: H, payload: { challengeId: o.challengeId, response: { id: 'cred-sam', challenge: o.options.challenge } } });
    expect(v.json().person).toMatchObject({ id: 'p_sam', signsIn: true });
    expect((await a.app.inject({ method: 'POST', url: '/api/people/p_kid1/invites', headers: { ...H, cookie } })).statusCode).toBe(409);
    await a.app.close();
  });

  it('the last admin stays; nobody removes themselves; a kid loses passkeys and sessions', async () => {
    const hh = household();
    const a = await buildApp(cfg, hh, { webauthn: fakeWebAuthn() });
    const cookie = `shelf_session=${createSession(hh, 'p_alex').token}`;
    const h = { ...H, cookie };
    expect((await a.app.inject({ method: 'PATCH', url: '/api/people/p_alex', headers: h, payload: { role: 'adult' } })).statusCode).toBe(409);
    expect((await a.app.inject({ method: 'DELETE', url: '/api/people/p_alex', headers: h })).statusCode).toBe(409);
    hh.insert(t.passkey).values({ id: 'cred-sam', personId: 'p_sam', publicKey: Buffer.from([1]), label: 'x', createdAt: new Date().toISOString() }).run();
    const sam = `shelf_session=${createSession(hh, 'p_sam').token}`;
    expect((await a.app.inject({ method: 'PATCH', url: '/api/people/p_sam', headers: h, payload: { role: 'kid', birthYear: 2019 } })).json()).toMatchObject({ role: 'kid', birthYear: 2019, signsIn: false });
    expect((await a.app.inject({ url: '/api/me', headers: { cookie: sam } })).statusCode).toBe(401);
    expect((await a.app.inject({ method: 'POST', url: '/api/people', headers: h, payload: { name: 'Pat', role: 'adult', handle: 'alex' } })).statusCode).toBe(409);
    expect((await a.app.inject({ method: 'POST', url: '/api/people', headers: h, payload: { name: 'Pat', role: 'adult', extra: 1 } })).statusCode).toBe(400);
    const pat = (await a.app.inject({ method: 'POST', url: '/api/people', headers: h, payload: { name: 'Pat', role: 'adult' } })).json();
    expect(pat).toMatchObject({ name: 'Pat', handle: 'pat', signsIn: false });
    await a.app.close();
  });

  it('your last passkey stays', async () => {
    const hh = household();
    const a = await buildApp(cfg, hh, { webauthn: fakeWebAuthn() });
    const h = { ...H, cookie: `shelf_session=${createSession(hh, 'p_alex').token}` };
    expect((await a.app.inject({ method: 'DELETE', url: '/api/me/passkeys/pk1', headers: h })).statusCode).toBe(204);
    expect((await a.app.inject({ method: 'DELETE', url: '/api/me/passkeys/pk2', headers: h })).statusCode).toBe(409);
    expect((await a.app.inject({ method: 'DELETE', url: '/api/me/passkeys/nope', headers: h })).statusCode).toBe(404);
    await a.app.close();
  });
});

describe('sessions, invites and challenges expire', () => {
  it('a session ends after a week idle or 30 days', () => {
    const hh = household();
    const t0 = new Date('2026-11-01T00:00:00Z');
    const { token } = createSession(hh, 'p_alex', t0);
    expect(sessionPerson(hh, token, new Date(t0.getTime() + 86_400_000))).toBe('p_alex');
    expect(sessionPerson(hh, token, new Date(t0.getTime() + (IDLE_DAYS + 2) * 86_400_000))).toBeNull();
    const s2 = createSession(hh, 'p_alex', t0);
    for (let d = 0; d < 29; d += 5) expect(sessionPerson(hh, s2.token, new Date(t0.getTime() + d * 86_400_000))).toBe('p_alex');
    expect(sessionPerson(hh, s2.token, new Date(t0.getTime() + 31 * 86_400_000))).toBeNull();
    expect(sessionPerson(hh, 'not a token')).toBeNull();
  });
  it('an invite lasts 7 days', () => {
    const hh = household();
    const t0 = new Date('2026-11-01T00:00:00Z');
    const { token } = createInvite(hh, cfg, { purpose: 'enrol', personId: 'p_sam', now: t0 });
    expect(findInvite(hh, token, new Date(t0.getTime() + 6 * 86_400_000))).not.toBeNull();
    expect(findInvite(hh, token, new Date(t0.getTime() + 8 * 86_400_000))).toBeNull();
  });
  it('a challenge lasts 5 minutes and is used once', () => {
    const c = new Challenges();
    const id = c.put({ challenge: 'a', kind: 'sign-in' }, 0);
    expect(c.take(id, 'enrol', 1)).toBeNull(); // wrong kind consumes it too
    const id2 = c.put({ challenge: 'b', kind: 'sign-in' }, 0);
    expect(c.take(id2, 'sign-in', 5 * 60_000 + 1)).toBeNull();
    const id3 = c.put({ challenge: 'c', kind: 'sign-in' }, 0);
    expect(c.take(id3, 'sign-in', 1)).toMatchObject({ challenge: 'c' });
    expect(c.take(id3, 'sign-in', 2)).toBeNull();
  });
});
