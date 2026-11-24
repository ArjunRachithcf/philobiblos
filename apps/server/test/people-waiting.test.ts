// People with a state (ADR 0011, philobiblos#34 slice 1): waiting for an admin's approval, or a member; approving and
// declining with a fresh sign-in in both modes (refused under HomersLab until ArjunRachithcf/homeward#253); Homeward's
// role as the ceiling. Every name and id is invented.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp, type BuiltApp } from '../src/app';
import { WAITING_ANSWER } from '../src/auth/hook';
import { FRESH_MINUTES, createSession } from '../src/auth/sessions';
import { loadConfig } from '../src/config';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { household as members } from '../src/household/people';
import { WAITING, approve, arrive, capped, decline, waitingPeople } from '../src/household/waiting';
import { WAITING_DECISIONS } from '../src/routes/people';
import { JOIN_PUSH } from '../src/push/push';
import { WAITING_ID } from '../src/inbox/inbox';
import type { Egress } from '../src/net/egress';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/open';
import { importSeed } from '../src/seed/import';
import { ORIGIN, RFC8291_UA_KEY, TEST_SEALING_KEY, fakeWebAuthn, household, isPublic, nowherePush, ops, request, sessionCookie } from './helpers';

const standalone = () => loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY });
const homerslab = () => loadConfig({ PHILOBIBLOS_MODE: 'homerslab', PHILOBIBLOS_EDGE_IDENTITY: 'homerslab-v1', PHILOBIBLOS_TRUSTED_PROXY: '127.0.0.1', PHILOBIBLOS_ORIGIN: ORIGIN, PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY });
const hlHeaders = (person: string, name: string, role: string) => ({ 'x-homerslab-person': person, 'x-homerslab-name': name, 'x-homerslab-role': role });
const HL_ALEX = hlHeaders('hl-alex', 'Alex', 'admin');

/** Someone waiting, as slice 2's join links (standalone) or the edge (HomersLab) leave them. */
function waiter(db: Db, id: string, o: { externalId?: string; ceiling?: 'admin' | 'adult' } = {}) {
  db.insert(t.person).values({ id, name: `Someone ${id}`, role: 'adult', state: 'waiting', arrivedAt: new Date().toISOString(), externalId: o.externalId ?? null, ceiling: o.ceiling ?? null }).run();
}
/** A session signed in `minutes` ago. */
const sessionAgo = (db: Db, personId: string, minutes: number) => `philobiblos_session=${createSession(db, personId, null, new Date(Date.now() - minutes * 60_000)).token}`;

let open: BuiltApp[] = [];
async function app(cfg = standalone(), db = household(), push: Egress = nowherePush) {
  const b = await buildApp(cfg, db, { webauthn: fakeWebAuthn(), push });
  await b.app.ready();
  open.push(b);
  return { ...b, db };
}
afterEach(async () => { for (const b of open) await b.app.close(); open = []; });

/** Every household name, id and handle of the test household: none may be in a waiting person's answers. */
const HOUSEHOLD_WORDS = ['Alex', 'Sam', 'Robin', 'Kid 1', 'p_alex', 'p_sam', 'partner', 'Long Tide', 'Ledger', 'Markets'];
const leaksNothing = (body: string) => { for (const w of HOUSEHOLD_WORDS) expect(body, w).not.toContain(w); };

