// Deny by default (ADR 0009, ADR 0010). Every /api route needs a person unless its config says otherwise:
// - 'public': /health and the sign-in steps;
// - 'person-or-share-token': POST /shares, which also takes a phone share token (Authorization: Bearer);
// - 'person' (the default): a household adult, from the HomersLab headers sent by the trusted edge (homerslab mode)
//   or from a passkey session cookie (standalone).
// A request with a share token is authenticated by that token and nothing else (no fallback to a cookie or a
// header), and it is the only kind that may change something without Origin: an iOS Shortcut sends none, and a token
// is not an ambient credential. Every other change must carry Philobiblos's own Origin, in both modes.
// A share token is good for POST /shares and nothing else. Kids, and people HomersLab sends without a role, get 403.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { getPerson, syncHomersLabPerson } from '../household/people';
import { resolveIdentity } from '../identity';
import { requestSession } from './cookie';
import type { Session } from './sessions';
import { Limiter, findShareToken } from '../shares/tokens';

export type AuthMode = 'public' | 'person' | 'person-or-share-token';

export interface Caller { personId: string; role: 'admin' | 'adult'; via: 'homerslab' | 'session' | 'share-token'; session?: Session; tokenId?: string }

declare module 'fastify' {
  interface FastifyContextConfig { auth?: AuthMode }
  interface FastifyRequest { caller?: Caller }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Wrong share tokens: counted per address and per the token id they name, 10 in 10 minutes, after which a wrong one is
 * answered 429 instead of 401. A valid token is never refused: the token is looked up first (by its id, one indexed
 * read), so a stranger behind the same proxy cannot hold the household's Shortcuts back.
 */
export const TOKEN_FAILURES = { max: 10, windowMs: 10 * 60_000 };

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(h) : null;
  return m ? m[1]! : null;
}

export function authHook(cfg: Config, db: Db) {
  const failures = new Limiter(TOKEN_FAILURES.max, TOKEN_FAILURES.windowMs);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const mode: AuthMode = req.routeOptions.config.auth ?? 'person';
    const token = mode === 'person-or-share-token' && req.headers.authorization !== undefined ? bearer(req) : null;

    if (mode === 'person-or-share-token' && req.headers.authorization !== undefined) {
      // A share token, and only that.
      const row = token ? findShareToken(db, token) : null;
      const p = row ? getPerson(db, row.personId) : undefined;
      if (!row || !p || p.role === 'kid') {
        const byAddress = failures.hit(`a:${req.socket.remoteAddress ?? ''}`);
        const byId = failures.hit(`t:${(token ?? '').slice(0, 26)}`);
        return byAddress && byId ? reply.code(401).send({ error: 'sign in required' }) : reply.code(429).send({ error: 'too many wrong share tokens: wait a few minutes' });
      }
      db.update(t.shareToken).set({ lastUsedAt: new Date().toISOString() }).where(eq(t.shareToken.id, row.id)).run();
      req.caller = { personId: p.id, role: p.role, via: 'share-token', tokenId: row.id };
      return;
    }

    if (!SAFE.has(req.method) && req.headers.origin !== cfg.origin) {
      return reply.code(403).send({ error: 'request from another origin refused' });
    }
    if (mode === 'public') return;

    if (cfg.mode === 'homerslab') {
      const identity = resolveIdentity(cfg, req.socket.remoteAddress, req.headers);
      if (identity) {
        if (!identity.role) return reply.code(403).send({ error: 'not allowed' });
        const p = syncHomersLabPerson(db, { ...identity, role: identity.role });
        if (p.role === 'kid') return reply.code(403).send({ error: 'not allowed' });
        req.caller = { personId: p.id, role: p.role, via: 'homerslab' };
        return;
      }
    } else {
      const s = requestSession(db, req, reply);
      const p = s ? getPerson(db, s.personId) : undefined;
      if (s && p) {
        if (p.role === 'kid') return reply.code(403).send({ error: 'not allowed' });
        req.caller = { personId: p.id, role: p.role, via: 'session', session: s };
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
