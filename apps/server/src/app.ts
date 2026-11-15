// The Fastify app: /api (contracts/openapi.yaml) and, when built, the web app's static files.
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { authHook } from './auth/hook';
import { Challenges, simpleWebAuthn, type WebAuthn } from './auth/webauthn';
import type { Config } from './config';
import type { Db } from './db/open';
import { authRoutes } from './routes/auth';
import { peopleRoutes } from './routes/people';
import { stubRoutes } from './routes/stubs';

/** Phone shares: a carousel (Instagram allows 20 slides) or a video with its caption and link (contracts/connectors.md). */
export const SHARE_LIMITS = { files: 30, fileSize: 20 * 1024 * 1024, fields: 10, fieldSize: 64 * 1024, parts: 40 };

export interface BuiltApp { app: FastifyInstance; apiRoutes: { method: string; url: string }[] }

export interface AppOptions { logger?: boolean; shareLimits?: Partial<typeof SHARE_LIMITS>; webauthn?: WebAuthn }

export async function buildApp(cfg: Config, db: Db, opts: AppOptions = {}): Promise<BuiltApp> {
  const app = Fastify({
    logger: opts.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-homerslab-person"]', 'req.headers["x-homerslab-name"]'] } : false,
    trustProxy: false,
    bodyLimit: 1024 * 1024,
  });
  // Every response: no framing, no sniffing, no referrer, scripts and styles from Shelf only, nothing from the network
  // on page render (ADR 0003, ADR 0009).
  app.addHook('onSend', async (_req, reply) => {
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('Referrer-Policy', 'no-referrer');
    void reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    void reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  });
  const apiRoutes: BuiltApp['apiRoutes'] = [];
  app.addHook('onRoute', (r) => {
    if (!r.url.startsWith('/api/')) return;
    for (const m of [r.method].flat()) if (m !== 'HEAD') apiRoutes.push({ method: m, url: r.url });
  });
  await app.register(fastifyMultipart, { limits: { ...SHARE_LIMITS, ...opts.shareLimits } });
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });
  const webauthn = opts.webauthn ?? simpleWebAuthn(cfg);
  const challenges = new Challenges();
  await app.register(async (api) => {
    api.addHook('onRequest', authHook(cfg, db));
    await authRoutes(api, cfg, db, webauthn, challenges);
    await peopleRoutes(api, cfg, db);
    await stubRoutes(api, cfg, db);
  }, { prefix: '/api' });
  if (cfg.webDir && existsSync(cfg.webDir)) {
    await app.register(fastifyStatic, { root: cfg.webDir });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html')));
  }
  return { app, apiRoutes };
}
