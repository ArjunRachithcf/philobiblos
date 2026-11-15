// The Library and a person's own settings (spec §4). The rules are in src/library/.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/open';
import { getPerson } from '../household/people';
import { LibraryError, getLibrary, setReading } from '../library/library';
import { SettingsError, personSettings, updatePersonSettings } from '../library/settings';
import * as ex from '../stubs/examples';

export async function libraryRoutes(app: FastifyInstance, db: Db) {
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof LibraryError) return reply.code(e.status).send({ error: e.message });
    if (e instanceof SettingsError) return reply.code(400).send({ error: e.message });
    throw e;
  };

  app.get<{ Params: { personId: string } }>('/people/:personId/library', async (req, reply) => {
    try { return getLibrary(db, req.caller!.personId, req.params.personId); } catch (e) { return fail(reply, e); }
  });

  app.put<{ Params: { personId: string; bookId: string } }>('/people/:personId/reading/:bookId', async (req, reply) => {
    try { return setReading(db, req.caller!.personId, req.params.personId, req.params.bookId, req.body); } catch (e) { return fail(reply, e); }
  });

  // M1: the person's own part is real; the household parts are still the examples until their screens (M1/M2).
  app.get('/settings', async (req) => ({ ...ex.settings, person: personSettings(getPerson(db, req.caller!.personId)!) }));
  app.patch<{ Body: { person?: unknown } }>('/settings', async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply.code(400).send({ error: 'a JSON object is needed' });
    // The household's settings are admins' (and not stored before their screens): never a silent 200.
    const household = Object.keys(body).filter((k) => k !== 'person');
    if (household.length && req.caller!.role !== 'admin') return reply.code(403).send({ error: 'admins change the household\'s settings' });
    if (household.length) return reply.code(400).send({ error: `not stored yet: ${household.join(', ')}` });
    try {
      if (body.person !== undefined) updatePersonSettings(db, getPerson(db, req.caller!.personId)!, body.person);
      return {};
    } catch (e) { return fail(reply, e); }
  });
}
