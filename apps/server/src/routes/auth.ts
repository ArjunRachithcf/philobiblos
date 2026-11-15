// Sign-in (ADR 0010). Standalone only: under HomersLab these answer 404 (HomersLab signs people in).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { findInvite, openRecovery, removeSetupLink, useInvite } from '../auth/invites';
import { SESSION_COOKIE, SESSION_DAYS, cookieOptions, createSession, endSession, sessionPerson } from '../auth/sessions';
import type { Challenges, WebAuthn } from '../auth/webauthn';
import { getPerson, setupNeeded, suggestHandle, view } from '../household/people';
import { resolveIdentity } from '../identity';

const limited = { auth: 'public' as const, rateLimit: { max: 20, timeWindow: '1 minute' } };

export async function authRoutes(app: FastifyInstance, cfg: Config, db: Db, webauthn: WebAuthn, challenges: Challenges) {
  const standaloneOnly = (reply: FastifyReply) => {
    if (cfg.mode === 'standalone') return true;
    void reply.code(404).send({ error: 'HomersLab signs people in' });
    return false;
  };
  // A sign-in replaces this browser's earlier session, and remembers the passkey (removing it ends the session).
  const signIn = (req: FastifyRequest, reply: FastifyReply, personId: string, passkeyId: string) => {
    endSession(db, req.cookies?.[SESSION_COOKIE]);
    const { token } = createSession(db, personId, passkeyId);
    void reply.setCookie(SESSION_COOKIE, token, cookieOptions(SESSION_DAYS * 86_400));
    return { mode: cfg.mode, signedIn: true, setupNeeded: false, person: view(db, getPerson(db, personId)!) };
  };

  app.get('/auth/session', { config: { auth: 'public' } }, async (req: FastifyRequest) => {
    const id = cfg.mode === 'standalone' ? null : resolveIdentity(cfg, req.socket.remoteAddress, req.headers);
    const personId = cfg.mode === 'standalone'
      ? sessionPerson(db, req.cookies?.[SESSION_COOKIE])
      : id ? db.select().from(t.person).where(eq(t.person.externalId, id.externalId)).get()?.id ?? null : null;
    const p = personId ? getPerson(db, personId) : undefined;
    const ok = p && p.role !== 'kid';
    return { mode: cfg.mode, signedIn: Boolean(ok), setupNeeded: cfg.mode === 'standalone' && setupNeeded(db), ...(ok ? { person: view(db, p) } : {}) };
  });

  app.post<{ Body: { token?: unknown; name?: unknown } }>('/auth/enrol/options', { config: limited }, async (req, reply) => {
    if (!standaloneOnly(reply)) return;
    const invite = findInvite(db, req.body?.token);
    if (!invite) return reply.code(401).send({ error: 'this link is unknown, used or expired' });
    if (invite.purpose === 'setup') {
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
      if (invite.purpose === 'setup') {
        // The first admin: an admin of the household with this name and no passkey yet (an imported household),
        // or a new one.
        const name = pending.name ?? 'Admin';
        const claim = tx.select().from(t.person).where(and(eq(t.person.role, 'admin'), eq(t.person.name, name))).all()
          .find((a) => !tx.select().from(t.passkey).where(eq(t.passkey.personId, a.id)).get());
        personId = claim?.id ?? ulid();
        if (!claim) tx.insert(t.person).values({ id: personId, name, role: 'admin', handle: suggestHandle(tx as unknown as Db, name), settingsJson: '{}' }).run();
      } else {
        personId = invite.personId;
        recovery = invite.createdBy === null;
      }
      if (!personId) return;
      tx.insert(t.passkey).values({
        id: cred.id, personId, publicKey: Buffer.from(cred.publicKey), counter: cred.counter,
        transportsJson: JSON.stringify(cred.transports), backedUp: cred.backedUp ? 1 : 0, label, createdAt: now,
        invitedBy: invite.createdBy && invite.createdBy !== personId ? invite.createdBy : null,
      }).run();
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
    const p = key ? getPerson(db, key.personId) : undefined;
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
    endSession(db, req.cookies?.[SESSION_COOKIE]);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });
}
