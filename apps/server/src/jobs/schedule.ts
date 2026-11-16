// The scheduler (spec §5 step 1): a job that runs once a period, at the household's day, time and time zone. Each period
// runs once whatever restarts, overlaps or clocks do, because the claim on it is a row (`job_period`, one per job and
// period) taken in one immediate transaction:
//
// - only the period it is now is claimed (the household's month at the time of the claim), once its moment has come; a
//   month missed while the server was off is not made up later, and a retry left waiting in a month that is over is
//   given up;
// - a row of now's month is what it says, whatever clock wrote it: a run a few minutes early or late (NTP stepping,
//   an RTC in local time) is the month's run;
// - a row for a month later than now's is from a clock that was wrong (ahead when it ran, or behind now). It never
//   fences the month it is now; it is made `void` (Settings says so: cycleView futureRun), so that month runs again
//   when it comes, except the steps that happen once a period (ScheduledJob.once: the push, the AI's), which stay
//   done. Its attempts still count (SCHEDULE.maxAttempts is per period and never starts over). The cost: a clock set
//   back into a month that never ran runs that month once;
// - a claim holds a lease (SCHEDULE.leaseMs, longer than a run may take); nobody else claims the period while it holds,
//   and in this process a job still running is never started again (jobs/run.ts), lease or not;
// - every write of a claim's progress or end names the claim's attempt (a fencing token): a claim that lost its lease
//   changes nothing;
// - a run that failed is tried again after a backoff (5 minutes, then 4 times longer each time), at most
//   SCHEDULE.maxAttempts times, then given up (logged; an admin can still run the job by hand);
// - the steps a run finished are kept, so a retry does only the rest.
//
// Wall times are the household's (household_settings: cycle_day, cycle_time, timezone). A time that does not exist on
// the day (the clocks go forward) runs as late as it would have been read with the old offset (02:30 becomes 03:30); a
// time that happens twice (the clocks go back) runs the first time. The day is capped at the month's last.
import { and, eq, gt, lt, ne } from 'drizzle-orm';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import type { Outcome } from './books';
import { isRunning, startJob } from './run';
import { validTimeZone } from './zone';

export const SCHEDULE = {
  /** How often the scheduler looks at the clock. */
  tickMs: 60_000,
  /** A run checks this between its steps and inside its long loops; nothing new starts after it. */
  deadlineMs: 90 * 60_000,
  /** Longer than a run may take: its deadline plus the longest single request (an AI call: 300 s) and a margin. */
  leaseMs: 2 * 3600_000,
  backoffMs: 5 * 60_000,
  backoffFactor: 4,
  maxAttempts: 5,
} as const;

export interface Cycle { day: number; time: string; timezone: string }
/** Before the household has its settings row (its column defaults apply after): UTC, no place assumed. */
export const DEFAULT_CYCLE: Cycle = { day: 1, time: '20:17', timezone: 'UTC' };

export class CycleError extends Error {}

/**
 * The household's settings row, made at the server's first start with PHILOBIBLOS_TZ as the household's zone. That is the only
 * time PHILOBIBLOS_TZ is read: from then on the household's zone (Settings, admins change it) is the one zone for the monthly
 * refresh, "this month", the plan and its window.
 */
export function initHousehold(db: Db, timezone: string): void {
  if (!validTimeZone(timezone)) throw new CycleError(`PHILOBIBLOS_TZ: a time zone such as Europe/Zurich`);
  db.insert(t.householdSettings).values({ id: 1, timezone }).onConflictDoNothing().run();
}

/** The household's time zone: the one zone for "this month" everywhere. */
export const householdZone = (db: Db): string => getCycle(db).timezone;

