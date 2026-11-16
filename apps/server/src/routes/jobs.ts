// POST /jobs/{job}/run (admins only): starts a job now instead of at its time. The ones that reach outside Shelf go
// through the egress client (src/net/egress.ts) and nothing else. The monthly refresh also runs by itself, on the
// household's day (jobs/schedule.ts); by hand it runs every step again for this month.
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/hook';
import type { Config } from '../config';
import type { Db } from '../db/open';
import { orellFuessli, type PriceSource } from '../books/prices';
import { refreshCovers, refreshMetadata, refreshPrices, type JobEnv, type Outcome } from '../jobs/books';
import { closeInterrupted, startJob } from '../jobs/run';
import { SCHEDULE, Scheduler, dueAt, getCycle } from '../jobs/schedule';
import type { Egress } from '../net/egress';
import { refreshMail, type MailDeps } from '../mail/job';
import { keepPlan } from '../month/plan';
import { monthlyRefresh, type MonthlyWork } from '../month/refresh';
import type { ShareProcessor } from '../shares/shares';
import type { AiJobs } from '../ai/jobs';

export const JOBS = ['monthly', 'mail', 'shares', 'prices', 'metadata', 'covers', 'ai_suggest', 'ai_tag', 'ai_explain'] as const;

export interface JobDeps {
  egress: Egress; shares?: ShareProcessor; ai?: AiJobs; prices?: PriceSource; env?: JobEnv; mail?: MailDeps; started?: (job: string, done: Promise<void>) => void;
  /** The scheduler: off unless asked for (main.ts); tests drive it by hand with `scheduler.tick()`. */
  schedule?: { now?: () => Date; tickMs?: number; onScheduler?: (s: Scheduler) => void; start?: boolean };
}

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
  // The monthly refresh's steps for a month, each the same job an admin runs by hand (month/refresh.ts).
  const monthlyWork = (month: string, deadline: Date): MonthlyWork => ({
    mail: () => refreshMail(db, cfg, deps.mail),
    ...(deps.shares ? { shares: () => deps.shares!.kick() } : {}),
    prices: () => refreshPrices(db, deps.prices ?? orellFuessli(deps.egress), { ...deps.env, deadline }),
    plan: async () => { const p = keepPlan(db, month); return { status: 'done', detail: `${p.kept ? 'kept' : 'kept already'}, ${p.lines} picks` }; },
    ...(deps.ai ? { ai_suggest: () => deps.ai!.suggest({ until: deadline }), ai_explain: () => deps.ai!.explain({ month, until: deadline }) } : {}),
  });
  const now = deps.schedule?.now ?? (() => new Date());
  work.monthly = () => {
    const deadline = new Date(now().getTime() + SCHEDULE.deadlineMs);
    return monthlyRefresh(monthlyWork(dueAt(getCycle(db), now()).period, deadline), { deadline, now });
  };
  if (deps.schedule) {
    const scheduler = new Scheduler(db, [{
      job: 'monthly',
      run: (ctl) => monthlyRefresh(monthlyWork(ctl.claim.period, ctl.deadline), { deadline: ctl.deadline, done: ctl.claim.steps, step: ctl.step, now }),
    }], deps.schedule);
    deps.schedule.onScheduler?.(scheduler);
    if (deps.schedule.start !== false) app.addHook('onReady', async () => { scheduler.start(); });
    app.addHook('onClose', async () => { scheduler.stop(); });
  }
  app.post<{ Params: { job: string }; Querystring: { again?: string } }>('/jobs/:job/run', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const job = req.params.job as (typeof JOBS)[number];
    if (!JOBS.includes(job)) return reply.code(404).send({ error: 'no such job' });
    const run = work[job];
    // A job this server cannot do (no AI, no media worker): nothing to start.
    if (!run) return reply.code(202).send({});
    const started = startJob(db, job, () => run(req.query.again === 'true'));
    if (!started) return reply.code(409).send({ error: 'this job is running already' });
    deps.started?.(job, started.done);
    return reply.code(202).send({ id: started.id });
  });
}
