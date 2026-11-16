// GET /connectors and PUT /connectors/{id} (admins only; philobiblos#27): the bookshop connectors and what each allows.
// Enabling one widens what Philobiblos trusts and reaches (its senders, its price host), so it takes a sign-in of the last
// few minutes in standalone mode (HomersLab's own sign-in otherwise), as for a new notification key; turning one off
// only narrows, and needs an admin alone.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAdmin } from '../auth/hook';
import { isFresh } from '../auth/sessions';
import type { Db } from '../db/open';
import { ConnectorError, connectorView, setConnector } from '../connectors/enabled';
import type { Registry } from '../connectors/load';

export async function connectorRoutes(app: FastifyInstance, db: Db, reg: Registry) {
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof ConnectorError) return reply.code(e.status).send({ error: e.message });
    throw e;
  };
  app.get('/connectors', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    return { connectors: reg.all.map((c) => connectorView(db, c)) };
  });
  app.put<{ Params: { connectorId: string } }>('/connectors/:connectorId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const c = req.caller!;
    const enabling = Boolean(req.body && typeof req.body === 'object' && (req.body as { enabled?: unknown }).enabled === true);
    if (enabling && c.via !== 'homerslab' && !(c.session && isFresh(c.session))) return reply.code(403).send({ error: 'sign in again to do this' });
    try { return setConnector(db, reg, req.params.connectorId, req.body, c.personId); } catch (e) { return fail(reply, e); }
  });
}
