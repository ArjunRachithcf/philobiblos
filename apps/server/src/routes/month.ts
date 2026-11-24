// This month and its order (spec §4, §5; ADR 0007). Every adult sees the plan and may change their own picks and the
// kids'; the one-month budget is admins' (like the budget itself); Compose is any adult's, and so is an order's quote or an
// invoice typed in or imported (src/orders/entries.ts), and the plain list with its books marked owned by a tap (no-shop
// mode, src/orders/list.ts). The rules are in src/month/ and src/orders/.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAdmin } from '../auth/hook';
import type { Config } from '../config';
import type { Db } from '../db/open';
import { SealError, isSealed, keyProblem, sealingKey, unseal } from '../household/sealed';
import { enabledConnectors, orderAddress } from '../connectors/enabled';
import type { Registry } from '../connectors/load';
import { EntryError, recentEntries, recordEntry, undoEntry } from '../orders/entries';
import { MonthError, changePicks, checkWindow, composeOrder, getMonth, getOrder, markOwned, orderListCsv, setMonthBudget, thisMonth } from '../month/plan';

export const SEALED = { bookshopEmail: 'bookshop_email', deliveryAddress: 'delivery_address' } as const;

export async function monthRoutes(app: FastifyInstance, cfg: Config, db: Db, connectors: Registry) {
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof EntryError) return reply.code(e.status).send({ error: e.message, ...(e.maybeMailed ? { maybeMailed: e.maybeMailed } : {}) });
    if (e instanceof MonthError) return reply.code(e.status).send({ error: e.message });
    if (e instanceof SealError) return reply.code(409).send({ error: 'the addresses were sealed with another key: an admin enters them again in Settings' });
    throw e;
  };
  type P = { Params: { month: string } };
  // "This month" is the household's (its zone in Settings): the page asks for it here, and add_to_month uses the same.
  app.get('/month', async (req, reply) => {
    try { return getMonth(db, thisMonth(db), req.caller!.personId); } catch (e) { return fail(reply, e); }
  });
  app.get<P>('/month/:month', async (req, reply) => {
    try { checkWindow(db, req.params.month, false); return getMonth(db, req.params.month, req.caller!.personId); } catch (e) { return fail(reply, e); }
  });
  app.put<P>('/month/:month/budget', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    try { checkWindow(db, req.params.month, true); return setMonthBudget(db, req.params.month, req.caller!.personId, req.body ?? null); } catch (e) { return fail(reply, e); }
  });
  app.post<P>('/month/:month/picks', async (req, reply) => {
    try { checkWindow(db, req.params.month, true); return changePicks(db, req.params.month, req.caller!.personId, req.body); } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: { month?: unknown } }>('/orders', async (req, reply) => {
    try {
      const b = req.body;
      if (b !== undefined && b !== null && (typeof b !== 'object' || Array.isArray(b))) throw new MonthError(400, 'a JSON object is needed');
      for (const k of Object.keys(b ?? {})) if (k !== 'month' && k !== 'list') throw new MonthError(400, `unknown field ${k.slice(0, 40)}`);
      const month = b?.month ?? thisMonth(db);
      if (typeof month !== 'string') throw new MonthError(400, 'month: YYYY-MM');
      const given = (b as { list?: unknown } | undefined)?.list;
      const list = given === undefined ? false : given;
      if (typeof list !== 'boolean') throw new MonthError(400, 'list: true or false');
      checkWindow(db, month, true);
      // No-shop mode: the plain list needs no address and opens nothing sealed.
      if (list) return reply.code(201).send(composeOrder(db, month, req.caller!.personId, 'list'));
      const problem = keyProblem(cfg);
      if (problem && (isSealed(db, SEALED.bookshopEmail) || isSealed(db, SEALED.deliveryAddress))) throw new MonthError(409, `the sealing key is ${problem}: the server's PHILOBIBLOS_SEALING_KEY needs fixing`);
      const open = (name: string) => (isSealed(db, name) ? unseal(db, sealingKey(cfg), name) : null);
      const places = { bookshopEmail: orderAddress(open(SEALED.bookshopEmail), enabledConnectors(db, connectors)), deliveryAddress: open(SEALED.deliveryAddress) };
      return reply.code(201).send(composeOrder(db, month, req.caller!.personId, places));
    } catch (e) { return fail(reply, e); }
  });
  // The shops an invoice may name by their connector (the enabled ones in force): any adult, ids and names only.
  app.get('/orders/shops', async () => ({ shops: enabledConnectors(db, connectors).map((c) => ({ id: c.id, name: c.connector.name })) }));
  // A quote or an invoice typed in or imported from a CSV: recorded (201), or what it would do (dryRun, 200).
  app.post('/orders/entries', async (req, reply) => {
    try {
      const r = recordEntry(db, req.caller!.personId, req.body, new Date(), enabledConnectors(db, connectors).map((c) => c.id));
      return reply.code(r.dryRun ? 200 : 201).send(r);
    } catch (e) { return fail(reply, e); }
  });
  // The invoices typed in or imported lately, and undoing one (philobiblos#45: whoever recorded it, or an admin).
  app.get('/orders/entries', async (req) => ({ entries: recentEntries(db, req.caller!.personId) }));
  app.post<{ Params: { id: string } }>('/orders/entries/:id/undo', async (req, reply) => {
    try { undoEntry(db, req.caller!.personId, req.params.id); return reply.code(204).send(); } catch (e) { return fail(reply, e); }
  });
  app.get<{ Params: { id: string } }>('/orders/:id', async (req, reply) => {
    try { return getOrder(db, req.params.id); } catch (e) { return fail(reply, e); }
  });
  // No-shop mode: the list as a CSV to download (its cells guarded against spreadsheet formulas: orders/list.ts).
  app.get<{ Params: { id: string } }>('/orders/:id/list.csv', async (req, reply) => {
    try {
      const { month, csv } = orderListCsv(db, req.params.id);
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="book-order-${month}.csv"`)
        .header('cache-control', 'no-store').send(csv);
    } catch (e) { return fail(reply, e); }
  });
  // A book of the order bought with no invoice to record: marked owned by a tap, or the tap undone.
  app.put<{ Params: { id: string; bookId: string } }>('/orders/:id/lines/:bookId', async (req, reply) => {
    try { return markOwned(db, req.params.id, req.params.bookId, req.body ?? null); } catch (e) { return fail(reply, e); }
  });
}
