// Jobs run in the background, one of each kind at a time, each logged in job_run (started, finished, how it went).
// The detail is Shelf's own words (counts and the egress client's reasons), never a secret or a page's text.
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import type { Outcome } from './books';

const running = new Map<string, Promise<void>>();

/** Starts `work` as `job`; null when that job is running already. `done` settles once its row is written. */
export function startJob(db: Db, job: string, work: () => Promise<Outcome>): { id: string; done: Promise<void> } | null {
  if (running.has(job)) return null;
  const id = ulid();
  db.insert(t.jobRun).values({ id, job, status: 'running', startedAt: new Date().toISOString() }).run();
  const done = work()
    .catch((): Outcome => ({ status: 'failed', detail: 'stopped by an unexpected error' }))
    .then((o) => { db.update(t.jobRun).set({ status: o.status, detail: o.detail.slice(0, 500), finishedAt: new Date().toISOString() }).where(eq(t.jobRun.id, id)).run(); })
    .finally(() => { running.delete(job); });
  running.set(job, done);
  return { id, done };
}

/** After a restart: a run that was going when the server stopped did not finish. */
export function closeInterrupted(db: Db): void {
  db.update(t.jobRun).set({ status: 'failed', detail: 'interrupted: the server stopped', finishedAt: new Date().toISOString() }).where(eq(t.jobRun.status, 'running')).run();
}
