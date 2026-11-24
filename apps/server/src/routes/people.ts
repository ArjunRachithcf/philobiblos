// The household (ADR 0001): everyone signed in sees it; admins change it. Under HomersLab, people are managed in
// HomersLab and arrive with each request, so the changes here answer 409, except deciding who waits (ADR 0011).
// Waiting people (household/waiting.ts): admins list them, and approve or decline each with a fresh sign-in, in both
// modes; at most WAITING_DECISIONS an admin in its window (429 past it). An unknown id and a member's get the same 404.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, count, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { requireAdmin, requireFreshSignIn } from '../auth/hook';
import { getMoney } from '../household/money';
import { createInvite } from '../auth/invites';
import { clearSessionCookies } from '../auth/cookie';
import { endAllSessions, isFresh } from '../auth/sessions';
import { HouseholdError, addPerson, adminView, editPerson, getPerson, household, removePerson, view, type PersonInput } from '../household/people';
import { approve, decline, waitingPeople } from '../household/waiting';
import { Limiter } from '../shares/tokens';

/** Approvals and declines an admin may make: 30 in 10 minutes. */
export const WAITING_DECISIONS = { max: 30, windowMs: 10 * 60_000 };

const ROLES = new Set(['admin', 'adult', 'kid']);
const HANDLE = /^[a-z][a-z0-9-]{0,19}$/;

/** Validates a body against contracts/openapi.yaml's PersonInput / PersonPatch; an error string or the input. */
function parse(body: unknown, partial: boolean): Partial<PersonInput> | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'a JSON object is needed';
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!['name', 'role', 'handle', 'birthYear'].includes(k)) return `unknown field ${k}`;
  const out: Partial<PersonInput> = {};
  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 60) return 'name: 1 to 60 characters';
    out.name = b.name;
  } else if (!partial) return 'name is required';
  if (b.role !== undefined) {
    if (typeof b.role !== 'string' || !ROLES.has(b.role)) return 'role: admin, adult or kid';
    out.role = b.role as PersonInput['role'];
  } else if (!partial) return 'role is required';
  if (b.handle !== undefined) {
    if (b.handle === null && partial) out.handle = null;
    else if (typeof b.handle !== 'string' || !HANDLE.test(b.handle)) return 'handle: lower-case letters, digits and -, starting with a letter';
    else out.handle = b.handle;
  }
  if (b.birthYear !== undefined) {
    if (b.birthYear === null && partial) out.birthYear = null;
    else if (!Number.isInteger(b.birthYear) || (b.birthYear as number) < 2000 || (b.birthYear as number) > 2100) return 'birthYear: a year from 2000';
    else out.birthYear = b.birthYear as number;
  }
  return out;
}

