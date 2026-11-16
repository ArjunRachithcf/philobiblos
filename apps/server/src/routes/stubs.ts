// M0: every route of contracts/openapi.yaml, returning example payloads. No feature logic yet.
// Authentication is the hook in src/auth.ts; share tokens are real already (they guard POST /shares).
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { hashToken, newToken } from '../auth/tokens';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { VERSION } from '../version';
import * as ex from '../stubs/examples';

export async function stubRoutes(app: FastifyInstance, cfg: Config, db: Db) {
  app.get('/health', { config: { auth: 'public' } }, async () => ({ ok: true, version: VERSION, mode: cfg.mode }));





  app.get('/inbox', async () => ex.inbox);
  app.post('/inbox/:itemId/books/:index', async () => ({}));
  app.post('/shares', { config: { auth: 'person-or-share-token' } }, async (req, reply) => {
    // M0 reads and discards the parts within the limits (SHARE_LIMITS); M3 stores them for the media worker.
    if (req.isMultipart()) {
      for await (const part of req.parts()) if (part.type === 'file') for await (const _chunk of part.file) { /* drain */ }
    }
    return reply.code(202).send({ id: 'sh_example', status: 'received' });
  });
  app.get<{ Params: { id: string } }>('/shares/:id', async (req) => ex.share(req.params.id));
  const view = (r: typeof t.shareToken.$inferSelect) => ({ id: r.id, label: r.label, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, revoked: r.revokedAt != null });
  app.get('/share-tokens', async (req) =>
    db.select().from(t.shareToken).where(eq(t.shareToken.personId, req.caller!.personId)).all().map(view));
  app.post<{ Body: { label?: unknown } }>('/share-tokens', async (req, reply) => {
    const label = typeof req.body?.label === 'string' && req.body.label.trim() ? req.body.label.trim().slice(0, 60) : 'Phone';
    // The token is in this response only; the database keeps its SHA-256.
    const token = newToken();
    const row = { id: ulid(), personId: req.caller!.personId, label, tokenHash: hashToken(token), createdAt: new Date().toISOString() };
    db.insert(t.shareToken).values(row).run();
    return reply.code(201).send({ ...view({ ...row, lastUsedAt: null, revokedAt: null }), token });
  });
  app.delete<{ Params: { id: string } }>('/share-tokens/:id', async (req, reply) => {
    db.update(t.shareToken).set({ revokedAt: new Date().toISOString() })
      .where(and(eq(t.shareToken.id, req.params.id), eq(t.shareToken.personId, req.caller!.personId))).run();
    return reply.code(204).send();
  });

}