export function getCycle(db: Db): Cycle {
  const r = db.select({ day: t.householdSettings.cycleDay, time: t.householdSettings.cycleTime, timezone: t.householdSettings.timezone }).from(t.householdSettings).where(eq(t.householdSettings.id, 1)).get();
  return r ? { day: r.day, time: r.time, timezone: r.timezone } : { ...DEFAULT_CYCLE };
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** PATCH /settings { cycle }: the day (1 to 28, so every month has it), HH:MM, and an IANA time zone. */
export function setCycle(db: Db, body: unknown): Cycle {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CycleError('cycle: { day, time, timezone }');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!['day', 'time', 'timezone'].includes(k)) throw new CycleError(`cycle: unknown field ${k}`);
  const next = { ...getCycle(db), ...b } as Record<string, unknown>;
  if (!Number.isInteger(next.day) || (next.day as number) < 1 || (next.day as number) > 28) throw new CycleError('cycle.day: 1 to 28');
  if (typeof next.time !== 'string' || !TIME.test(next.time)) throw new CycleError('cycle.time: HH:MM, 00:00 to 23:59');
  if (!validTimeZone(next.timezone)) throw new CycleError('cycle.timezone: a time zone such as Europe/Zurich');
  const c = { day: next.day as number, time: next.time, timezone: next.timezone };
  db.insert(t.householdSettings).values({ id: 1, cycleDay: c.day, cycleTime: c.time, timezone: c.timezone })
    .onConflictDoUpdate({ target: t.householdSettings.id, set: { cycleDay: c.day, cycleTime: c.time, timezone: c.timezone } }).run();
  return c;
}

const formats = new Map<string, Intl.DateTimeFormat>();
function wall(ms: number, tz: string): number {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    formats.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
}
/** The zone's offset from UTC at that instant, in ms (to the minute). */
const offsetAt = (ms: number, tz: string) => wall(ms, tz) - Math.floor(ms / 60_000) * 60_000;

/** The instant a wall time happens in a zone: the first of two when the clocks go back; read with the old offset in a gap. */
export function zonedInstant(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const w = Date.UTC(y, mo - 1, d, h, mi);
  const before = offsetAt(w - 86_400_000, tz);
  const offsets = [...new Set([before, offsetAt(w, tz), offsetAt(w + 86_400_000, tz)])];
  const valid = offsets.map((o) => w - o).filter((i) => wall(i, tz) === w).sort((a, b) => a - b);
  return new Date(valid[0] ?? w - before);
}

/** The period (the month, in the household's zone) `now` is in, and the moment its run is due. */
export function dueAt(c: Cycle, now: Date): { period: string; at: Date } {
  const w = new Date(wall(now.getTime(), c.timezone));
  const y = w.getUTCFullYear(), mo = w.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const [h, mi] = c.time.split(':').map(Number) as [number, number];
  return { period: `${y}-${String(mo).padStart(2, '0')}`, at: zonedInstant(y, mo, Math.min(c.day, last), h, mi, c.timezone) };
}

/**
 * Settings.cycle: the household's day, time and zone, when the next run is due, how the last period went (void rows,
 * from a clock that was wrong, are not a month's run), `futureRun`: a run recorded for a month later than now's (the
 * clock was ahead, or is behind now), and `problem` when the stored zone is not one this server knows (nothing runs).
 */
export function cycleView(db: Db, job: string, now = new Date()) {
  const c = getCycle(db);
  if (!validTimeZone(c.timezone)) return { ...c, problem: zoneProblem(c.timezone) };
  const cur = dueAt(c, now);
  const rows = db.select().from(t.jobPeriod).where(eq(t.jobPeriod.job, job)).all();
  const future = rows.filter((r) => r.period > cur.period).map((r) => r.period).sort().at(-1);
  const last = rows.filter((r) => r.period <= cur.period && r.status !== 'void').sort((a, b) => (a.period < b.period ? 1 : -1))[0];
  const row = last?.period === cur.period ? last : null;
  const over = row && (row.status === 'done' || row.status === 'gave_up');
  const next = over ? dueAt(c, firstOfNext(cur.period, c.timezone)).at : row?.status === 'retry' && row.nextTryAt ? new Date(row.nextTryAt) : cur.at;
  return { ...c, next: next.toISOString(), ...(last ? { last: { period: last.period, status: last.status, attempts: last.attempts } } : {}), ...(future ? { futureRun: future } : {}) };
}
const zoneProblem = (tz: string) => `the household's time zone (${tz.slice(0, 64)}) is not one this server knows: nothing runs until an admin sets it again`;
const firstOfNext = (period: string, tz: string) => {
  const y = Number(period.slice(0, 4)), m = Number(period.slice(5, 7));
  return zonedInstant(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1, 12, 0, tz);
};

