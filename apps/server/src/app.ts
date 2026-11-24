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
import { shopHosts } from './connectors/enabled';
import { inboxRoutes } from './routes/inbox';
import { SHARE_BYTES, SHARE_UPLOADS, ShareProcessor } from './shares/shares';
import type { runMediaJob } from './media/client';
import { AiJobs, type AiJobOptions } from './ai/jobs';
import { pushRoutes } from './routes/push';
import { joinNotifier, pushClient } from './push/push';
import { initHousehold } from './jobs/schedule';
import { initCurrency } from './household/money';
import { loadConnectors, type Registry } from './connectors/load';
import { enabledConnectors } from './connectors/enabled';
import { connectorRoutes } from './routes/connectors';
import type { Egress, EgressOptions } from './net/egress';
import { MailOAuth, REDIRECT_PATH, type MailOAuthOptions } from './mail/oauth';
import { mailRoutes } from './routes/mail';

/** Phone shares: a carousel (Instagram allows 20 slides) or a video with its caption and link (contracts/connectors.md); a
 * file up to the largest by type (SHARE_BYTES: a video), each type and the whole share checked in shares.ts. */
export const SHARE_LIMITS = { files: 30, fileSize: SHARE_BYTES.video, fields: 10, fieldSize: 64 * 1024, parts: 40 };

/** A request's URL as a log line shows it: the mail provider's return without its query (mail/oauth.ts REDIRECT_PATH). */
export const logUrl = (url: string) => (url.split('?')[0]!.replace(/\/+$/, '') === REDIRECT_PATH ? REDIRECT_PATH : url);

export interface BuiltApp {
  app: FastifyInstance; apiRoutes: { method: string; url: string }[];
  /** The book jobs' one HTTP client (its allowlist follows the connectors enabled at each request). */
  egress: Egress;
}

export interface AppOptions { connectors?: Registry; ai?: AiJobOptions; push?: Egress; logger?: boolean; shareLimits?: Partial<typeof SHARE_LIMITS>; webauthn?: WebAuthn; jobs?: Partial<JobDeps>; media?: typeof runMediaJob; shareRetryMs?: number;
  /** Tests only: the book client's lookup (so nothing is looked up for real). */
  egress?: Pick<EgressOptions, 'resolve'>;
  /** Tests only: the mailbox's OAuth token client (their own provider) and clock. */
  mailOAuth?: MailOAuthOptions }

export async function buildApp(cfg: Config, db: Db, opts: AppOptions = {}): Promise<BuiltApp> {
  // The household's settings row, with PHILOBIBLOS_TZ as its zone the first time only (jobs/schedule.ts initHousehold).
  initHousehold(db, cfg.timezone);
  // PHILOBIBLOS_CURRENCY for a household that has no currency yet (household/money.ts); never one it has.
  initCurrency(db, cfg.currency);
  // The bookshop connectors, read once (connectors/load.ts); each counts only once an admin enables it.
  const connectors = opts.connectors ?? loadConnectors(cfg.connectorDirs);
  const app = Fastify({
    logger: opts.logger ? {
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-homerslab-person"]', 'req.headers["x-homerslab-name"]'],
      // The mail provider's return carries an authorization code and a state in its query: never in a log line.
      serializers: { req: (r: { method: string; url: string; hostname?: string; ip?: string }) => ({ method: r.method, url: logUrl(r.url), hostname: r.hostname, remoteAddress: r.ip }) },
    } : false,
    trustProxy: false,
    bodyLimit: 1024 * 1024,
    // No request may take longer than a share's upload may (SHARE_UPLOADS.deadlineMs, which shares.ts enforces to the
    // second), plus a margin: Node checks this only every 30 s. Fastify has no per-route form of it; every other route's
    // body is at most 1 MB.
    requestTimeout: SHARE_UPLOADS.deadlineMs + 60_000,
  });
  // Every response: no framing, no sniffing, no referrer, scripts and styles from Philobiblos only, nothing from the network
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
  // The one HTTP client (ADR 0009) for the book jobs: the manifest's hosts, and the price hosts of the bookshop
  // connectors enabled at the moment of each request (none otherwise). The AI's calls have their own clients, one
  // host each (ai/model.ts): Ollama's, or Claude's after the opt-in. Web Push has its own too (push/push.ts).
  const rules = () => egressRules({ ollamaUrl: cfg.ollamaUrl, shopHosts: shopHosts(enabledConnectors(db, connectors)) });
  const egress = createEgress({ rules, enabled: cfg.egress, ...opts.egress });
  const challenges = new Challenges();
  // XOAUTH2 for the mailbox (mail/oauth.ts): its own token client, which reaches the OAuth client's endpoints only.
  const mailOAuth = new MailOAuth(db, cfg, opts.mailOAuth);
  // Shares' files through the media worker; anything left from before a restart is picked up at once.
  // The AI reads a share once the media worker is done with it (ai/jobs.ts), each provider through its own client.
  const ai = new AiJobs(db, cfg, opts.ai);
  const shares = new ShareProcessor(db, { dataDir: cfg.dataDir, workDir: cfg.workDir, media: opts.media, retryMs: opts.shareRetryMs, after: () => { void ai.kickShares(); } });
  app.addHook('onClose', async () => shares.close());
  app.addHook('onReady', async () => { void shares.kick(); });
  await app.register(async (api) => {
    const push = opts.push ?? pushClient(cfg);
    // Someone new waits to join: the admins are told (push/push.ts joinNotifier; the Inbox shows it too).
    const joined = joinNotifier(db, cfg, push);
    api.addHook('onRequest', authHook(cfg, db, { joined }));
    await authRoutes(api, cfg, db, webauthn, challenges, joined);
    await peopleRoutes(api, cfg, db);
    await libraryRoutes(api, cfg, db, connectors);
    await backlogRoutes(api, cfg, db);
    await monthRoutes(api, cfg, db, connectors);
    await connectorRoutes(api, cfg, db, connectors);
    await mailRoutes(api, mailOAuth);
    await knowledgeRoutes(api, db);
    await stubRoutes(api, cfg);
    await inboxRoutes(api, cfg, db, shares);
    await pushRoutes(api, cfg, db, push);
    await jobRoutes(api, cfg, db, { egress, connectors, shares, ai, push, ...opts.jobs, mail: { token: () => mailOAuth.accessToken(), ...opts.jobs?.mail } });
  }, { prefix: '/api' });
  if (cfg.webDir && existsSync(cfg.webDir)) {
    await app.register(fastifyStatic, { root: cfg.webDir });
    // The PWA's share target is the service worker's (public/sw.js): a share that reaches the server here came before
    // the worker was installed. Nothing of it is read; the share screen says to open Philobiblos once and share again.
    app.post('/share-target', async (_req, reply) => reply.code(303).header('location', '/share?offline=1').send());
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html')));
  }
  return { app, apiRoutes, egress };
}
