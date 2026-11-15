// The Fastify app: /api (contracts/openapi.yaml) and, when built, the web app's static files.
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { authHook } from './auth';
import type { Config } from './config';
import type { Db } from './db/open';
import { stubRoutes } from './routes/stubs';

/** Phone shares: a carousel (Instagram allows 20 slides) or a video with its caption and link (contracts/connectors.md). */
export const SHARE_LIMITS = { files: 30, fileSize: 20 * 1024 * 1024, fields: 10, fieldSize: 64 * 1024, parts: 40 };

export interface BuiltApp { app: FastifyInstance; apiRoutes: { method: string; url: string }[] }

export async function buildApp(cfg: Config, db: Db, opts: { logger?: boolean; shareLimits?: Partial<typeof SHARE_LIMITS> } = {}): Promise<BuiltApp> {
  const app = Fastify({
    logger: opts.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-homerslab-person"]'] } : false,
    trustProxy: false,
    bodyLimit: 1024 * 1024,
  });
  const apiRoutes: BuiltApp['apiRoutes'] = [];
  app.addHook('onRoute', (r) => {
    if (!r.url.startsWith('/api/')) return;
    for (const m of [r.method].flat()) if (m !== 'HEAD') apiRoutes.push({ method: m, url: r.url });
  });
  await app.register(fastifyMultipart, { limits: { ...SHARE_LIMITS, ...opts.shareLimits } });
  await app.register(async (api) => {
    api.addHook('onRequest', authHook(cfg, db));
    await stubRoutes(api, cfg, db);
  }, { prefix: '/api' });
  if (cfg.webDir && existsSync(cfg.webDir)) {
    await app.register(fastifyStatic, { root: cfg.webDir });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html')));
  }
  return { app, apiRoutes };
}