describe('a waiting person sees one page and nothing else', () => {
  it('standalone: every route that needs a person answers 403 waiting, with no household data', async () => {
    const { app: a, db } = await app();
    waiter(db, 'p_wait');
    const cookie = sessionCookie(db, 'p_wait');
    for (const o of ops.filter((x) => !isPublic(x))) {
      const req = request(o);
      const res = await a.inject({ ...req, headers: { ...req.headers, cookie } });
      expect(res.statusCode, `${o.method} ${o.path}`).toBe(403);
      expect(res.json(), `${o.method} ${o.path}`).toEqual(WAITING_ANSWER);
    }
    // The session says who they are and that they wait: their own name only.
    const s = await a.inject({ url: '/api/auth/session', headers: { cookie } });
    expect(s.json()).toMatchObject({ signedIn: true, waiting: true, person: { id: 'p_wait', name: 'Someone p_wait', handle: null } });
    leaksNothing(s.body);
  });

  it('a share token of a waiting person signs nothing in (401, like an unknown one)', async () => {
    const { app: a, db } = await app();
    waiter(db, 'p_wait');
    const { createShareToken } = await import('../src/shares/tokens');
    const { token } = createShareToken(db, 'p_wait', 'Phone');
    const shares = ops.find((o) => o.op.operationId === 'createShare')!;
    const req = request(shares);
    const res = await a.inject({ ...req, headers: { ...req.headers, authorization: `Bearer ${token}`, origin: '' } });
    expect(res.statusCode).toBe(401);
  });

  it('HomersLab: a new adult from the edge gets 403 waiting on every route, and is not in anyone\'s household', async () => {
    const { app: a, db } = await app(homerslab());
    const jo = hlHeaders('hl-jo', 'Jo', 'adult');
    for (const o of ops.filter((x) => !isPublic(x))) {
      const req = request(o);
      const res = await a.inject({ ...req, headers: { ...req.headers, ...jo } });
      expect(res.statusCode, `${o.method} ${o.path}`).toBe(403);
      expect(res.json()).toEqual(WAITING_ANSWER);
    }
    const s = await a.inject({ url: '/api/auth/session', headers: jo });
    expect(s.json()).toMatchObject({ signedIn: true, waiting: true, person: { name: 'Jo' } });
    leaksNothing(s.body);
    expect(waitingPeople(db).map((p) => p.name)).toEqual(['Jo']);
    const me = (await a.inject({ url: '/api/me', headers: HL_ALEX })).json();
    expect(me.household.map((p: { name: string }) => p.name)).not.toContain('Jo');
  });

  it('HomersLab: a first arrival through /auth/session waits too (the web app\'s first call)', async () => {
    const { app: a, db } = await app(homerslab());
    expect((await a.inject({ url: '/api/auth/session', headers: hlHeaders('hl-jo', 'Jo', 'adult') })).json()).toMatchObject({ signedIn: true, waiting: true });
    expect(waitingPeople(db)).toHaveLength(1);
    expect((await a.inject({ url: '/api/auth/session', headers: hlHeaders('hl-lee', 'Lee', 'admin') })).json()).toMatchObject({ signedIn: true, person: { name: 'Lee', role: 'admin' } });
  });

  it('a person waiting is in no member lookup: their library and brain answer 404 like no one', async () => {
    const { app: a, db } = await app();
    waiter(db, 'p_wait');
    const cookie = sessionCookie(db, 'p_alex');
    for (const url of ['/api/people/p_wait/library', '/api/people/p_wait/brain']) {
      expect((await a.inject({ url, headers: { cookie } })).statusCode, url).toBe(404);
    }
  });
});