export interface Claim { job: string; period: string; attempt: number; steps: string[] }

/**
 * The claim on a period, or null: not the period it is now (the household's month at `now`), or not free (held, done,
 * given up, waiting for its retry). In the same transaction, rows of later months are made void (keeping the steps in
 * `once`), and a retry still waiting in a month that is over is given up.
 */
export function claim(db: Db, job: string, period: string, now: Date, once: readonly string[] = []): Claim | null {
  const iso = now.toISOString();
  const lease = new Date(now.getTime() + SCHEDULE.leaseMs).toISOString();
  return db.transaction((tx) => {
    const cur = dueAt(getCycle(tx as unknown as Db), now).period;
    for (const r of tx.select().from(t.jobPeriod).where(and(eq(t.jobPeriod.job, job), gt(t.jobPeriod.period, cur), ne(t.jobPeriod.status, 'void'))).all()) {
      const kept = (JSON.parse(r.stepsJson) as string[]).filter((x) => once.includes(x));
      tx.update(t.jobPeriod).set({ status: 'void', stepsJson: JSON.stringify(kept), leaseUntil: null, nextTryAt: null, updatedAt: iso })
        .where(and(eq(t.jobPeriod.job, job), eq(t.jobPeriod.period, r.period))).run();
    }
    tx.update(t.jobPeriod).set({ status: 'gave_up', nextTryAt: null, updatedAt: iso }).where(and(eq(t.jobPeriod.job, job), lt(t.jobPeriod.period, cur), eq(t.jobPeriod.status, 'retry'))).run();
    if (period !== cur) return null;
    const where = and(eq(t.jobPeriod.job, job), eq(t.jobPeriod.period, period));
    const row = tx.select().from(t.jobPeriod).where(where).get();
    if (!row) {
      tx.insert(t.jobPeriod).values({ job, period, status: 'running', attempts: 1, leaseUntil: lease, updatedAt: iso }).run();
      return { job, period, attempt: 1, steps: [] };
    }
    const free = row.status === 'void' || (row.status === 'retry' && (row.nextTryAt ?? '') <= iso) || (row.status === 'running' && (row.leaseUntil ?? '') <= iso);
    if (!free) return null;
    if (row.attempts >= SCHEDULE.maxAttempts) {
      tx.update(t.jobPeriod).set({ status: 'gave_up', leaseUntil: null, nextTryAt: null, updatedAt: iso }).where(where).run();
      return null;
    }
    // The attempt number goes on, void or not: a fencing token is never used twice.
    const attempt = row.attempts + 1;
    tx.update(t.jobPeriod).set({ status: 'running', attempts: attempt, leaseUntil: lease, nextTryAt: null, ...(row.status === 'void' ? { runId: null } : {}), updatedAt: iso }).where(where).run();
    return { job, period, attempt, steps: JSON.parse(row.stepsJson) as string[] };
  }, { behavior: 'immediate' });
}

const held = (c: Claim) => and(eq(t.jobPeriod.job, c.job), eq(t.jobPeriod.period, c.period), eq(t.jobPeriod.status, 'running'), eq(t.jobPeriod.attempts, c.attempt));

/** A step done: kept, so a retry skips it. Only while the claim is still this one. */
export function stepDone(db: Db, c: Claim, step: string, now = new Date()): void {
  if (!c.steps.includes(step)) c.steps.push(step);
  db.update(t.jobPeriod).set({ stepsJson: JSON.stringify(c.steps), updatedAt: now.toISOString() }).where(held(c)).run();
}

