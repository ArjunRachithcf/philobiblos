// The mailbox's XOAUTH2 connection (admins only; mail/oauth.ts, docs/mail-providers.md). Connecting widens what
// Philobiblos holds (a token for the mailbox), so starting it takes a sign-in of the last few minutes, as enabling a
// bookshop does (auth/hook.ts requireFreshSignIn: refused under HomersLab until its edge sends a recent sign-in,
// homeward#253); the finish must come from the same session within 10 minutes. Disconnecting only narrows, and needs an
// admin alone. No answer holds a token.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin, requireFreshSignIn } from '../auth/hook';
import { OAuthError, type Caller, type MailOAuth } from '../mail/oauth';

export async function mailRoutes(app: FastifyInstance, oauth: MailOAuth) {
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof OAuthError) return reply.code(e.status).send({ error: e.message });
    throw e;
  };
  // Standalone sessions only: under HomersLab there is none, and the start is refused before.
  const caller = (req: FastifyRequest): Caller => ({ personId: req.caller!.personId, sessionId: req.caller!.session?.id ?? '' });
  app.post('/mail/oauth/start', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!requireFreshSignIn(req, reply)) return reply;
    try { return oauth.start(caller(req), req.body); } catch (e) { return fail(reply, e); }
  });
  app.post('/mail/oauth/finish', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    if (!req.caller!.session) return reply.code(403).send({ error: 'connecting needs a sign-in of Philobiblos\'s own' });
    try { return await oauth.finish(caller(req), req.body); } catch (e) { return fail(reply, e); }
  });
  app.delete('/mail/oauth', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    try { return await oauth.disconnect(); } catch (e) { return fail(reply, e); }
  });
}
