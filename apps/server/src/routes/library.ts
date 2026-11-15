// The Library and the settings (spec §4): your own, and the household's budget (admins). The rules are in src/library/
// and src/household/budget.ts.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/open';
import { BudgetError, getBudget, setBudget } from '../household/budget';
import { getPerson } from '../household/people';
import { LibraryError, getLibrary, setReading } from '../library/library';
import { SettingsError, personSettings, updatePersonSettings } from '../library/settings';
import * as ex from '../stubs/examples';

export async function libraryRoutes(app: FastifyInstance, db: Db) {
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof LibraryError) return reply.code(e.status).send({ error: e.message });
    if (e instanceof SettingsError || e instanceof BudgetError) return reply.code(400).send({ error: e.message });
    throw e;
  };

  app.get<{ Params: { personId: string } }>('/people/:personId/library', async (req, reply) => {
    try { return getLibrary(db, req.caller!.personId, req.params.personId); } catch (e) { return fail(reply, e); }
  });

  app.put<{ Params: { personId: string; bookId: string } }>('/people/:personId/reading/:bookId', async (req, reply) => {
    try { return setReading(db, req.caller!.personId, req.params.personId, req.params.bookId, req.body); } catch (e) { return fail(reply, e); }
  });

  // M1: your own part and the budget are real; the other household parts stay examples until their screens (M2).
  app.get('/settings', async (req) => ({ ...ex.settings, budget: getBudget(db), person: personSettings(getPerson(db, req.caller!.personId)!) }));
  app.patch<{ Body: { person?: unknown; budget?: unknown } }>('/settings', async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply.code(400).send({ error: 'a JSON object is needed' });
    // The household's settings are admins'; parts not stored yet answer 400: never a silent 200.
    const household = Object.keys(body).filter((k) => k !== 'person');
    if (household.length && req.caller!.role !== 'admin') return reply.code(403).send({ error: 'admins change the household\'s settings' });
    const unstored = household.filter((k) => k !== 'budget');
    if (unstored.length) return reply.code(400).send({ error: `not stored yet: ${unstored.join(', ')}` });
    try {
      // All or nothing: both parts are checked before either is written.
      db.transaction((tx) => {
        if (body.budget !== undefined) setBudget(tx as unknown as Db, body.budget);
        if (body.person !== undefined) updatePersonSettings(tx as unknown as Db, getPerson(tx as unknown as Db, req.caller!.personId)!, body.person);
      });
      return {};
    } catch (e) { return fail(reply, e); }
  });
}