describe('approve and decline: an admin, with a fresh sign-in', () => {
  const decide = (a: BuiltApp['app'], id: string, what: 'approve' | 'decline', headers: Record<string, string>, payload?: object) =>
    a.inject({ method: 'POST', url: `/api/people/waiting/${id}/${what}`, headers: { origin: ORIGIN, ...headers }, ...(payload ? { payload } : {}) });

  it('standalone: refused with a sign-in older than 10 minutes, for both; the person still waits', async () => {
    const { app: a, db } = await app();
    waiter(db, 'p_wait');
    const stale = sessionAgo(db, 'p_alex', FRESH_MINUTES + 1);
    for (const what of ['approve', 'decline'] as const) {
      const res = await decide(a, 'p_wait', what, { cookie: stale });
      expect(res.statusCode, what).toBe(403);
      expect(res.json().error).toMatch(/sign in again/);
    }
    expect(waitingPeople(db).map((p) => p.id)).toEqual(['p_wait']);
    // just inside the window: fine
    expect((await decide(a, 'p_wait', 'approve', { cookie: sessionAgo(db, 'p_alex', FRESH_MINUTES - 1) })).statusCode).toBe(200);
  });

  it('HomersLab: every approve and decline is refused without the edge\'s recent sign-in signal, a forged one too', async () => {
    const { app: a, db } = await app(homerslab());
    waiter(db, 'p_wait', { externalId: 'hl-jo', ceiling: 'adult' });
    const now = String(Math.floor(Date.now() / 1000));
    for (const extra of [{}, { 'x-homerslab-auth-time': now }, { 'x-homerslab-auth-time': now, 'x-homerslab-fresh': '1' }] as Record<string, string>[]) {
      for (const what of ['approve', 'decline'] as const) {
        const res = await decide(a, 'p_wait', what, { ...HL_ALEX, ...extra });
        expect(res.statusCode, `${what} ${JSON.stringify(extra)}`).toBe(403);
        expect(res.json().error).toMatch(/recent sign-in/);
      }
    }
    expect(waitingPeople(db)).toHaveLength(1);
  });

  it('approves as an adult by default, as an admin by choice; a handle is given then', async () => {
    const { app: a, db } = await app();
    waiter(db, 'p_w1');
    waiter(db, 'p_w2');
    const cookie = sessionCookie(db, 'p_alex');
    const one = await decide(a, 'p_w1', 'approve', { cookie });
    expect(one.json()).toMatchObject({ id: 'p_w1', role: 'adult', handle: 'someone-p-w1' });
    expect((await decide(a, 'p_w2', 'approve', { cookie }, { role: 'admin' })).json()).toMatchObject({ role: 'admin' });
    expect((await decide(a, 'p_w2', 'approve', { cookie })).statusCode).toBe(404); // decided already
    waiter(db, 'p_w3');
    for (const body of [{ role: 'kid' }, { role: 'superuser' }, { role: 'admin', name: 'x' }]) expect((await decide(a, 'p_w3', 'approve', { cookie }, body)).statusCode).toBe(400);
    const me = (await a.inject({ url: '/api/me', headers: { cookie } })).json();
    expect(me.household.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining(['p_w1', 'p_w2']));
    // The approved person uses the app at once.
    expect((await a.inject({ url: '/api/me', headers: { cookie: sessionCookie(db, 'p_w1') } })).statusCode).toBe(200);
  });

  it('declining deletes the person, their passkeys and sessions', async () => {
    const { app: a, db } = await app();
    waiter(db, 'p_wait');
    db.insert(t.passkey).values({ id: 'pk-wait', personId: 'p_wait', publicKey: Buffer.from([1]), label: 'Phone', createdAt: new Date().toISOString() }).run();
    const theirs = sessionCookie(db, 'p_wait');
    expect((await decide(a, 'p_wait', 'decline', { cookie: sessionCookie(db, 'p_alex') })).statusCode).toBe(204);
    expect(db.select().from(t.person).where(eq(t.person.id, 'p_wait')).all()).toEqual([]);
    expect(db.select().from(t.passkey).where(eq(t.passkey.personId, 'p_wait')).all()).toEqual([]);
    expect(db.select().from(t.session).where(eq(t.session.personId, 'p_wait')).all()).toEqual([]);
    expect((await a.inject({ url: '/api/me', headers: { cookie: theirs } })).statusCode).toBe(401);
  });

  it('no enumeration: an unknown id and a member\'s get the same 404; adults and stale admins learn nothing either', async () => {
    const { app: a, db } = await app();
    waiter(db, 'p_wait');
    const cookie = sessionCookie(db, 'p_alex');
    for (const what of ['approve', 'decline'] as const) {
      const unknown = await decide(a, 'p_nobody', what, { cookie });
      const member = await decide(a, 'p_sam', what, { cookie });
      expect([unknown.statusCode, member.statusCode]).toEqual([404, 404]);
      expect(member.json()).toEqual(unknown.json());
      // Before the id is looked at: an adult, and an admin whose sign-in is old, get one answer for every id.
      const adult = sessionCookie(db, 'p_sam');
      const stale = sessionAgo(db, 'p_alex', FRESH_MINUTES + 5);
      for (const c of [adult, stale]) {
        const answers = await Promise.all(['p_wait', 'p_nobody', 'p_sam'].map(async (id) => { const r = await decide(a, id, what, { cookie: c }); return [r.statusCode, r.body]; }));
        expect(new Set(answers.map((x) => JSON.stringify(x))).size).toBe(1);
        expect(answers[0]![0]).toBe(403);
      }
    }
    expect(db.select().from(t.person).where(eq(t.person.id, 'p_sam')).get()).toMatchObject({ state: 'active', role: 'adult' });
    // The list is the admins' only.
    expect((await a.inject({ url: '/api/people/waiting', headers: { cookie: sessionCookie(db, 'p_sam') } })).statusCode).toBe(403);
    expect((await a.inject({ url: '/api/people/waiting', headers: { cookie } })).json()).toEqual([
      { id: 'p_wait', name: 'Someone p_wait', arrivedAt: expect.any(String), via: 'join_link', joinLink: null, fromHomeNetwork: null, matchesRules: null, verifiedAddress: null, mayBeAdmin: true },
    ]);
  });

  it('decisions are rate limited per admin: 429 past the limit', async () => {
    const { app: a, db } = await app();
    const cookie = sessionCookie(db, 'p_alex');
    for (let i = 0; i < WAITING_DECISIONS.max; i++) expect((await decide(a, `p_none${i}`, i % 2 ? 'approve' : 'decline', { cookie })).statusCode).toBe(404);
    waiter(db, 'p_wait');
    expect((await decide(a, 'p_wait', 'approve', { cookie })).statusCode).toBe(429);
    expect((await decide(a, 'p_wait', 'decline', { cookie })).statusCode).toBe(429);
    expect(waitingPeople(db)).toHaveLength(1);
  });

  it('the last-admin rule holds: an approval or a decline never touches a member, and the last admin still stays one', async () => {
    const { app: a, db } = await app();
    const cookie = sessionCookie(db, 'p_alex');
    expect((await decide(a, 'p_alex', 'decline', { cookie })).statusCode).toBe(404);
    const demote = await a.inject({ method: 'PATCH', url: '/api/people/p_alex', headers: { cookie, origin: ORIGIN }, payload: { role: 'adult' } });
    expect(demote.statusCode).toBe(409);
    // A waiting person never counts as an admin who can sign in (they are adults, and their passkey signs them in to
    // the waiting page only).
    waiter(db, 'p_wait');
    db.insert(t.passkey).values({ id: 'pk-w', personId: 'p_wait', publicKey: Buffer.from([1]), label: 'x', createdAt: new Date().toISOString() }).run();
    expect(() => db.update(t.person).set({ role: 'admin' }).where(eq(t.person.id, 'p_wait')).run()).toThrow(/CHECK/);
  });
});

