// The Library and the settings (spec §4): your own, and the household's budget (admins). The rules are in src/library/
// and src/household/budget.ts.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../config';
import type { Db } from '../db/open';
import { SealError, isSealed, seal, sealingKey, unseal } from '../household/sealed';
import { EMAIL } from '../month/order-mail';
import { SEALED } from './month';
import { BudgetError, getBudget, setBudget } from '../household/budget';
import { getPerson } from '../household/people';
import { LibraryError, getLibrary, setReading } from '../library/library';
import { SettingsError, personSettings, updatePersonSettings } from '../library/settings';
import * as ex from '../stubs/examples';

export const ADDRESS_MAX = 300;

/** Settings.order: the bookshop's address and the delivery address, sealed (household/sealed.ts); admins set them. */
function checkOrder(v: unknown): { bookshopEmail?: string | null; deliveryAddress?: string | null } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SettingsError('order: a JSON object is needed');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'bookshopEmail' && k !== 'deliveryAddress') throw new SettingsError(`order: ${k} is not one of its settings`);
  if (o.bookshopEmail !== undefined && o.bookshopEmail !== null && (typeof o.bookshopEmail !== 'string' || !EMAIL.test(o.bookshopEmail.trim()))) throw new SettingsError('order.bookshopEmail: one e-mail address');
  if (o.deliveryAddress !== undefined && o.deliveryAddress !== null && (typeof o.deliveryAddress !== 'string' || !o.deliveryAddress.trim() || o.deliveryAddress.length > ADDRESS_MAX || [...o.deliveryAddress].some((c) => (c < ' ' && c !== '\n') || c === '\u007f'))) {
    throw new SettingsError(`order.deliveryAddress: up to ${ADDRESS_MAX} characters, lines of plain text`);
  }
  return {
    ...(o.bookshopEmail !== undefined ? { bookshopEmail: typeof o.bookshopEmail === 'string' ? o.bookshopEmail.trim() : null } : {}),
    ...(o.deliveryAddress !== undefined ? { deliveryAddress: typeof o.deliveryAddress === 'string' ? o.deliveryAddress.trim() : null } : {}),
  };
}

export async function libraryRoutes(app: FastifyInstance, cfg: Config, db: Db) {
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof LibraryError) return reply.code(e.status).send({ error: e.message });
    if (e instanceof SettingsError || e instanceof BudgetError) return reply.code(400).send({ error: e.message });
    if (e instanceof SealError) return reply.code(409).send({ error: 'the sealing key is missing or wrong; see SHELF_SEALING_KEY' });
    throw e;
  };

  app.get<{ Params: { personId: string } }>('/people/:personId/library', async (req, reply) => {
    try { return getLibrary(db, req.caller!.personId, req.params.personId); } catch (e) { return fail(reply, e); }
  });

  app.put<{ Params: { personId: string; bookId: string } }>('/people/:personId/reading/:bookId', async (req, reply) => {
    try { return setReading(db, req.caller!.personId, req.params.personId, req.params.bookId, req.body); } catch (e) { return fail(reply, e); }
  });

  // M1: your own part and the budget are real; the other household parts stay examples until their screens (M2).
  app.get('/settings', async (req, reply) => {
    try {
      // The delivery address never leaves sealed storage except in a Compose text; Settings says only whether it is set.
      // The key is read only when something is sealed (a standalone Shelf makes its key on the first seal).
      const email = isSealed(db, SEALED.bookshopEmail) ? unseal(db, sealingKey(cfg)!, SEALED.bookshopEmail) : null;
      const order = { bookshopEmail: email, hasDelivery: isSealed(db, SEALED.deliveryAddress), canSeal: cfg.sealingKey !== null };
      return { ...ex.settings, budget: getBudget(db), person: personSettings(getPerson(db, req.caller!.personId)!), order };
    } catch (e) { return fail(reply, e); }
  });
  app.patch<{ Body: { person?: unknown; budget?: unknown; order?: unknown } }>('/settings', async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply.code(400).send({ error: 'a JSON object is needed' });
    // The household's settings are admins'; parts not stored yet answer 400: never a silent 200.
    const household = Object.keys(body).filter((k) => k !== 'person');
    if (household.length && req.caller!.role !== 'admin') return reply.code(403).send({ error: 'admins change the household\'s settings' });
    const unstored = household.filter((k) => k !== 'budget' && k !== 'order');
    if (unstored.length) return reply.code(400).send({ error: `not stored yet: ${unstored.join(', ')}` });
    try {
      // All or nothing: both parts are checked before either is written.
      const order = body.order === undefined ? null : checkOrder(body.order);
      const key = order ? sealingKey(cfg) : null;
      if (order && !key) return reply.code(409).send({ error: 'no sealing key: HomersLab gives SHELF_SEALING_KEY' });
      db.transaction((tx) => {
        if (body.budget !== undefined) setBudget(tx as unknown as Db, body.budget);
        if (order?.bookshopEmail !== undefined) seal(tx as unknown as Db, key!, SEALED.bookshopEmail, order.bookshopEmail);
        if (order?.deliveryAddress !== undefined) seal(tx as unknown as Db, key!, SEALED.deliveryAddress, order.deliveryAddress);
        if (body.person !== undefined) updatePersonSettings(tx as unknown as Db, getPerson(tx as unknown as Db, req.caller!.personId)!, body.person);
      });
      return {};
    } catch (e) { return fail(reply, e); }
  });
}
