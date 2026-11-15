// The Backlog (spec §4, contracts/backlog-query.md). The rules are in src/backlog/.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/open';
import { BacklogError, addToBacklog, bulk, saveFilter, savedFilters } from '../backlog/actions';
import { LIMIT_MAX, getCandidate, listBacklog } from '../backlog/backlog';

export async function backlogRoutes(app: FastifyInstance, db: Db) {
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof BacklogError) return reply.code(e.status).send({ error: e.message });
    throw e;
  };

  app.get<{ Querystring: { q?: string; cursor?: string; limit?: string } }>('/backlog', async (req, reply) => {
    const { q, cursor, limit } = req.query;
    if (q !== undefined && (typeof q !== 'string' || q.length > 500)) return reply.code(400).send({ error: 'q: up to 500 characters' });
    const n = limit === undefined ? undefined : Number(limit);
    if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > LIMIT_MAX)) return reply.code(400).send({ error: `limit: 1 to ${LIMIT_MAX}` });
    return listBacklog(db, req.caller!.personId, { q, cursor, limit: n });
  });

  app.post('/backlog', async (req, reply) => {
    try {
      const id = addToBacklog(db, req.caller!.personId, req.body);
      return reply.code(201).send(getCandidate(db, id));
    } catch (e) { return fail(reply, e); }
  });

  app.post('/backlog/bulk', async (req, reply) => {
    try { return { changed: bulk(db, req.caller!.personId, req.body) }; } catch (e) { return fail(reply, e); }
  });

  app.get('/backlog/saved-filters', async (req) => savedFilters(db, req.caller!.personId));
  app.post('/backlog/saved-filters', async (req, reply) => {
    try { saveFilter(db, req.caller!.personId, req.body); return reply.code(201).send(); } catch (e) { return fail(reply, e); }
  });
}
