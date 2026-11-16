// POST /jobs/{job}/run (admins only): starts a job now instead of at its time. The ones that reach outside Shelf go
// through the egress client (src/net/egress.ts) and nothing else.
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/hook';
import type { Config } from '../config';
import type { Db } from '../db/open';
import { orellFuessli, type PriceSource } from '../books/prices';
import { refreshCovers, refreshMetadata, refreshPrices, type JobEnv, type Outcome } from '../jobs/books';
import { closeInterrupted, startJob } from '../jobs/run';
import type { Egress } from '../net/egress';
import { refreshMail, type MailDeps } from '../mail/job';
import type { ShareProcessor } from '../shares/shares';
import type { AiJobs } from '../ai/jobs';

export const JOBS = ['monthly', 'mail', 'shares', 'prices', 'metadata', 'covers', 'ai_suggest', 'ai_tag', 'ai_explain'] as const;

export interface JobDeps { egress: Egress; shares?: ShareProcessor; ai?: AiJobs; prices?: PriceSource; env?: JobEnv; mail?: MailDeps; started?: (job: string, done: Promise<void>) => void }

export async function jobRoutes(app: FastifyInstance, cfg: Config, db: Db, deps: JobDeps) {
  closeInterrupted(db);
  const work: Partial<Record<(typeof JOBS)[number], (again: boolean) => Promise<Outcome>>> = {
    prices: () => refreshPrices(db, deps.prices ?? orellFuessli(deps.egress), deps.env),
    metadata: (again) => refreshMetadata(db, deps.egress, { ...deps.env, again }),
    covers: () => refreshCovers(db, deps.egress, { dataDir: cfg.dataDir, workDir: cfg.workDir }, deps.env),
    mail: () => refreshMail(db, cfg, deps.mail),
    ...(deps.shares ? { shares: () => deps.shares!.kick() } : {}),
    // The AI's jobs (ai/jobs.ts): each through its provider's own client, never this one.
    ...(deps.ai ? { ai_suggest: () => deps.ai!.suggest(), ai_tag: () => deps.ai!.tagBooks(), ai_explain: () => deps.ai!.explain() } : {}),
  };
  app.post<{ Params: { job: string }; Querystring: { again?: string } }>('/jobs/:job/run', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const job = req.params.job as (typeof JOBS)[number];
    if (!JOBS.includes(job)) return reply.code(404).send({ error: 'no such job' });
    const run = work[job];
    // The other jobs arrive with their slices (shelf#8); asking for one now changes nothing.
    if (!run) return reply.code(202).send({});
    const started = startJob(db, job, () => run(req.query.again === 'true'));
    if (!started) return reply.code(409).send({ error: 'this job is running already' });
    deps.started?.(job, started.done);
    return reply.code(202).send({ id: started.id });
  });
}