export async function peopleRoutes(app: FastifyInstance, cfg: Config, db: Db) {
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof HouseholdError) return reply.code(e.status).send({ error: e.message });
    throw e;
  };
  const managedElsewhere = (reply: FastifyReply) => {
    if (cfg.mode === 'standalone') return false;
    void reply.code(409).send({ error: 'people are managed in Homeward' });
    return true;
  };
  // Passkeys and sessions are Philobiblos's own only in standalone mode; under HomersLab these routes do not exist.
  const standaloneOnly = (reply: FastifyReply) => {
    if (cfg.mode === 'standalone') return true;
    void reply.code(404).send({ error: 'Homeward holds the passkeys' });
    return false;
  };
  // Adding a passkey (to anyone) needs a sign-in of the last few minutes: an old, stolen cookie cannot.
  const fresh = (req: FastifyRequest, reply: FastifyReply) => {
    const s = req.caller?.session;
    if (s && isFresh(s)) return true;
    void reply.code(403).send({ error: 'sign in again to do this' });
    return false;
  };
  const hasPasskey = (personId: string) => Boolean(db.select({ id: t.passkey.id }).from(t.passkey).where(eq(t.passkey.personId, personId)).get());

  const decisions = new Limiter(WAITING_DECISIONS.max, WAITING_DECISIONS.windowMs);
  // Who may decide: an admin, with a fresh sign-in (both modes; refused under HomersLab until homeward#253), within the
  // rate limit; all of it before the id is looked at, so nothing about who waits shows to anyone else.
  const mayDecide = (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(req, reply) || !requireFreshSignIn(req, reply)) return false;
    if (decisions.hit(req.caller!.personId)) return true;
    void reply.code(429).send({ error: 'too many decisions at once: wait a few minutes' });
    return false;
  };

  app.get('/people/waiting', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const people = waitingPeople(db);
    // What each request says (household/join-links.ts): the link used, who made it, and the household's networks.
    const by = alias(t.person, 'by');
    const requests = new Map(db.select({ r: t.joinRequest, link: t.joinLink, by: by.name }).from(t.joinRequest)
      .leftJoin(t.joinLink, eq(t.joinLink.id, t.joinRequest.joinLinkId)).leftJoin(by, eq(by.id, t.joinLink.createdBy)).all()
      .map((x) => [x.r.personId, x]));
    return people.map((p) => {
      const r = requests.get(p.id);
      return {
      id: p.id, name: p.name, arrivedAt: p.arrivedAt, via: p.externalId ? 'homeward' as const : 'join_link' as const,
      joinLink: r?.link ? { id: r.link.id, createdAt: r.link.createdAt, createdBy: r.by ?? null } : null,
      fromHomeNetwork: r ? r.r.fromHomeNetwork === 1 : null,
      // Whether they matched their link's own rules (slice 3); null when it has none beyond the household's (or from
      // Homeward). Never a reason to approve by itself.
      matchesRules: r && r.r.matchesRules !== null ? r.r.matchesRules === 1 : null,
      // Slices 4a and 4b of philobiblos#34 fill this: a verified address.
      verifiedAddress: null,
      // Under HomersLab, the most they may be: their Homeward role.
      mayBeAdmin: !p.ceiling || p.ceiling === 'admin',
      };
    });
  });

  app.post<{ Params: { personId: string } }>('/people/waiting/:personId/approve', async (req, reply) => {
    if (!mayDecide(req, reply)) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'role') || (b.role !== undefined && b.role !== 'adult' && b.role !== 'admin')) {
      return reply.code(400).send({ error: 'role: adult (the default) or admin' });
    }
    try { return view(db, approve(db, req.params.personId, (b.role as 'adult' | 'admin' | undefined) ?? 'adult')); } catch (e) { return fail(reply, e); }
  });

  app.post<{ Params: { personId: string } }>('/people/waiting/:personId/decline', async (req, reply) => {
    if (!mayDecide(req, reply)) return;
    try { decline(db, req.params.personId); return reply.code(204).send(); } catch (e) { return fail(reply, e); }
  });

  app.get('/me', async (req) => ({
    person: view(db, getPerson(db, req.caller!.personId)!),
    // Admin-only fields (adminView) in an admin's list only; every other person view is view()'s.
    household: household(db).map((p) => (req.caller!.role === 'admin' ? adminView : view)(db, p)),
    mode: cfg.mode,
    // The household's currency and unknown price: every screen writes amounts in it (household/money.ts).
    money: getMoney(db),
  }));

  app.post('/people', async (req, reply) => {
    if (!requireAdmin(req, reply) || managedElsewhere(reply)) return;
    const input = parse(req.body, false);
    if (typeof input === 'string') return reply.code(400).send({ error: input });
    try { return reply.code(201).send(view(db, addPerson(db, input as PersonInput))); } catch (e) { return fail(reply, e); }
  });

  app.patch<{ Params: { personId: string } }>('/people/:personId', async (req, reply) => {
    if (!requireAdmin(req, reply) || managedElsewhere(reply)) return;
    const input = parse(req.body, true);
    if (typeof input === 'string') return reply.code(400).send({ error: input });
    try { return view(db, editPerson(db, req.params.personId, input)); } catch (e) { return fail(reply, e); }
  });

  app.delete<{ Params: { personId: string } }>('/people/:personId', async (req, reply) => {
    if (!requireAdmin(req, reply) || managedElsewhere(reply)) return;
    try { removePerson(db, req.params.personId, req.caller!.personId); return reply.code(204).send(); } catch (e) { return fail(reply, e); }
  });

  app.post<{ Params: { personId: string } }>('/people/:personId/invites', async (req, reply) => {
    if (!requireAdmin(req, reply) || managedElsewhere(reply)) return;
    const p = getPerson(db, req.params.personId);
    if (!p) return reply.code(404).send({ error: 'no such person' });
    if (p.role === 'kid') return reply.code(409).send({ error: 'kids never sign in; adults act for them' });
    // Once someone has a passkey, only they add more (an admin cannot slip a passkey into an adult's account).
    if (hasPasskey(p.id)) return reply.code(409).send({ error: 'they already sign in; they add passkeys themselves' });
    if (!fresh(req, reply)) return;
    const { url, expiresAt } = createInvite(db, cfg, { kind: 'admin', personId: p.id, createdBy: req.caller!.personId });
    return reply.code(201).send({ url, expiresAt: expiresAt.toISOString() });
  });

  app.get('/me/passkeys', async (req, reply) => {
    if (!standaloneOnly(reply)) return;
    const by = alias(t.person, 'by');
    return db.select({ k: t.passkey, by: by.name }).from(t.passkey).leftJoin(by, eq(by.id, t.passkey.invitedBy))
      .where(eq(t.passkey.personId, req.caller!.personId)).all()
      .map(({ k, by }) => ({ id: k.id, label: k.label, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, backedUp: k.backedUp === 1, invitedBy: by ?? null }));
  });

  app.post('/me/passkeys/invite', async (req, reply) => {
    if (!standaloneOnly(reply) || !fresh(req, reply)) return;
    const me = req.caller!.personId;
    const { url, expiresAt } = createInvite(db, cfg, { kind: 'self', personId: me, createdBy: me });
    return reply.code(201).send({ url, expiresAt: expiresAt.toISOString() });
  });

  app.post('/me/sessions/end', async (req, reply) => {
    if (!standaloneOnly(reply)) return;
    endAllSessions(db, req.caller!.personId);
    return clearSessionCookies(reply).code(204).send();
  });

  app.delete<{ Params: { id: string } }>('/me/passkeys/:id', async (req, reply) => {
    if (!standaloneOnly(reply)) return;
    const mine = and(eq(t.passkey.id, req.params.id), eq(t.passkey.personId, req.caller!.personId));
    if (!db.select().from(t.passkey).where(mine).get()) return reply.code(404).send({ error: 'no such passkey of yours' });
    const n = db.select({ n: count() }).from(t.passkey).where(eq(t.passkey.personId, req.caller!.personId)).get()?.n ?? 0;
    if (n <= 1) return reply.code(409).send({ error: 'your last passkey stays' });
    db.delete(t.passkey).where(mine).run(); // its sessions end with it (ON DELETE CASCADE)
    return reply.code(204).send();
  });
}
