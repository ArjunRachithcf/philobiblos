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
import { monthRoutes } from './routes/month';
import { backlogRoutes } from './routes/backlog';
import { knowledgeRoutes } from './routes/knowledge';
import { libraryRoutes } from './routes/library';
import { peopleRoutes } from './routes/people';
import { stubRoutes } from './routes/stubs';
import { jobRoutes, type JobDeps } from './routes/jobs';
import { createEgress, egressRules } from './net/egress';
import { inboxRoutes } from './routes/inbox';
import { SHARE_BYTES, ShareProcessor } from './shares/shares';
import type { runMediaJob } from './media/client';

/** Phone shares: a carousel (Instagram allows 20 slides) or a video with its caption and link (contracts/connectors.md); a
 * file up to the largest by type (SHARE_BYTES: a video), each type and the whole share checked in shares.ts. */
export const SHARE_LIMITS = { files: 30, fileSize: SHARE_BYTES.video, fields: 10, fieldSize: 64 * 1024, parts: 40 };

export interface BuiltApp { app: FastifyInstance; apiRoutes: { method: string; url: string }[] }

export interface AppOptions { logger?: boolean; shareLimits?: Partial<typeof SHARE_LIMITS>; webauthn?: WebAuthn; jobs?: Partial<JobDeps>; media?: typeof runMediaJob; shareRetryMs?: number }

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
  // Shares' files through the media worker; anything left from before a restart is picked up at once.
  const shares = new ShareProcessor(db, { dataDir: cfg.dataDir, workDir: cfg.workDir, media: opts.media, retryMs: opts.shareRetryMs });
  app.addHook('onClose', async () => shares.close());
  app.addHook('onReady', async () => { void shares.kick(); });
  await app.register(async (api) => {
    api.addHook('onRequest', authHook(cfg, db));
    await authRoutes(api, cfg, db, webauthn, challenges);
    await peopleRoutes(api, cfg, db);
    await libraryRoutes(api, cfg, db);
    await backlogRoutes(api, cfg, db);
    await monthRoutes(api, cfg, db);
    await knowledgeRoutes(api, db);
    await stubRoutes(api, cfg);
    await inboxRoutes(api, cfg, db, shares);
    // The one HTTP client (ADR 0009): the manifest's hosts and OLLAMA_URL; Claude joins only with the opt-in (M3 g).
    await jobRoutes(api, cfg, db, { egress: createEgress({ rules: egressRules({ ollamaUrl: cfg.ollamaUrl }), enabled: cfg.egress }), shares, ...opts.jobs });
  }, { prefix: '/api' });
  if (cfg.webDir && existsSync(cfg.webDir)) {
    await app.register(fastifyStatic, { root: cfg.webDir });
    // The PWA's share target is the service worker's (public/sw.js): a share that reaches the server here came before
    // the worker was installed. Nothing of it is read; the share screen says to open Shelf once and share again.
    app.post('/share-target', async (_req, reply) => reply.code(303).header('location', '/share?offline=1').send());
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html')));
  }
  return { app, apiRoutes };
}
