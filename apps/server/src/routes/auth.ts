// Sign-in (ADR 0010). Standalone only: under HomersLab these answer 404 (Homeward signs people in).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { findInvite, openRecovery, removeSetupLink, spendInvites, useInvite } from '../auth/invites';
import { clearSessionCookies, endRequestSessions, requestSession, startSession } from '../auth/cookie';
import type { Challenges, WebAuthn } from '../auth/webauthn';
import { getPerson, setupNeeded, suggestHandle, view } from '../household/people';
import { anyPerson, arrive } from '../household/waiting';
import { resolveIdentity } from '../identity';

const limited = { auth: 'public' as const, rateLimit: { max: 20, timeWindow: '1 minute' } };

export async function authRoutes(app: FastifyInstance, cfg: Config, db: Db, webauthn: WebAuthn, challenges: Challenges, joined?: () => void) {
  const standaloneOnly = (reply: FastifyReply) => {
    if (cfg.mode === 'standalone') return true;
    void reply.code(404).send({ error: 'Homeward signs people in' });
    return false;
  };
  // A sign-in replaces this browser's earlier session, and remembers the passkey (removing it ends the session).
  const signIn = (req: FastifyRequest, reply: FastifyReply, personId: string, passkeyId: string) => {
    startSession(db, req, reply, personId, passkeyId);
    const p = anyPerson(db, personId)!;
    return { mode: cfg.mode, signedIn: true, setupNeeded: false, ...(p.state === 'waiting' ? { waiting: true } : {}), person: view(db, p) };
  };

  // Who this is. Under HomersLab it is where a person the edge sends first arrives (household/waiting.ts arrive), as at
  // any other route. A waiting person is signed in and `waiting`, with their own name only.
  app.get('/auth/session', { config: { auth: 'public' } }, async (req: FastifyRequest, reply: FastifyReply) => {
    const base = { mode: cfg.mode, setupNeeded: cfg.mode === 'standalone' && setupNeeded(db) };
    let p: ReturnType<typeof anyPerson> | null;
    if (cfg.mode === 'standalone') {
      const personId = requestSession(db, req, reply)?.personId;
      p = personId ? anyPerson(db, personId) ?? null : null;
    } else {
      const id = resolveIdentity(cfg, req.socket.remoteAddress, req.headers);
      const a = id?.role ? arrive(db, { ...id, role: id.role }) : null;
      if (a?.kind === 'waiting' && a.joined) joined?.();
      if (a?.kind === 'waiting') return { ...base, signedIn: true, waiting: true, ...(a.person ? { person: view(db, a.person) } : {}) };
      p = a?.kind === 'member' ? a.person : null;
    }
    if (!p || p.role === 'kid') return { ...base, signedIn: false };
    return { ...base, signedIn: true, ...(p.state === 'waiting' ? { waiting: true } : {}), person: view(db, p) };
  });

  app.post<{ Body: { token?: unknown; name?: unknown } }>('/auth/enrol/options', { config: limited }, async (req, reply) => {
    if (!standaloneOnly(reply)) return;
    const invite = findInvite(db, req.body?.token);
    if (!invite) return reply.code(401).send({ error: 'this link is unknown, used or expired' });
    if (invite.kind === 'setup') {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 60) : '';
      if (!name) return reply.code(400).send({ error: 'a name is needed' });
      const { challenge, options } = await webauthn.registrationOptions({ userId: `setup:${invite.id}`, userName: name, exclude: [] });
      return { challengeId: challenges.put({ challenge, kind: 'enrol', inviteId: invite.id, name }), options, person: { name } };
    }
    const p = invite.personId ? getPerson(db, invite.personId) : undefined;
    if (!p || p.role === 'kid') return reply.code(401).send({ error: 'this link is unknown, used or expired' });
    const exclude = db.select().from(t.passkey).where(eq(t.passkey.personId, p.id)).all()
      .map((k) => ({ id: k.id, publicKey: k.publicKey, counter: k.counter, transports: JSON.parse(k.transportsJson) as string[] }));
    const { challenge, options } = await webauthn.registrationOptions({ userId: p.id, userName: p.name, exclude });
    return { challengeId: challenges.put({ challenge, kind: 'enrol', inviteId: invite.id }), options, person: { name: p.name } };
  });

  app.post<{ Body: { challengeId?: unknown; response?: unknown; label?: unknown } }>('/auth/enrol/verify', { config: limited }, async (req, reply) => {
    if (!standaloneOnly(reply)) return;
    const pending = challenges.take(req.body?.challengeId, 'enrol');
    if (!pending?.inviteId) return reply.code(401).send({ error: 'this sign-in step expired; start again' });
    const cred = await webauthn.verifyRegistration({ response: req.body?.response, challenge: pending.challenge });
    if (!cred) return reply.code(401).send({ error: 'the passkey could not be verified' });
    // One answer, whoever's passkey it is.
    const taken = () => reply.code(409).send({ error: 'this passkey is already enrolled' });
    if (db.select({ id: t.passkey.id }).from(t.passkey).where(eq(t.passkey.id, cred.id)).get()) return taken();
    const label = typeof req.body?.label === 'string' && req.body.label.trim() ? req.body.label.trim().slice(0, 40) : 'Passkey';
    const now = new Date().toISOString();
    let personId: string | null = null;
    let recovery = false;
    try { db.transaction((tx) => {
      const invite = tx.select().from(t.invite).where(eq(t.invite.id, pending.inviteId!)).get();
      if (!invite || !useInvite(tx as unknown as Db, invite.id)) return;
      if (invite.kind === 'setup') {
        // The first admin: an admin of the household with this name and no passkey yet (an imported household),
        // or a new one.
        const name = pending.name ?? 'Admin';
        const claim = tx.select().from(t.person).where(and(eq(t.person.role, 'admin'), eq(t.person.name, name))).all()
          .find((a) => !tx.select().from(t.passkey).where(eq(t.passkey.personId, a.id)).get());
        personId = claim?.id ?? ulid();
        if (!claim) tx.insert(t.person).values({ id: personId, name, role: 'admin', handle: suggestHandle(tx as unknown as Db, name), settingsJson: '{}' }).run();
      } else {
        personId = invite.personId;
        recovery = invite.kind === 'recovery';
        // An admin's invite is for someone's first passkey only: after that, only they add more.
        if (invite.kind === 'admin' && personId && tx.select({ id: t.passkey.id }).from(t.passkey).where(eq(t.passkey.personId, personId)).get()) {
          personId = null;
        }
      }
      if (!personId) return;
      tx.insert(t.passkey).values({
        id: cred.id, personId, publicKey: Buffer.from(cred.publicKey), counter: cred.counter,
        transportsJson: JSON.stringify(cred.transports), backedUp: cred.backedUp ? 1 : 0, label, createdAt: now,
        invitedBy: invite.kind === 'admin' ? invite.createdBy : null,
      }).run();
      spendInvites(tx as unknown as Db, personId);
    }); } catch (e) {
      // Two enrolments of one passkey at once: the primary key decides.
      if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return taken();
      throw e;
    }
    if (!personId) return reply.code(401).send({ error: 'this link is unknown, used or expired' });
    if ((recovery || !setupNeeded(db)) && !openRecovery(db)) removeSetupLink(cfg);
    return signIn(req, reply, personId, cred.id);
  });

  app.post('/auth/sign-in/options', { config: limited }, async (_req, reply) => {
    if (!standaloneOnly(reply)) return;
    const { challenge, options } = await webauthn.authenticationOptions();
    return { challengeId: challenges.put({ challenge, kind: 'sign-in' }), options };
  });

  app.post<{ Body: { challengeId?: unknown; response?: unknown } }>('/auth/sign-in/verify', { config: limited }, async (req, reply) => {
    if (!standaloneOnly(reply)) return;
    const pending = challenges.take(req.body?.challengeId, 'sign-in');
    if (!pending) return reply.code(401).send({ error: 'this sign-in step expired; start again' });
    const id = webauthn.credentialId(req.body?.response);
    const key = id ? db.select().from(t.passkey).where(eq(t.passkey.id, id)).get() : undefined;
    // A waiting person signs in too, to the one "waiting" page (the auth hook answers them nothing else).
    const p = key ? anyPerson(db, key.personId) : undefined;
    // One answer for every failure: which passkeys exist is nobody's business.
    const refuse = () => reply.code(401).send({ error: 'that passkey did not sign you in' });
    if (!key || !p || p.role === 'kid') return refuse();
    const ok = await webauthn.verifyAuthentication({
      response: req.body?.response, challenge: pending.challenge,
      credential: { id: key.id, publicKey: key.publicKey, counter: key.counter, transports: JSON.parse(key.transportsJson) as string[] },
    });
    if (!ok) return refuse();
    db.update(t.passkey).set({ counter: ok.newCounter, lastUsedAt: new Date().toISOString() }).where(eq(t.passkey.id, key.id)).run();
    return signIn(req, reply, p.id, key.id);
  });

  app.post('/auth/sign-out', { config: { auth: 'public' } }, async (req, reply) => {
    endRequestSessions(db, req);
    return clearSessionCookies(reply).code(204).send();
  });
}
