// What is left of M0's stubs: /health. Every other route has its feature now.
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config';
import { VERSION } from '../version';

export async function stubRoutes(app: FastifyInstance, cfg: Config) {
  app.get('/health', { config: { auth: 'public' } }, async () => ({ ok: true, version: VERSION, mode: cfg.mode }));
}
