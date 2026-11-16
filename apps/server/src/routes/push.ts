// Notifications (Web Push, push/push.ts): each adult's own devices. Kids never sign in, so never subscribe.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../config';
import type { Db } from '../db/open';
import type { Egress } from '../net/egress';
import { PushError, listSubscriptions, notify, subscribe, unsubscribe, vapidKeys } from '../push/push';
import { b64u } from '../push/webpush';
import { Limiter } from '../shares/tokens';

/** A test push 3 times in 10 minutes a person; saving a subscription 10 times. */
export const PUSH_LIMITS = { test: { max: 3, windowMs: 10 * 60_000 }, subscribe: { max: 10, windowMs: 10 * 60_000 } };

export async function pushRoutes(app: FastifyInstance, cfg: Config, db: Db, egress: Egress) {
  const tests = new Limiter(PUSH_LIMITS.test.max, PUSH_LIMITS.test.windowMs);
  const saves = new Limiter(PUSH_LIMITS.subscribe.max, PUSH_LIMITS.subscribe.windowMs);
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof PushError) return reply.code(e.status).send({ error: e.message });
    throw e;
  };
  app.get('/push/key', async (_req, reply) => {
    try { return { publicKey: b64u(vapidKeys(db, cfg).publicKey) }; } catch (e) { return fail(reply, e); }
  });
  app.get('/push/subscriptions', async (req) => listSubscriptions(db, req.caller!.personId));
  app.post('/push/subscriptions', async (req, reply) => {
    if (!saves.hit(req.caller!.personId)) return reply.code(429).send({ error: 'too many devices saved: wait a few minutes' });
    try { vapidKeys(db, cfg); return reply.code(201).send(subscribe(db, req.caller!.personId, req.body, { hosts: cfg.pushHosts })); } catch (e) { return fail(reply, e); }
  });
  app.delete<{ Params: { id: string } }>('/push/subscriptions/:id', async (req, reply) => {
    try { unsubscribe(db, req.caller!.personId, req.params.id); return reply.code(204).send(); } catch (e) { return fail(reply, e); }
  });
  // To your own devices only, with the test's own words.
  app.post('/push/test', async (req, reply) => {
    if (!tests.hit(req.caller!.personId)) return reply.code(429).send({ error: 'a test went out a moment ago: wait a few minutes' });
    const o = await notify(db, cfg, egress, 'test', { people: [req.caller!.personId] });
    return { status: o.status, detail: o.detail };
  });
}
