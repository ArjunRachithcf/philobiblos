// Ideas, layers, links and the Brain (ADR 0005). The rules are in src/knowledge/.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/open';
import { requireAdmin } from '../auth/hook';
import { KnowledgeError, editIdea, getBrain, listMerges, listProposals, reviewBookIdea, reviewLink, undoMerge } from '../knowledge/knowledge';

export async function knowledgeRoutes(app: FastifyInstance, db: Db) {
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof KnowledgeError) return reply.code(e.status).send({ error: e.message });
    throw e;
  };
  app.get<{ Params: { personId: string } }>('/people/:personId/brain', async (req, reply) => {
    try { return getBrain(db, req.params.personId); } catch (e) { return fail(reply, e); }
  });
  app.get('/proposals', async (req) => listProposals(db, req.caller!.personId));
  app.put<{ Params: { fromBook: string; toBook: string } }>('/links/:fromBook/:toBook', async (req, reply) => {
    try { return reviewLink(db, req.caller!.personId, req.params.fromBook, req.params.toBook, req.body); } catch (e) { return fail(reply, e); }
  });
  app.put<{ Params: { bookId: string; ideaId: string } }>('/books/:bookId/ideas/:ideaId', async (req, reply) => {
    try { return reviewBookIdea(db, req.caller!.personId, req.params.bookId, req.params.ideaId, req.body); } catch (e) { return fail(reply, e); }
  });
  app.patch<{ Params: { ideaId: string } }>('/ideas/:ideaId', async (req, reply) => {
    try { return editIdea(db, req.params.ideaId, req.body, req.caller!.personId); } catch (e) { return fail(reply, e); }
  });
  // Any adult may merge (the shared vocabulary); admins may undo one.
  app.get('/ideas/merges', async () => listMerges(db));
  app.post<{ Params: { mergeId: string } }>('/ideas/merges/:mergeId/undo', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try { return undoMerge(db, req.params.mergeId, req.caller!.personId); } catch (e) { return fail(reply, e); }
  });
}
