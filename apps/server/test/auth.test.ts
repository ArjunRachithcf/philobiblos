// Sign-in, step by step (ADR 0010), with a stand-in authenticator (helpers.fakeWebAuthn); the real WebAuthn runs in
// the e2e tests.
import { existsSync, lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp, type BuiltApp } from '../src/app';
import { createInvite, createRecoveryLink, ensureSetupLink, findInvite, openRecovery, SETUP_FILE } from '../src/auth/invites';
import { removePerson } from '../src/household/people';
import { FRESH_MINUTES, IDLE_DAYS, createSession, sessionPerson } from '../src/auth/sessions';
import { Challenges } from '../src/auth/webauthn';
import { loadConfig, type Config } from '../src/config';
import { openDb, type Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { ORIGIN, fakeWebAuthn, household, sessionCookie } from './helpers';

const H = { origin: ORIGIN };
let cfg: Config;
let db: Db;
let app: BuiltApp['app'];

beforeEach(async () => {
  cfg = loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: mkdtempSync(join(tmpdir(), 'philobiblos-auth-')) });
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
  const c = res.cookies.find((x) => x.name === 'philobiblos_session');
  return c ? `philobiblos_session=${c.value}` : '';
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
    const raw = res.cookies.find((c) => c.name === 'philobiblos_session')!;
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
    const cookie = `philobiblos_session=${createSession(hh, 'p_alex').token}`;
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
    const cookie = `philobiblos_session=${createSession(hh, 'p_alex').token}`;
    const h = { ...H, cookie };
    expect((await a.app.inject({ method: 'PATCH', url: '/api/people/p_alex', headers: h, payload: { role: 'adult' } })).statusCode).toBe(409);
    expect((await a.app.inject({ method: 'DELETE', url: '/api/people/p_alex', headers: h })).statusCode).toBe(409);
    hh.insert(t.passkey).values({ id: 'cred-sam', personId: 'p_sam', publicKey: Buffer.from([1]), label: 'x', createdAt: new Date().toISOString() }).run();
    const sam = `philobiblos_session=${createSession(hh, 'p_sam').token}`;
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
    const h = { ...H, cookie: `philobiblos_session=${createSession(hh, 'p_alex').token}` };
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
    const { token } = createSession(hh, 'p_alex', null, t0);
    expect(sessionPerson(hh, token, new Date(t0.getTime() + 86_400_000))).toBe('p_alex');
    expect(sessionPerson(hh, token, new Date(t0.getTime() + (IDLE_DAYS + 2) * 86_400_000))).toBeNull();
    const s2 = createSession(hh, 'p_alex', null, t0);
    for (let d = 0; d < 29; d += 5) expect(sessionPerson(hh, s2.token, new Date(t0.getTime() + d * 86_400_000))).toBe('p_alex');
    expect(sessionPerson(hh, s2.token, new Date(t0.getTime() + 31 * 86_400_000))).toBeNull();
    expect(sessionPerson(hh, 'not a token')).toBeNull();
  });
  it('an admin\'s invite lasts 7 days; your own link and a recovery link 24 hours', () => {
    const hh = household();
    const t0 = new Date('2026-11-01T00:00:00Z');
    const { token } = createInvite(hh, cfg, { kind: 'admin', personId: 'p_sam', createdBy: 'p_alex', now: t0 });
    expect(findInvite(hh, token, new Date(t0.getTime() + 6 * 86_400_000))).not.toBeNull();
    expect(findInvite(hh, token, new Date(t0.getTime() + 8 * 86_400_000))).toBeNull();
    for (const kind of ['self', 'recovery'] as const) {
      const own = createInvite(hh, cfg, { kind, personId: 'p_alex', createdBy: kind === 'self' ? 'p_alex' : undefined, now: t0 });
      expect(findInvite(hh, own.token, new Date(t0.getTime() + 23 * 3_600_000))).not.toBeNull();
      expect(findInvite(hh, own.token, new Date(t0.getTime() + 25 * 3_600_000))).toBeNull();
    }
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

describe('passkeys after the first (review round 1)', () => {
  let hh: Db;
  let a: BuiltApp['app'];
  beforeEach(async () => { hh = household(); a = (await buildApp(cfg, hh, { webauthn: fakeWebAuthn() })).app; });
  afterEach(() => a.close());
  const call = (method: 'POST' | 'GET' | 'DELETE' | 'PATCH', url: string, cookie: string, payload?: object) =>
    a.inject({ method, url, payload, headers: { ...H, cookie } });
  async function enrolWith(token: string, credId: string) {
    const o = (await call('POST', '/api/auth/enrol/options', '', { token })).json();
    return call('POST', '/api/auth/enrol/verify', '', { challengeId: o.challengeId, response: { id: credId, challenge: o.options.challenge }, label: 'Phone' });
  }
  const stale = (personId: string) => {
    const old = new Date(Date.now() - (FRESH_MINUTES + 1) * 60_000);
    return `philobiblos_session=${createSession(hh, personId, null, old).token}`;
  };

  it('you add a passkey on another device with your own link; it needs a fresh sign-in', async () => {
    expect((await call('POST', '/api/me/passkeys/invite', stale('p_alex'))).statusCode).toBe(403);
    const inv = await call('POST', '/api/me/passkeys/invite', sessionCookie(hh, 'p_alex'));
    expect(inv.statusCode).toBe(201);
    const v = await enrolWith(inv.json().url.split('#')[1], 'cred-alex-phone');
    expect(v.json().person).toMatchObject({ id: 'p_alex' });
    const mine = (await call('GET', '/api/me/passkeys', cookieOf(v))).json();
    expect(mine.find((k: { id: string }) => k.id === 'cred-alex-phone')).toMatchObject({ label: 'Phone', invitedBy: null });
  });

  it('an admin invites only someone without a passkey, with a fresh sign-in; the passkey shows who invited it', async () => {
    expect((await call('POST', '/api/people/p_sam/invites', stale('p_alex'))).statusCode).toBe(403);
    const inv = await call('POST', '/api/people/p_sam/invites', sessionCookie(hh, 'p_alex'));
    const v = await enrolWith(inv.json().url.split('#')[1], 'cred-sam');
    expect((await call('GET', '/api/me/passkeys', cookieOf(v))).json()).toMatchObject([{ id: 'cred-sam', invitedBy: 'Alex' }]);
    const again = await call('POST', '/api/people/p_sam/invites', sessionCookie(hh, 'p_alex'));
    expect(again.statusCode).toBe(409);
  });

  it('a passkey that is already enrolled answers 409', async () => {
    const inv = await call('POST', '/api/me/passkeys/invite', sessionCookie(hh, 'p_alex'));
    const v = await enrolWith(inv.json().url.split('#')[1], 'pk1');
    expect(v.statusCode).toBe(409);
    expect(v.json()).toEqual({ error: 'this passkey is already enrolled' });
  });

  it('removing a passkey ends the sessions it signed in; sign out everywhere ends all', async () => {
    const viaPk1 = `philobiblos_session=${createSession(hh, 'p_alex', 'pk1').token}`;
    const viaPk2 = `philobiblos_session=${createSession(hh, 'p_alex', 'pk2').token}`;
    const other = `philobiblos_session=${createSession(hh, 'p_alex', 'pk2').token}`;
    expect((await call('DELETE', '/api/me/passkeys/pk1', viaPk2)).statusCode).toBe(204);
    expect((await call('GET', '/api/me', viaPk1)).statusCode).toBe(401);
    expect((await call('GET', '/api/me', other)).statusCode).toBe(200);
    expect((await call('POST', '/api/me/sessions/end', viaPk2)).statusCode).toBe(204);
    for (const c of [viaPk2, other]) expect((await call('GET', '/api/me', c)).statusCode).toBe(401);
  });

  it('a sign-in replaces the browser\'s earlier session and records the passkey', async () => {
    const before = sessionCookie(hh, 'p_alex');
    const o = (await call('POST', '/api/auth/sign-in/options', '')).json();
    const res = await call('POST', '/api/auth/sign-in/verify', before, { challengeId: o.challengeId, response: { id: 'pk2', challenge: o.options.challenge } });
    expect(res.statusCode).toBe(200);
    expect((await call('GET', '/api/me', before)).statusCode).toBe(401);
    expect(hh.select().from(t.session).all().map((s) => s.passkeyId)).toEqual(['pk2']);
  });

  it('a request with Authorization is authenticated by the token alone: a wrong or malformed one gets 401 beside a valid cookie', async () => {
    const cookie = sessionCookie(hh, 'p_alex');
    for (const authorization of ['Bearer wrong-token-wrong-token-wrong', 'Bearer short', 'Basic YWxleDp4', '']) {
      const r = await a.inject({ method: 'POST', url: '/api/shares', headers: { cookie, origin: ORIGIN, authorization } });
      expect(r.statusCode, authorization).toBe(401);
    }
  });

  it('the last admin must be one who can sign in', async () => {
    // Pat is an admin without a passkey: Alex, the only admin with one, can neither step down nor be removed.
    hh.insert(t.person).values({ id: 'p_pat', name: 'Pat', role: 'admin', handle: 'pat' }).run();
    expect((await call('PATCH', '/api/people/p_alex', sessionCookie(hh, 'p_alex'), { role: 'adult' })).statusCode).toBe(409);
    expect(() => removePerson(hh, 'p_alex', 'p_pat')).toThrow(/admin who can sign in/);
    // Once Pat has a passkey, Alex may step down.
    hh.insert(t.passkey).values({ id: 'pk-pat', personId: 'p_pat', publicKey: Buffer.from([1]), label: 'x', createdAt: new Date().toISOString() }).run();
    expect((await call('PATCH', '/api/people/p_alex', sessionCookie(hh, 'p_alex'), { role: 'adult' })).statusCode).toBe(200);
  });

  it('the first enrolment spends every other open link of that person', async () => {
    const admin = sessionCookie(hh, 'p_alex');
    const first = (await call('POST', '/api/people/p_sam/invites', admin)).json().url.split('#')[1];
    const second = (await call('POST', '/api/people/p_sam/invites', admin)).json().url.split('#')[1];
    // both started before either finishes: the second still fails at verify
    const o1 = (await call('POST', '/api/auth/enrol/options', '', { token: first })).json();
    const o2 = (await call('POST', '/api/auth/enrol/options', '', { token: second })).json();
    expect((await call('POST', '/api/auth/enrol/verify', '', { challengeId: o1.challengeId, response: { id: 'cred-sam', challenge: o1.options.challenge } })).statusCode).toBe(200);
    expect((await call('POST', '/api/auth/enrol/verify', '', { challengeId: o2.challengeId, response: { id: 'cred-sam-2', challenge: o2.options.challenge } })).statusCode).toBe(401);
    expect((await call('POST', '/api/auth/enrol/options', '', { token: second })).statusCode).toBe(401);
    expect(hh.select().from(t.passkey).where(eq(t.passkey.personId, 'p_sam')).all()).toHaveLength(1);
  });

  it('enrolling spends the person\'s other links on its own (two of your own links, one after the other)', async () => {
    // Own links are not refused at verify for an existing passkey, so only the spending step stops the second one.
    const me = sessionCookie(hh, 'p_alex');
    const first = (await call('POST', '/api/me/passkeys/invite', me)).json().url.split('#')[1];
    const second = (await call('POST', '/api/me/passkeys/invite', me)).json().url.split('#')[1];
    expect((await enrolWith(first, 'cred-alex-tablet')).statusCode).toBe(200);
    expect(findInvite(hh, second)).toBeNull();
    expect((await call('POST', '/api/auth/enrol/options', '', { token: second })).statusCode).toBe(401);
  });

  it('an admin who is removed or steps down takes their open invites along; none becomes a recovery link', async () => {
    hh.insert(t.person).values({ id: 'p_bo', name: 'Bo', role: 'admin', handle: 'bo' }).run();
    hh.insert(t.passkey).values({ id: 'pk-bo', personId: 'p_bo', publicKey: Buffer.from([1]), label: 'x', createdAt: new Date().toISOString() }).run();
    const bo = sessionCookie(hh, 'p_bo');
    const forSam = (await call('POST', '/api/people/p_sam/invites', bo)).json().url.split('#')[1];
    const forRobin = (await call('POST', '/api/people/p_del/invites', bo)).json().url.split('#')[1];
    expect((await call('PATCH', '/api/people/p_bo', sessionCookie(hh, 'p_alex'), { role: 'adult' })).statusCode).toBe(200);
    expect(findInvite(hh, forSam)).toBeNull();
    expect((await call('PATCH', '/api/people/p_bo', sessionCookie(hh, 'p_alex'), { role: 'admin' })).statusCode).toBe(200);
    const again = (await call('POST', '/api/people/p_sam/invites', sessionCookie(hh, 'p_bo'))).json().url.split('#')[1];
    expect((await call('DELETE', '/api/people/p_bo', sessionCookie(hh, 'p_alex'))).statusCode).toBe(204);
    expect(findInvite(hh, again)).toBeNull();
    expect(findInvite(hh, forRobin)).toBeNull();
    expect(openRecovery(hh)).toBe(false);
  });
});

describe('recovery and the link file', () => {
  it('philobiblos recover writes a one-time link for an admin, removed once used; the file survives a restart meanwhile', async () => {
    const hh = household();
    const a = (await buildApp(cfg, hh, { webauthn: fakeWebAuthn() })).app;
    expect(() => createRecoveryLink(hh, cfg, 'partner')).toThrow(/no admin/);
    const file = createRecoveryLink(hh, cfg, 'alex');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toMatch(new RegExp(`^${ORIGIN}/enrol#[A-Za-z0-9_-]{43}\\n$`));
    expect(ensureSetupLink(hh, cfg)).toBeNull();
    expect(existsSync(file)).toBe(true);
    const token = readFileSync(file, 'utf8').trim().split('#')[1]!;
    const o = (await a.inject({ method: 'POST', url: '/api/auth/enrol/options', headers: H, payload: { token } })).json();
    expect(o.person).toEqual({ name: 'Alex' });
    const v = await a.inject({ method: 'POST', url: '/api/auth/enrol/verify', headers: H, payload: { challengeId: o.challengeId, response: { id: 'cred-new', challenge: o.options.challenge } } });
    expect(v.json().person).toMatchObject({ id: 'p_alex' });
    expect(existsSync(file)).toBe(false);
    await a.close();
  });

  it('never writes through a symlink someone put in its place', () => {
    const target = join(cfg.dataDir, 'elsewhere.txt');
    writeFileSync(target, 'keep\n');
    symlinkSync(target, join(cfg.dataDir, SETUP_FILE));
    const file = ensureSetupLink(db, cfg)!;
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('keep\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

// philobiblos#30: the cookie was shelf_session before the rename. Read until 0.2.0 so the upgrade signs nobody out,
// checked exactly as the new one is, and moved to the new name the first time it comes.
describe('the session cookie\'s old name (until 0.2.0)', () => {
  const setCookie = (res: { headers: Record<string, unknown> }) => ([] as string[]).concat((res.headers['set-cookie'] as string | string[] | undefined) ?? []);

  it('an old cookie still signs in, and comes back as the new one with the same token and the old one cleared', async () => {
    const hh = household();
    const a = await buildApp(cfg, hh, { webauthn: fakeWebAuthn() });
    const { token, expiresAt } = createSession(hh, 'p_alex', null, new Date(Date.now() - 2 * 86_400_000));
    const res = await a.app.inject({ url: '/api/me', headers: { cookie: `shelf_session=${token}` } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ person: { id: 'p_alex' } });
    const moved = res.cookies.find((c) => c.name === 'philobiblos_session')!;
    expect(moved).toMatchObject({ value: token, httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    // what is left of the session, never a new 30 days
    expect(moved.maxAge).toBeLessThanOrEqual(Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
    expect(moved.maxAge).toBeGreaterThan(27 * 86_400);
    expect(setCookie(res).some((c) => /^shelf_session=;/.test(c) && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c))).toBe(true);
    // /auth/session (the page's first call) moves it as well
    const s = await a.app.inject({ url: '/api/auth/session', headers: { cookie: `shelf_session=${token}` } });
    expect(s.json()).toMatchObject({ signedIn: true, person: { id: 'p_alex' } });
    expect(s.cookies.find((c) => c.name === 'philobiblos_session')?.value).toBe(token);
    await a.app.close();
  });

  it('an old cookie that names no live session signs nobody in, gets no new cookie, and is cleared', async () => {
    const hh = household();
    const a = await buildApp(cfg, hh, { webauthn: fakeWebAuthn() });
    const res = await a.app.inject({ url: '/api/me', headers: { cookie: `shelf_session=${'A'.repeat(43)}` } });
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === 'philobiblos_session')).toBeUndefined();
    expect(setCookie(res).some((c) => /^shelf_session=;/.test(c))).toBe(true);
    await a.app.close();
  });

  it('with both cookies, the new name\'s is the one read', async () => {
    const hh = household();
    const a = await buildApp(cfg, hh, { webauthn: fakeWebAuthn() });
    const alex = createSession(hh, 'p_alex').token, sam = createSession(hh, 'p_sam').token;
    const res = await a.app.inject({ url: '/api/me', headers: { cookie: `shelf_session=${alex}; philobiblos_session=${sam}` } });
    expect(res.json()).toMatchObject({ person: { id: 'p_sam' } });
    // the old one is cleared even so, and its session is not touched by being read
    expect(setCookie(res).some((c) => /^shelf_session=;/.test(c))).toBe(true);
    expect(res.cookies.find((c) => c.name === 'philobiblos_session')).toBeUndefined();
    // a dead new cookie does not fall back to a live old one
    const dead = await a.app.inject({ url: '/api/me', headers: { cookie: `shelf_session=${alex}; philobiblos_session=${'B'.repeat(43)}` } });
    expect(dead.statusCode).toBe(401);
    await a.app.close();
  });

  it('signing out with an old cookie ends its session and clears both names', async () => {
    const hh = household();
    const a = await buildApp(cfg, hh, { webauthn: fakeWebAuthn() });
    const { token } = createSession(hh, 'p_alex');
    const out = await a.app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { ...H, cookie: `shelf_session=${token}` } });
    expect(out.statusCode).toBe(204);
    expect(sessionPerson(hh, token)).toBeNull();
    const cleared = setCookie(out).map((c) => c.split('=')[0]);
    expect(cleared).toEqual(expect.arrayContaining(['philobiblos_session', 'shelf_session']));
    expect((await a.app.inject({ url: '/api/me', headers: { cookie: `shelf_session=${token}` } })).statusCode).toBe(401);
    await a.app.close();
  });
});