describe('Homeward\'s role is the ceiling', () => {
  it('a Homeward adult arriving answers 403 until approved; then they are a member', async () => {
    const { app: a, db } = await app(homerslab());
    const jo = hlHeaders('hl-jo', 'Jo', 'adult');
    expect((await a.inject({ url: '/api/me', headers: jo })).statusCode).toBe(403);
    expect((await a.inject({ url: '/api/me', headers: jo })).statusCode).toBe(403);
    const [p] = waitingPeople(db);
    approve(db, p!.id, 'adult'); // what the route will do once the edge sends its signal (homeward#253)
    expect((await a.inject({ url: '/api/me', headers: jo })).json().person).toMatchObject({ name: 'Jo', role: 'adult' });
  });

  it('a Homeward admin is admin at once; a demoted admin is adult on the next request and cannot approve', async () => {
    const { app: a, db } = await app(homerslab());
    expect((await a.inject({ url: '/api/me', headers: hlHeaders('hl-lee', 'Lee', 'admin') })).json().person).toMatchObject({ role: 'admin' });
    waiter(db, 'p_wait', { externalId: 'hl-jo', ceiling: 'adult' });
    expect((await a.inject({ url: '/api/people/waiting', headers: HL_ALEX })).statusCode).toBe(200);
    const demoted = hlHeaders('hl-alex', 'Alex', 'adult');
    expect((await a.inject({ url: '/api/me', headers: demoted })).json().person).toMatchObject({ role: 'adult' });
    expect((await a.inject({ url: '/api/people/waiting', headers: demoted })).statusCode).toBe(403);
    const res = await a.inject({ method: 'POST', url: '/api/people/waiting/p_wait/approve', headers: { ...demoted, origin: ORIGIN } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('admins only');
    // Homeward makes them admin again: Philobiblos keeps them adult (another admin, Lee, is there to decide).
    expect((await a.inject({ url: '/api/me', headers: HL_ALEX })).json().person).toMatchObject({ role: 'adult' });
  });

  it('a promoted Homeward person keeps their Philobiblos role', async () => {
    const { app: a } = await app(homerslab());
    expect((await a.inject({ url: '/api/me', headers: hlHeaders('hl-sam', 'Sam', 'admin') })).json().person).toMatchObject({ role: 'adult' });
  });

  it('demoted to kid: refused, their devices gone', async () => {
    const { app: a, db } = await app(homerslab());
    db.insert(t.pushSubscription).values({ id: 'ps-sam', personId: 'p_sam', endpoint: 'https://fcm.googleapis.com/fcm/send/sam', p256dh: RFC8291_UA_KEY, auth: 'BTBZMqHH6r4Tts7J_aSIgg', createdAt: new Date().toISOString() }).run();
    expect((await a.inject({ url: '/api/me', headers: hlHeaders('hl-sam', 'Sam', 'kid') })).statusCode).toBe(403);
    expect(db.select().from(t.person).where(eq(t.person.id, 'p_sam')).get()).toMatchObject({ role: 'kid' });
    expect(db.select().from(t.pushSubscription).where(eq(t.pushSubscription.personId, 'p_sam')).all()).toEqual([]);
  });

  it('an approval is never above the Homeward role', () => {
    const db = household();
    waiter(db, 'p_a', { externalId: 'hl-a', ceiling: 'adult' });
    waiter(db, 'p_b', { externalId: 'hl-b', ceiling: 'admin' });
    expect(() => approve(db, 'p_a', 'admin')).toThrow(/Homeward role is lower/);
    expect(waitingPeople(db).map((p) => p.id).sort()).toEqual(['p_a', 'p_b']);
    expect(approve(db, 'p_a', 'adult')).toMatchObject({ role: 'adult', state: 'active' });
    expect(approve(db, 'p_b', 'admin')).toMatchObject({ role: 'admin', state: 'active' });
    expect(capped('admin', 'adult')).toBe('adult');
    expect(capped('adult', 'admin')).toBe('adult');
    expect(capped('adult', 'kid')).toBe('kid');
  });

  it('the list shows who may be made an admin under HomersLab', async () => {
    const { app: a, db } = await app(homerslab());
    await a.inject({ url: '/api/me', headers: hlHeaders('hl-jo', 'Jo', 'adult') });
    const list = (await a.inject({ url: '/api/people/waiting', headers: HL_ALEX })).json();
    expect(list).toEqual([expect.objectContaining({ name: 'Jo', via: 'homeward', mayBeAdmin: false })]);
    expect(db.select().from(t.person).where(eq(t.person.externalId, 'hl-jo')).get()).toMatchObject({ ceiling: 'adult', handle: null });
  });

  it('no Philobiblos admin left: a Homeward admin who arrives is made one (the household cannot lock itself out)', () => {
    const db = household();
    expect(arrive(db, { externalId: 'hl-alex', name: 'Alex', role: 'adult', via: 'homerslab' })).toMatchObject({ kind: 'member', person: { role: 'adult' } });
    expect(members(db).filter((p) => p.role === 'admin')).toEqual([]);
    expect(arrive(db, { externalId: 'hl-sam', name: 'Sam', role: 'admin', via: 'homerslab' })).toMatchObject({ kind: 'member', person: { role: 'admin' } });
    // Now there is one: another Homeward promotion raises nothing.
    expect(arrive(db, { externalId: 'hl-alex', name: 'Alex', role: 'admin', via: 'homerslab' })).toMatchObject({ kind: 'member', person: { role: 'adult' } });
  });

  it('the ceiling holds even when the stored ceiling did not change (a row above it is lowered), and a waiting Homeward admin is let in once no admin is left', () => {
    const db = household();
    db.update(t.person).set({ ceiling: 'adult' }).where(eq(t.person.id, 'p_alex')).run(); // admin above its ceiling
    db.update(t.person).set({ ceiling: 'adult' }).where(eq(t.person.id, 'p_sam')).run();
    expect(arrive(db, { externalId: 'hl-alex', name: 'Alex', role: 'adult', via: 'homerslab' })).toMatchObject({ kind: 'member', person: { role: 'adult' } });
    waiter(db, 'p_w', { externalId: 'hl-w', ceiling: 'admin' });
    expect(arrive(db, { externalId: 'hl-w', name: 'Someone p_w', role: 'admin', via: 'homerslab' })).toMatchObject({ kind: 'member', person: { role: 'admin', state: 'active' } });
  });

  it('no admin left: only a Homeward admin is raised; a Homeward adult, new, waiting (renamed) or a member, stays as they are', () => {
    const db = household();
    db.update(t.person).set({ role: 'adult' }).where(eq(t.person.id, 'p_alex')).run(); // no active admin now
    waiter(db, 'p_w', { externalId: 'hl-w', ceiling: 'adult' });
    const hl = (externalId: string, name: string, role: 'admin' | 'adult') => arrive(db, { externalId, name, role, via: 'homerslab' });
    expect(hl('hl-w', 'Renamed W', 'adult')).toMatchObject({ kind: 'waiting', person: { name: 'Renamed W', state: 'waiting' } }); // past the fast path
    expect(hl('hl-w', 'Renamed W', 'adult')).toMatchObject({ kind: 'waiting' }); // the fast path
    expect(hl('hl-brand-new', 'New', 'adult')).toMatchObject({ kind: 'waiting', joined: true });
    expect(hl('hl-sam', 'Sam', 'adult')).toMatchObject({ kind: 'member', person: { role: 'adult' } }); // fast path
    expect(hl('hl-sam', 'Sam R', 'adult')).toMatchObject({ kind: 'member', person: { role: 'adult' } }); // past it
    expect(members(db).filter((p) => p.role === 'admin')).toEqual([]);
    // and an unchanged adult, waiting or a member, is answered by a read: no write lock, even with no admin left
    const tx = vi.spyOn(db, 'transaction');
    hl('hl-w', 'Renamed W', 'adult');
    hl('hl-sam', 'Sam R', 'adult');
    expect(tx).not.toHaveBeenCalled();
    tx.mockRestore();
  });

  it('two Homeward admins arriving at once while no admin is left: one is raised, the other stays adult, no one else', async () => {
    const db = household();
    db.update(t.person).set({ role: 'adult' }).where(eq(t.person.id, 'p_alex')).run();
    const { app: a } = await app(homerslab(), db);
    const [x, y] = await Promise.all([a.inject({ url: '/api/me', headers: HL_ALEX }), a.inject({ url: '/api/me', headers: hlHeaders('hl-sam', 'Sam', 'admin') })]);
    expect([x.json().person.role, y.json().person.role].sort()).toEqual(['admin', 'adult']);
    expect(members(db).filter((p) => p.role === 'admin')).toHaveLength(1);
  });

  it('a kid never arrives by themselves, and a waiting person Homeward makes a kid is gone', () => {
    const db = household();
    expect(arrive(db, { externalId: 'hl-tot', name: 'Tot', role: 'kid', via: 'homerslab' })).toEqual({ kind: 'refused' });
    expect(db.select().from(t.person).where(eq(t.person.externalId, 'hl-tot')).all()).toEqual([]);
    expect(arrive(db, { externalId: 'hl-jo', name: 'Jo', role: 'adult', via: 'homerslab' })).toMatchObject({ kind: 'waiting', joined: true });
    expect(arrive(db, { externalId: 'hl-jo', name: 'Jo', role: 'kid', via: 'homerslab' })).toEqual({ kind: 'refused' });
    expect(waitingPeople(db)).toEqual([]);
  });

  it(`at most ${WAITING.max} wait: a full list stores no one new, and the newcomer gets the same answer`, async () => {
    const { app: a, db } = await app(homerslab());
    for (let i = 0; i < WAITING.max; i++) expect((await a.inject({ url: '/api/me', headers: hlHeaders(`hl-w${i}`, `W${i}`, 'adult') })).json()).toEqual(WAITING_ANSWER);
    const late = await a.inject({ url: '/api/me', headers: hlHeaders('hl-late', 'Late', 'adult') });
    expect(late.statusCode).toBe(403);
    expect(late.json()).toEqual(WAITING_ANSWER);
    expect(waitingPeople(db)).toHaveLength(WAITING.max);
    expect(db.select().from(t.person).where(eq(t.person.externalId, 'hl-late')).all()).toEqual([]);
    // the web app's first call says the same: waiting, and no person (nothing is stored for them)
    const s = await a.inject({ url: '/api/auth/session', headers: hlHeaders('hl-late', 'Late', 'adult') });
    expect(s.json()).toEqual({ mode: 'homerslab', setupNeeded: false, signedIn: true, waiting: true });
    expect(db.select().from(t.person).where(eq(t.person.externalId, 'hl-late')).all()).toEqual([]);
    // once one is decided, there is room
    decline(db, waitingPeople(db)[0]!.id);
    await a.inject({ url: '/api/me', headers: hlHeaders('hl-late', 'Late', 'adult') });
    expect(waitingPeople(db).map((p) => p.name)).toContain('Late');
  });
});

describe('the admins are told', () => {
  it('the Inbox has one item for admins, with the count only', async () => {
    const { app: a, db } = await app();
    waiter(db, 'p_w1');
    waiter(db, 'p_w2');
    const items = (await a.inject({ url: '/api/inbox', headers: { cookie: sessionCookie(db, 'p_alex') } })).json().items;
    const it0 = items.find((i: { id: string }) => i.id === WAITING_ID);
    expect(it0).toMatchObject({ kind: 'people_waiting', title: '2 people wait to join', waiting: { count: 2 }, found: [] });
    expect(JSON.stringify(it0)).not.toContain('Someone');
    const adults = (await a.inject({ url: '/api/inbox', headers: { cookie: sessionCookie(db, 'p_sam') } })).json().items;
    expect(adults.map((i: { id: string }) => i.id)).not.toContain(WAITING_ID);
  });

  it('a push of kind join goes to the admins\' devices only, at most JOIN_PUSH.max an hour', async () => {
    const sent: { url: string; topic: string }[] = [];
    const push: Egress = { ...nowherePush, push: async (url, _b, o) => { sent.push({ url, topic: String(o?.headers?.topic) }); return { status: 201, type: '', body: Buffer.alloc(0), url }; } };
    const db = household();
    const sub = (id: string, personId: string) => ({ id, personId, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, p256dh: RFC8291_UA_KEY, auth: 'BTBZMqHH6r4Tts7J_aSIgg', createdAt: new Date().toISOString() });
    db.insert(t.pushSubscription).values([sub('ps-alex', 'p_alex'), sub('ps-sam', 'p_sam')]).run();
    const { app: a } = await app(homerslab(), db, push);
    await a.inject({ url: '/api/me', headers: HL_ALEX }); // the edge sends Alex: an admin it still sends (person.seen_at)
    for (let i = 0; i < JOIN_PUSH.max + 2; i++) await a.inject({ url: '/api/me', headers: hlHeaders(`hl-n${i}`, `N${i}`, 'adult') });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(JOIN_PUSH.max);
    expect(new Set(sent.map((s) => s.url))).toEqual(new Set(['https://fcm.googleapis.com/fcm/send/ps-alex']));
    expect(new Set(sent.map((s) => s.topic))).toEqual(new Set(['join']));
  });
});

describe('nothing is written for a waiting person', () => {
  it('the Inbox\'s summary items come on top of a page\'s limit: a small page still leads to the rest', async () => {
    const { app: a, db } = await app();
    const { inboxItems } = await import('./helpers');
    inboxItems(db);
    waiter(db, 'p_wait');
    const page = (await a.inject({ url: '/api/inbox?limit=1', headers: { cookie: sessionCookie(db, 'p_alex') } })).json();
    expect(page.items.map((i: { kind: string }) => i.kind)).toEqual(['people_waiting', 'mail_unverified', expect.any(String)]);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it('a seed import never takes a waiting person for the member of the same name', () => {
    const db = openDb(':memory:');
    db.insert(t.person).values({ id: 'p_wait', externalId: 'hl-x', name: 'Alex', role: 'adult', state: 'waiting', arrivedAt: new Date().toISOString() }).run();
    importSeed(db, fileURLToPath(new URL('../../../seed-sample', import.meta.url)), '2026-11-01T00:00:00.000Z');
    expect(db.select().from(t.person).where(eq(t.person.id, 'p_wait')).get()).toMatchObject({ state: 'waiting', handle: null });
    expect(db.select().from(t.candidate).where(eq(t.candidate.personId, 'p_wait')).all()).toEqual([]);
    expect(members(db).map((p) => p.name)).toContain('Alex');
  });
});

describe('a household of one', () => {
  it('a waiting person does not make a second person: /me lists the members only', async () => {
    const { app: a, db } = await app();
    for (const id of ['p_sam', 'p_del', 'p_kid1']) db.delete(t.person).where(eq(t.person.id, id)).run();
    waiter(db, 'p_wait');
    const me = (await a.inject({ url: '/api/me', headers: { cookie: sessionCookie(db, 'p_alex') } })).json();
    expect(me.household.map((p: { id: string }) => p.id)).toEqual(['p_alex']);
    approve(db, 'p_wait', 'adult');
    const after = (await a.inject({ url: '/api/me', headers: { cookie: sessionCookie(db, 'p_alex') } })).json();
    expect(after.household.map((p: { id: string }) => p.id)).toEqual(['p_alex', 'p_wait']);
  });
});
