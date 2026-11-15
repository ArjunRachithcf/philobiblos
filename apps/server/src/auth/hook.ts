// Deny by default (ADR 0009, ADR 0010). Every /api route needs a person unless its config says otherwise:
// - 'public': /health and the sign-in steps;
// - 'person-or-share-token': POST /shares, which also takes a phone share token (Authorization: Bearer);
// - 'person' (the default): a household adult, from the HomersLab headers sent by the trusted proxy (homerslab
//   mode) or from a passkey session cookie (standalone).
// A share token is good for POST /shares and nothing else. Kids, and people HomersLab sends without a role, get 403.
// A request that changes something must come from Shelf's own origin (the Origin header), unless it carries a share
// token (an iOS Shortcut sends no Origin, and a token is not an ambient credential).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { getPerson, syncHomersLabPerson } from '../household/people';
import { resolveIdentity } from '../identity';
import { SESSION_COOKIE, sessionPerson } from './sessions';
import { hashToken } from './tokens';

export type AuthMode = 'public' | 'person' | 'person-or-share-token';

export interface Caller { personId: string; role: 'admin' | 'adult'; via: 'homerslab' | 'session' | 'share-token' }

declare module 'fastify' {
  interface FastifyContextConfig { auth?: AuthMode }
  interface FastifyRequest { caller?: Caller }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(h) : null;
  return m ? m[1]! : null;
}

export function authHook(cfg: Config, db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const mode: AuthMode = req.routeOptions.config.auth ?? 'person';
    const token = mode === 'person-or-share-token' ? bearer(req) : null;

    if (!SAFE.has(req.method) && !token) {
      const origin = req.headers.origin;
      if (origin !== undefined ? origin !== cfg.origin : cfg.mode === 'standalone') {
        return reply.code(403).send({ error: 'request from another origin refused' });
      }
    }
    if (mode === 'public') return;

    const identity = resolveIdentity(cfg, req.socket.remoteAddress, req.headers);
    if (identity) {
      if (!identity.role) return reply.code(403).send({ error: 'not allowed' });
      const p = syncHomersLabPerson(db, { ...identity, role: identity.role });
      if (p.role === 'kid') return reply.code(403).send({ error: 'not allowed' });
      req.caller = { personId: p.id, role: p.role, via: 'homerslab' };
      return;
    }
    if (cfg.mode === 'standalone') {
      const personId = sessionPerson(db, req.cookies?.[SESSION_COOKIE]);
      const p = personId ? getPerson(db, personId) : undefined;
      if (p) {
        if (p.role === 'kid') return reply.code(403).send({ error: 'not allowed' });
        req.caller = { personId: p.id, role: p.role, via: 'session' };
        return;
      }
    }
    if (token) {
      const row = db.select().from(t.shareToken).where(and(eq(t.shareToken.tokenHash, hashToken(token)), isNull(t.shareToken.revokedAt))).get();
      const p = row ? getPerson(db, row.personId) : undefined;
      if (row && p && p.role !== 'kid') {
        db.update(t.shareToken).set({ lastUsedAt: new Date().toISOString() }).where(eq(t.shareToken.id, row.id)).run();
        req.caller = { personId: p.id, role: p.role, via: 'share-token' };
        return;
      }
    }
    return reply.code(401).send({ error: 'sign in required' });
  };
}

/** For admin-only routes, inside a handler: false (and a 403 sent) unless the caller is an admin. */
export function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.caller?.role === 'admin') return true;
  void reply.code(403).send({ error: 'admins only' });
  return false;
}
