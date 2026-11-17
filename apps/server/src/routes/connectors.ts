// GET /connectors and PUT /connectors/{id} (admins only; philobiblos#27): the bookshop connectors and what each allows.
// Enabling one widens what Philobiblos trusts and reaches (its senders, its price host), so it takes a sign-in of the last
// few minutes, as for a new notification key (auth/hook.ts requireFreshSignIn: refused under HomersLab until its edge
// sends a recent sign-in, homeward#253); turning one off only narrows, and needs an admin alone.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAdmin, requireFreshSignIn } from '../auth/hook';
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
    const enabling = Boolean(req.body && typeof req.body === 'object' && (req.body as { enabled?: unknown }).enabled === true);
    if (enabling && !requireFreshSignIn(req, reply)) return reply;
    try { return setConnector(db, reg, req.params.connectorId, req.body, req.caller!.personId); } catch (e) { return fail(reply, e); }
  });
}
