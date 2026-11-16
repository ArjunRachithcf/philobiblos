// This month and its order (spec §4, §5; ADR 0007). Every adult sees the plan and may change their own picks and the
// kids'; the one-month budget is admins' (like the budget itself); Compose is any adult's. The rules are in src/month/.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAdmin } from '../auth/hook';
import type { Config } from '../config';
import type { Db } from '../db/open';
import { SealError, isSealed, keyProblem, sealingKey, unseal } from '../household/sealed';
import { EMAIL } from '../month/order-mail';
import { MonthError, changePicks, checkWindow, composeOrder, currentMonth, getMonth, getOrder, setMonthBudget } from '../month/plan';

export const SEALED = { bookshopEmail: 'bookshop_email', deliveryAddress: 'delivery_address' } as const;

export async function monthRoutes(app: FastifyInstance, cfg: Config, db: Db) {
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof MonthError) return reply.code(e.status).send({ error: e.message });
    if (e instanceof SealError) return reply.code(409).send({ error: 'the addresses were sealed with another key: an admin enters them again in Settings' });
    throw e;
  };
  type P = { Params: { month: string } };
  // "This month" is the server's (SHELF_TZ): the page asks for it here, and add_to_month uses the same.
  app.get('/month', async (req, reply) => {
    try { return getMonth(db, currentMonth(cfg.timezone), req.caller!.personId); } catch (e) { return fail(reply, e); }
  });
  app.get<P>('/month/:month', async (req, reply) => {
    try { checkWindow(db, req.params.month, cfg.timezone, false); return getMonth(db, req.params.month, req.caller!.personId); } catch (e) { return fail(reply, e); }
  });
  app.put<P>('/month/:month/budget', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try { checkWindow(db, req.params.month, cfg.timezone, true); return setMonthBudget(db, req.params.month, req.caller!.personId, req.body ?? null); } catch (e) { return fail(reply, e); }
  });
  app.post<P>('/month/:month/picks', async (req, reply) => {
    try { checkWindow(db, req.params.month, cfg.timezone, true); return changePicks(db, req.params.month, req.caller!.personId, req.body); } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: { month?: unknown } }>('/orders', async (req, reply) => {
    try {
      const b = req.body;
      if (b !== undefined && b !== null && (typeof b !== 'object' || Array.isArray(b))) throw new MonthError(400, 'a JSON object is needed');
      const month = b?.month ?? currentMonth(cfg.timezone);
      if (typeof month !== 'string') throw new MonthError(400, 'month: YYYY-MM');
      checkWindow(db, month, cfg.timezone, true);
      const problem = keyProblem(cfg);
      if (problem && (isSealed(db, SEALED.bookshopEmail) || isSealed(db, SEALED.deliveryAddress))) throw new MonthError(409, `the sealing key is ${problem}: the server's SHELF_SEALING_KEY needs fixing`);
      const open = (name: string) => (isSealed(db, name) ? unseal(db, sealingKey(cfg), name) : null);
      // Shelf's mailbox in Bcc, so the request is in the mailbox beside the bookshop's replies.
      const bcc = cfg.imap && EMAIL.test(cfg.imap.user) ? cfg.imap.user : null;
      const places = { bookshopEmail: open(SEALED.bookshopEmail), deliveryAddress: open(SEALED.deliveryAddress), bcc };
      return reply.code(201).send(composeOrder(db, month, req.caller!.personId, places));
    } catch (e) { return fail(reply, e); }
  });
  app.get<{ Params: { id: string } }>('/orders/:id', async (req, reply) => {
    try { return getOrder(db, req.params.id); } catch (e) { return fail(reply, e); }
  });
}
