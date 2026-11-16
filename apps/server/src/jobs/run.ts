// Jobs run in the background, one of each kind at a time, each logged in job_run (started, finished, how it went).
// The detail is Philobiblos's own words (counts and the egress client's reasons), never a secret or a page's text.
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import type { Outcome } from './books';

const running = new Map<string, Promise<void>>();

export const isRunning = (job: string) => running.has(job);

export interface StartOptions {
  /** A scheduled run's period, kept in its row. */
  period?: string;
  /** Called with the outcome once the row is written, before the job's slot is free again. */
  after?: (o: Outcome, id: string) => void;
}

/** Starts `work` as `job`; null when that job is running already. `done` settles once its row is written. */
export function startJob(db: Db, job: string, work: () => Promise<Outcome>, opts: StartOptions = {}): { id: string; done: Promise<void> } | null {
  if (running.has(job)) return null;
  const id = ulid();
  db.insert(t.jobRun).values({ id, job, status: 'running', startedAt: new Date().toISOString(), period: opts.period ?? null }).run();
  const done = Promise.resolve().then(work)
    .catch((): Outcome => ({ status: 'failed', detail: 'stopped by an unexpected error' }))
    .then((o) => {
      db.update(t.jobRun).set({ status: o.status, detail: o.detail.slice(0, 1000), finishedAt: new Date().toISOString() }).where(eq(t.jobRun.id, id)).run();
      opts.after?.(o, id);
    })
    .finally(() => { running.delete(job); });
  running.set(job, done);
  return { id, done };
}

/**
 * Runs `work` in `job`'s slot, after whatever holds it now: the monthly refresh's steps share their slots with the same
 * jobs run by hand, so a step never runs next to itself.
 */
export async function inSlot(job: string, work: () => Promise<Outcome>): Promise<Outcome> {
  while (running.has(job)) await running.get(job);
  const p = work();
  running.set(job, p.then(() => {}, () => {}).finally(() => running.delete(job)));
  return p;
}

/** After a restart: a run that was going when the server stopped did not finish. */
export function closeInterrupted(db: Db): void {
  db.update(t.jobRun).set({ status: 'failed', detail: 'interrupted: the server stopped', finishedAt: new Date().toISOString() }).where(eq(t.jobRun.status, 'running')).run();
}
