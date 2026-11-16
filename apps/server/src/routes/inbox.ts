// The Inbox, phone shares and share tokens (M3 e; contracts/openapi.yaml tag inbox). The rules are in src/inbox/ and
// src/shares/; who may do what is in their headers, and the threat model in docs/security.md.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../config';
import type { Db } from '../db/open';
import { FILTERS, InboxError, PAGE, decide, dismiss, listInbox, parseCursor, type Filter } from '../inbox/inbox';
import { SHARE_RATE, ShareError, ownShare, receiveShare, shareView, type ShareProcessor } from '../shares/shares';
import { Limiter, TokenError, createShareToken, revokeShareToken, tokenView } from '../shares/tokens';
import * as t from '../db/schema';
import { eq } from 'drizzle-orm';

export async function inboxRoutes(app: FastifyInstance, cfg: Config, db: Db, shares: ShareProcessor) {
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof InboxError || e instanceof ShareError || e instanceof TokenError) return reply.code(e.status).send({ error: e.message });
    throw e;
  };

  app.get<{ Querystring: { filter?: string; cursor?: string; limit?: string } }>('/inbox', async (req, reply) => {
    const f = req.query.filter ?? 'all';
    if (!FILTERS.includes(f as Filter)) return reply.code(400).send({ error: `filter: ${FILTERS.join(', ')}` });
    const cursor = req.query.cursor === undefined ? null : parseCursor(req.query.cursor);
    if (req.query.cursor !== undefined && !cursor) return reply.code(400).send({ error: 'cursor: the nextCursor of the page before' });
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > PAGE.max)) return reply.code(400).send({ error: `limit: 1 to ${PAGE.max}` });
    return listInbox(db, req.caller!.personId, f as Filter, { cursor, limit });
  });
  app.post<{ Params: { itemId: string; index: string } }>('/inbox/:itemId/books/:index', async (req, reply) => {
    const index = /^\d{1,4}$/.test(req.params.index) ? Number(req.params.index) : -1;
    try { return decide(db, req.caller!.personId, req.params.itemId, index, req.body); } catch (e) { return fail(reply, e); }
  });
  app.post<{ Params: { itemId: string } }>('/inbox/:itemId/dismiss', async (req, reply) => {
    try { dismiss(db, req.caller!.personId, req.params.itemId); return reply.code(204).send(); } catch (e) { return fail(reply, e); }
  });

  // A share from the PWA (through its service worker, so with Philobiblos's Origin and session) or a Shortcut (its token).
  const rate = new Limiter(SHARE_RATE.max, SHARE_RATE.windowMs);
  app.post('/shares', { config: { auth: 'person-or-share-token' } }, async (req, reply) => {
    const me = req.caller!.personId;
    if (!rate.hit(me)) return reply.code(429).send({ error: 'too many shares: wait a few minutes' });
    try {
      const row = await receiveShare(req, db, { dataDir: cfg.dataDir, workDir: cfg.workDir, personId: me, tokenId: req.caller!.tokenId });
      // Files go to the media worker first; either way the AI reads the share after (ShareProcessor's `after`).
      void shares.kick();
      return reply.code(202).send({ id: row.id, status: row.status });
    } catch (e) { return fail(reply, e); }
  });
  app.get<{ Params: { id: string } }>('/shares/:id', async (req, reply) => {
    const s = ownShare(db, req.caller!.personId, req.params.id);
    return s ? shareView(s) : reply.code(404).send({ error: 'no such share' });
  });

  app.get('/share-tokens', async (req) =>
    db.select().from(t.shareToken).where(eq(t.shareToken.personId, req.caller!.personId)).all().map(tokenView));
  app.post<{ Body: { label?: unknown } }>('/share-tokens', async (req, reply) => {
    try {
      // The token is in this response only; the database keeps its SHA-256.
      const { row, token } = createShareToken(db, req.caller!.personId, req.body?.label);
      return reply.code(201).send({ ...tokenView(row), token });
    } catch (e) { return fail(reply, e); }
  });
  app.delete<{ Params: { id: string } }>('/share-tokens/:id', async (req, reply) => {
    revokeShareToken(db, req.caller!.personId, req.params.id);
    return reply.code(204).send();
  });
}