/** The backoff before attempt n + 1. */
export const backoff = (attempt: number) => SCHEDULE.backoffMs * SCHEDULE.backoffFactor ** (attempt - 1);

/**
 * The run's end: done, or a retry after its backoff, or given up after the last attempt, or when the retry would fall
 * in the next month (the household's: a period's retries stay in it). Only while the claim is this one.
 */
export function finish(db: Db, c: Claim, o: Outcome, runId: string, now = new Date()): void {
  const iso = now.toISOString();
  const retryAt = new Date(now.getTime() + backoff(c.attempt));
  const inPeriod = (() => { try { return dueAt(getCycle(db), retryAt).period === c.period; } catch { return false; } })();
  const set = o.status !== 'failed' ? { status: 'done' as const, nextTryAt: null }
    : c.attempt >= SCHEDULE.maxAttempts || !inPeriod ? { status: 'gave_up' as const, nextTryAt: null }
    : { status: 'retry' as const, nextTryAt: retryAt.toISOString() };
  db.update(t.jobPeriod).set({ ...set, leaseUntil: null, runId, updatedAt: iso }).where(held(c)).run();
}

/**
 * After a restart: a claim this server held did not finish. Free for its retry now (one Philobiblos server per database, as
 * jobs/run.ts closeInterrupted assumes); the attempt it used counts.
 */
export function releaseInterrupted(db: Db, now = new Date()): void {
  db.update(t.jobPeriod).set({ status: 'retry', leaseUntil: null, nextTryAt: now.toISOString(), updatedAt: now.toISOString() }).where(eq(t.jobPeriod.status, 'running')).run();
}

export interface RunControl { claim: Claim; deadline: Date; step(name: string): void }
/** `once`: the steps that happen once a period whatever clocks do (a void row keeps them done). */
export interface ScheduledJob { job: string; once?: readonly string[]; run(ctl: RunControl): Promise<Outcome> }

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly db: Db, private readonly jobs: ScheduledJob[], private readonly o: { now?: () => Date; tickMs?: number; log?: (msg: string) => void } = {}) {}
  private now() { return (this.o.now ?? (() => new Date()))(); }

  start(): void {
    releaseInterrupted(this.db, this.now());
    this.timer = setInterval(() => { void this.tick(); }, this.o.tickMs ?? SCHEDULE.tickMs);
    this.timer.unref();
    void this.tick();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /**
   * Starts each job whose period is due and free; resolves to the runs started (each settles once its rows are written).
   * Never rejects: an error (a stored zone this server does not know, say) is logged, Settings shows it, and the next
   * tick tries again.
   */
  async tick(): Promise<Promise<void>[]> {
    const started: Promise<void>[] = [];
    for (const j of this.jobs) {
      try { this.tickJob(j, started); } catch (e) {
        (this.o.log ?? ((m) => console.error(m)))(`scheduler: ${j.job} not started: ${e instanceof Error ? e.message.slice(0, 200) : 'an error'}`);
      }
    }
    return started;
  }
  private tickJob(j: ScheduledJob, started: Promise<void>[]): void {
    const now = this.now();
    const cycle = getCycle(this.db);
    if (!validTimeZone(cycle.timezone)) throw new CycleError(zoneProblem(cycle.timezone));
    const { period, at } = dueAt(cycle, now);
    if (now < at || isRunning(j.job)) return;
    const c = claim(this.db, j.job, period, now, j.once);
    if (!c) return;
    const deadline = new Date(now.getTime() + SCHEDULE.deadlineMs);
    const run = startJob(this.db, j.job, () => j.run({ claim: c, deadline, step: (s) => stepDone(this.db, c, s, this.now()) }), {
      period, after: (o, id) => finish(this.db, c, o, id, this.now()),
    });
    // isRunning was false just above, and nothing ran in between: the slot is free.
    if (run) started.push(run.done);
  }
}
