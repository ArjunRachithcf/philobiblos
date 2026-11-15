// Deny by default (ADR 0009). Every /api route needs a person unless its config says otherwise:
// - 'public': /health only;
// - 'person-or-share-token': POST /shares, which also takes a phone share token (Authorization: Bearer);
// - 'person' (the default): a household adult, from X-HomersLab-Person sent by the trusted proxy (homerslab mode) or
//   a passkey session (standalone; sign-in arrives in M1, so until then standalone answers 401).
// A share token is good for POST /shares and nothing else. Kids, and people not in the household, get 403.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import type { Config } from './config';
import type { Db } from './db/open';
import * as t from './db/schema';
import { resolveIdentity } from './identity';

export type AuthMode = 'public' | 'person' | 'person-or-share-token';

export interface Caller { personId: string; via: 'homerslab' | 'session' | 'share-token' }

declare module 'fastify' {
  interface FastifyContextConfig { auth?: AuthMode }
  interface FastifyRequest { caller?: Caller }
}

export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(h) : null;
  return m ? m[1]! : null;
}

export function authHook(cfg: Config, db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const mode: AuthMode = req.routeOptions.config.auth ?? 'person';
    if (mode === 'public') return;

    const identity = resolveIdentity(cfg, req.socket.remoteAddress, req.headers);
    if (identity) {
      const person = db.select().from(t.person).where(eq(t.person.externalId, identity.externalId)).get();
      if (!person || person.role === 'kid') return reply.code(403).send({ error: 'not allowed' });
      req.caller = { personId: person.id, via: 'homerslab' };
      return;
    }
    if (mode === 'person-or-share-token') {
      const token = bearer(req);
      if (token) {
        const row = db.select().from(t.shareToken).where(and(eq(t.shareToken.tokenHash, hashToken(token)), isNull(t.shareToken.revokedAt))).get();
        if (row) {
          db.update(t.shareToken).set({ lastUsedAt: new Date().toISOString() }).where(eq(t.shareToken.id, row.id)).run();
          req.caller = { personId: row.personId, via: 'share-token' };
          return;
        }
      }
    }
    return reply.code(401).send({ error: 'sign in required' });
  };
}
