// The household (ADR 0001): everyone signed in sees it; admins change it. Under HomersLab, people are managed in
// HomersLab and arrive with each request, so the changes here answer 409.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, count, eq } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { requireAdmin } from '../auth/hook';
import { createInvite } from '../auth/invites';
import { HouseholdError, addPerson, editPerson, getPerson, household, removePerson, view, type PersonInput } from '../household/people';

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
    void reply.code(409).send({ error: 'people are managed in HomersLab' });
    return true;
  };

  app.get('/me', async (req) => ({
    person: view(db, getPerson(db, req.caller!.personId)!),
    household: household(db).map((p) => view(db, p)),
    mode: cfg.mode,
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
    const { url, expiresAt } = createInvite(db, cfg, { purpose: 'enrol', personId: p.id, createdBy: req.caller!.personId });
    return reply.code(201).send({ url, expiresAt: expiresAt.toISOString() });
  });

  app.get('/me/passkeys', async (req) =>
    db.select().from(t.passkey).where(eq(t.passkey.personId, req.caller!.personId)).all()
      .map((k) => ({ id: k.id, label: k.label, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, backedUp: k.backedUp === 1 })));

  app.delete<{ Params: { id: string } }>('/me/passkeys/:id', async (req, reply) => {
    const mine = and(eq(t.passkey.id, req.params.id), eq(t.passkey.personId, req.caller!.personId));
    if (!db.select().from(t.passkey).where(mine).get()) return reply.code(404).send({ error: 'no such passkey of yours' });
    const n = db.select({ n: count() }).from(t.passkey).where(eq(t.passkey.personId, req.caller!.personId)).get()?.n ?? 0;
    if (n <= 1) return reply.code(409).send({ error: 'your last passkey stays' });
    db.delete(t.passkey).where(mine).run();
    return reply.code(204).send();
  });
}
