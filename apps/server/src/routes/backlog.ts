// The Backlog (spec §4, contracts/backlog-query.md). The rules are in src/backlog/.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../config';
import type { Db } from '../db/open';
import { MonthError, changePicks, thisMonth } from '../month/plan';
import { BacklogError, addToBacklog, bulk, removeFilter, renameFilter, saveFilter, savedFilters } from '../backlog/actions';
import { LIMIT_MAX, getCandidate, listBacklog, parseCandidateId } from '../backlog/backlog';

export async function backlogRoutes(app: FastifyInstance, cfg: Config, db: Db) {
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof BacklogError || e instanceof MonthError) return reply.code(e.status).send({ error: e.message });
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
      return reply.code(201).send(getCandidate(db, id, req.caller!.personId));
    } catch (e) { return fail(reply, e); }
  });

  app.post('/backlog/bulk', async (req, reply) => {
    try {
      const b = req.body as { ids?: unknown; action?: unknown } | null;
      if (b && typeof b === 'object' && b.action === 'add_to_month') {
        // To this month's picks (This month): all or nothing, your own candidates and the kids'.
        if (!Array.isArray(b.ids) || b.ids.length === 0 || b.ids.length > 50) throw new BacklogError(400, 'ids: 1 to 50 candidate ids');
        const add = b.ids.map((id) => {
          const k = parseCandidateId(id);
          if (!k) throw new BacklogError(400, 'ids: candidate ids from the list');
          return { bookId: k.bookId, for: k.personId };
        });
        changePicks(db, thisMonth(db), req.caller!.personId, { add });
        return { changed: add.length };
      }
      return { changed: bulk(db, req.caller!.personId, req.body) };
    } catch (e) { return fail(reply, e); }
  });

  app.get('/backlog/saved-filters', async (req) => savedFilters(db, req.caller!.personId));
  app.post('/backlog/saved-filters', async (req, reply) => {
    try { saveFilter(db, req.caller!.personId, req.body); return reply.code(201).send(); } catch (e) { return fail(reply, e); }
  });
  app.patch<{ Params: { id: string } }>('/backlog/saved-filters/:id', async (req, reply) => {
    try { renameFilter(db, req.caller!.personId, req.params.id, req.body); return reply.code(204).send(); } catch (e) { return fail(reply, e); }
  });
  app.delete<{ Params: { id: string } }>('/backlog/saved-filters/:id', async (req, reply) => {
    try { removeFilter(db, req.caller!.personId, req.params.id); return reply.code(204).send(); } catch (e) { return fail(reply, e); }
  });
}
