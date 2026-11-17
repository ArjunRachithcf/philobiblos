// The scheduler and the monthly refresh (spec §5 step 1, philobiblos#8 h): a period runs once whatever restarts, overlaps,
// clocks and time zones do; failures are tried again with a backoff, then given up; a retry does only the steps left;
// nothing new starts past the run's deadline. The clock is a fake one throughout; no request leaves (egress off).
import { createECDH } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { fakeModel } from '@philobiblos/ai';
import { AiJobs } from '../src/ai/jobs';
import { buildApp } from '../src/app';
import type { PriceSource } from '../src/books/prices';
import { loadConfig } from '../src/config';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { refreshPrices } from '../src/jobs/books';
import { startJob } from '../src/jobs/run';
import { SCHEDULE, Scheduler, backoff, claim, cycleView, initHousehold, dueAt, finish, releaseInterrupted, setCycle, stepDone, zonedInstant, type Cycle } from '../src/jobs/schedule';
import { monthlyRefresh } from '../src/month/refresh';
import { POST_TIMEOUT_MAX_MS, type Egress } from '../src/net/egress';
import { subscribe } from '../src/push/push';
import { ORIGIN, TEST_SEALING_KEY, household, sessionCookie } from './helpers';

const Z = 'Europe/Zurich';
const at = (iso: string) => new Date(iso);
const row = (db: Db, period: string) => db.select().from(t.jobPeriod).where(and(eq(t.jobPeriod.job, 'monthly'), eq(t.jobPeriod.period, period))).get();
const ok = { status: 'done' as const, detail: 'ok' };
/** A job_run row for a claim to name. */
const runRow = (db: Db) => { const id = `r${Math.random().toString(36).slice(2)}`; db.insert(t.jobRun).values({ id, job: 'monthly', status: 'done', startedAt: new Date().toISOString() }).run(); return id; };

describe('wall times in the household\'s zone', () => {
  it('an ordinary day, summer and winter', () => {
    expect(zonedInstant(2026, 12, 1, 20, 17, Z).toISOString()).toBe('2026-12-01T19:17:00.000Z');
    expect(zonedInstant(2026, 7, 1, 20, 17, Z).toISOString()).toBe('2026-07-01T18:17:00.000Z');
    expect(zonedInstant(2026, 7, 1, 20, 17, 'Asia/Kolkata').toISOString()).toBe('2026-07-01T14:47:00.000Z');
    expect(zonedInstant(2026, 7, 1, 20, 17, 'America/New_York').toISOString()).toBe('2026-07-02T00:17:00.000Z');
  });
  it('a time the clocks skip runs as read with the old offset; a time that happens twice runs the first time', () => {
    // Zurich, 29 March 2026: 02:00 → 03:00. 02:30 does not exist; it runs at 03:30 local.
    expect(zonedInstant(2026, 3, 29, 2, 30, Z).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    // Zurich, 25 October 2026: 03:00 → 02:00. 02:30 happens at 00:30Z (summer time) and at 01:30Z: the first.
    expect(zonedInstant(2026, 10, 25, 2, 30, Z).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    // A half-hour change (Lord Howe Island, 5 April 2026: 02:00 → 01:30).
    expect(zonedInstant(2026, 4, 5, 1, 45, 'Australia/Lord_Howe').toISOString()).toBe('2026-04-04T14:45:00.000Z');
  });
  it('the period is the month in the household\'s zone, not UTC\'s', () => {
    const c: Cycle = { day: 1, time: '00:10', timezone: Z };
    expect(dueAt(c, at('2026-11-30T23:30:00Z'))).toEqual({ period: '2026-12', at: at('2026-11-30T23:10:00Z') });
    expect(dueAt({ ...c, timezone: 'America/New_York' }, at('2026-12-01T03:00:00Z')).period).toBe('2026-11');
  });
  it('a day past the month\'s end (a row written by hand) is the month\'s last day', () => {
    expect(dueAt({ day: 31, time: '12:00', timezone: 'UTC' }, at('2027-02-10T00:00:00Z')).at.toISOString()).toBe('2027-02-28T12:00:00.000Z');
  });
  it('the cycle is checked before it is stored: a day every month has, HH:MM, a real time zone', () => {
    const db = household();
    for (const bad of [{ day: 0 }, { day: 29 }, { day: 1.5 }, { time: '24:00' }, { time: '7:00' }, { time: '07:00:00' }, { timezone: 'Mars/Olympus' }, { timezone: '../../etc/passwd' }, { timezone: 'x'.repeat(65) }, { when: 1 }]) {
      expect(() => setCycle(db, bad)).toThrow(/cycle/);
    }
    expect(setCycle(db, { day: 28, time: '23:59', timezone: 'Pacific/Chatham' })).toEqual({ day: 28, time: '23:59', timezone: 'Pacific/Chatham' });
  });
});

describe('a period runs once', () => {
  it('claimed once; done is done for the rest of the month', () => {
    const db = household();
    const c = claim(db, 'monthly', '2026-12', at('2026-12-01T20:00:00Z'))!;
    expect(c).toMatchObject({ period: '2026-12', attempt: 1, steps: [] });
    expect(claim(db, 'monthly', '2026-12', at('2026-12-01T20:00:00Z'))).toBeNull();
    finish(db, c, ok, runRow(db), at('2026-12-01T20:05:00Z'));
    expect(row(db, '2026-12')).toMatchObject({ status: 'done', leaseUntil: null });
    for (const when of ['2026-12-01T20:06:00Z', '2026-12-15T00:00:00Z', '2026-12-31T22:59:00Z']) expect(claim(db, 'monthly', '2026-12', at(when))).toBeNull();
  });

  it('a claim holds its lease; once the lease is over the period is free again, and the old claim changes nothing', () => {
    const db = household();
    const t0 = at('2026-12-01T20:00:00Z');
    const first = claim(db, 'monthly', '2026-12', t0)!;
    expect(claim(db, 'monthly', '2026-12', new Date(t0.getTime() + SCHEDULE.leaseMs - 1000))).toBeNull();
    const second = claim(db, 'monthly', '2026-12', new Date(t0.getTime() + SCHEDULE.leaseMs))!;
    expect(second.attempt).toBe(2);
    // The first run, still going somewhere, ends: nothing of it is written.
    stepDone(db, first, 'mail');
    finish(db, first, ok, runRow(db));
    expect(row(db, '2026-12')).toMatchObject({ status: 'running', attempts: 2, stepsJson: '[]' });
  });

  it('a clock set back into a month that never ran runs it once; the later month it left is void, and runs again without its once-a-period steps', () => {
    const db = household();
    const once = ['push', 'ai_suggest'];
    const c = claim(db, 'monthly', '2026-12', at('2026-12-01T20:00:00Z'), once)!;
    for (const s of ['mail', 'push', 'ai_suggest']) stepDone(db, c, s, at('2026-12-01T20:02:00Z'));
    finish(db, c, ok, runRow(db), at('2026-12-01T20:05:00Z'));
    // The clock goes back to November: December's row is from a later month, so it does not fence November.
    const nov = claim(db, 'monthly', '2026-11', at('2026-11-20T20:00:00Z'), once)!;
    expect(nov).toMatchObject({ period: '2026-11', attempt: 1 });
    finish(db, nov, ok, runRow(db), at('2026-11-20T20:01:00Z'));
    expect(row(db, '2026-12')).toMatchObject({ status: 'void', stepsJson: '["push","ai_suggest"]', attempts: 1 });
    // Back to the right time: December runs again, but its push and its AI stay done; then never again.
    expect(claim(db, 'monthly', '2026-12', at('2026-12-01T20:10:00Z'), once)).toMatchObject({ attempt: 2, steps: ['push', 'ai_suggest'] });
    expect(claim(db, 'monthly', '2027-01', at('2027-01-01T20:00:00Z'), once)).not.toBeNull();
  });

  it('a row of this month counts whatever clock wrote it: a run a few minutes early or late is the month\'s run', () => {
    const db = household();
    // A: the clock was 10 minutes ahead while it ran (the row says 19:22Z); corrected, it ticks from 19:13Z.
    const a = claim(db, 'monthly', '2026-12', at('2026-12-01T19:17:00Z'))!;
    finish(db, a, ok, runRow(db), at('2026-12-01T19:22:00Z'));
    for (let m = 13; m < 40; m++) expect(claim(db, 'monthly', '2026-12', at(`2026-12-01T19:${m}:00Z`))).toBeNull();
    // B: an hour's step back after a month that needed retries.
    const db2 = household();
    let now = at('2026-12-01T19:17:00Z');
    for (let i = 1; i <= 3; i++) {
      const c = claim(db2, 'monthly', '2026-12', now)!;
      finish(db2, c, i < 3 ? { status: 'failed', detail: 'no' } : ok, runRow(db2), now);
      if (i < 3) now = new Date(row(db2, '2026-12')!.nextTryAt!);
    }
    expect(row(db2, '2026-12')).toMatchObject({ status: 'done', attempts: 3 });
    for (const back of [2 * 60_000, 3600_000]) expect(claim(db2, 'monthly', '2026-12', new Date(now.getTime() - back))).toBeNull();
    expect(row(db2, '2026-12')).toMatchObject({ status: 'done', attempts: 3 });
  });

  it('the attempt limit is per period and counts across voids: it never starts over', () => {
    const db = household();
    let now = at('2027-11-02T10:00:00Z');
    for (let i = 1; i <= SCHEDULE.maxAttempts; i++) {
      const c = claim(db, 'monthly', '2027-11', now)!;
      finish(db, c, { status: 'failed', detail: 'no' }, runRow(db), now);
      now = new Date(now.getTime() + backoff(i));
    }
    expect(row(db, '2027-11')).toMatchObject({ status: 'gave_up', attempts: SCHEDULE.maxAttempts });
    // Corrected, then the month really comes: void, but its attempts are spent.
    claim(db, 'monthly', '2026-12', at('2026-12-01T20:30:00Z'));
    expect(row(db, '2027-11')).toMatchObject({ status: 'void', attempts: SCHEDULE.maxAttempts });
    expect(claim(db, 'monthly', '2027-11', at('2027-11-01T20:30:00Z'))).toBeNull();
    expect(row(db, '2027-11')).toMatchObject({ status: 'gave_up', attempts: SCHEDULE.maxAttempts });
    // Repeated steps back never push the count past the limit.
    const db2 = household();
    for (let i = 0; i < 10; i++) {
      claim(db2, 'monthly', '2027-01', at('2027-01-01T20:00:00Z'));
      claim(db2, 'monthly', '2026-12', at('2026-12-01T20:00:00Z'));
    }
    expect(row(db2, '2027-01')!.attempts).toBeLessThanOrEqual(SCHEDULE.maxAttempts);
  });

  it('a period\'s retries stay in it: one that would fall in the next month gives up, and a retry left in a month that is over is given up', () => {
    const db = household();
    setCycle(db, { day: 28, time: '22:00', timezone: Z });
    let now = at('2027-02-28T21:00:00Z');
    const seen: string[] = [];
    for (let i = 1; i <= SCHEDULE.maxAttempts; i++) {
      const c = claim(db, 'monthly', '2027-02', now);
      if (!c) break;
      finish(db, c, { status: 'failed', detail: 'no' }, runRow(db), now);
      const r = row(db, '2027-02')!;
      seen.push(r.status);
      if (r.status !== 'retry') break;
      expect(r.nextTryAt! < '2027-02-28T23:00:00.000Z').toBe(true);
      now = new Date(r.nextTryAt!);
    }
    expect(seen.at(-1)).toBe('gave_up');
    const db2 = household();
    const c = claim(db2, 'monthly', '2026-12', at('2026-12-01T20:00:00Z'))!;
    finish(db2, c, { status: 'failed', detail: 'no' }, runRow(db2), at('2026-12-01T20:00:00Z'));
    db2.update(t.jobPeriod).set({ nextTryAt: '2027-01-05T00:00:00.000Z' }).run();
    claim(db2, 'monthly', '2027-01', at('2027-01-02T20:00:00Z'));
    expect(row(db2, '2026-12')).toMatchObject({ status: 'gave_up' });
  });

  it('only the month it is now is claimed: never a later or an earlier one', () => {
    const db = household();
    expect(claim(db, 'monthly', '2027-01', at('2026-12-01T20:00:00Z'))).toBeNull();
    expect(claim(db, 'monthly', '2026-11', at('2026-12-01T20:00:00Z'))).toBeNull();
    expect(db.select().from(t.jobPeriod).all()).toEqual([]);
  });

  it('a clock set forward once does not stop the months behind it; the month it ran is run again when it comes', () => {
    const db = household();
    const fwd = claim(db, 'monthly', '2027-11', at('2027-11-02T10:00:00Z'))!;
    stepDone(db, fwd, 'mail', at('2027-11-02T10:01:00Z'));
    finish(db, fwd, ok, runRow(db), at('2027-11-02T10:05:00Z'));
    const dec = claim(db, 'monthly', '2026-12', at('2026-12-01T20:30:00Z'))!;
    expect(dec).toMatchObject({ period: '2026-12', attempt: 1, steps: [] });
    // November 2027 itself: its row was written later than the real moment, so it runs, from the start (the attempt
    // number goes on: a claim's fencing token is never used twice).
    const nov = claim(db, 'monthly', '2027-11', at('2027-11-01T20:30:00Z'))!;
    expect(nov).toMatchObject({ period: '2027-11', attempt: 2, steps: [] });
    expect(row(db, '2027-11')).toMatchObject({ status: 'running', stepsJson: '[]', runId: null });
    // A row of this month written "later" than now (the run was minutes ago by a clock that was ahead) is never void.
    // The old claim changes nothing any more; the new one finishes the month, once.
    finish(db, fwd, { status: 'failed', detail: 'no' }, runRow(db), at('2027-11-01T20:31:00Z'));
    expect(row(db, '2027-11')).toMatchObject({ status: 'running', attempts: 2 });
    finish(db, nov, ok, runRow(db), at('2027-11-01T20:40:00Z'));
    expect(claim(db, 'monthly', '2027-11', at('2027-11-02T12:00:00Z'))).toBeNull();
  });

  it('a failure is tried again after a backoff that grows, then given up after the last attempt', () => {
    const db = household();
    let now = at('2026-12-01T20:00:00Z');
    const waits: number[] = [];
    for (let i = 1; i <= SCHEDULE.maxAttempts; i++) {
      const c = claim(db, 'monthly', '2026-12', now)!;
      expect(c.attempt).toBe(i);
      finish(db, c, { status: 'failed', detail: 'no' }, runRow(db), now);
      if (i === SCHEDULE.maxAttempts) break;
      const next = new Date(row(db, '2026-12')!.nextTryAt!);
      waits.push(next.getTime() - now.getTime());
      expect(claim(db, 'monthly', '2026-12', new Date(next.getTime() - 1000))).toBeNull();
      now = next;
    }
    expect(waits).toEqual([5, 20, 80, 320].map((m) => m * 60_000));
    expect(waits).toEqual([1, 2, 3, 4].map(backoff));
    expect(row(db, '2026-12')).toMatchObject({ status: 'gave_up', attempts: SCHEDULE.maxAttempts });
    expect(claim(db, 'monthly', '2026-12', at('2026-12-20T00:00:00Z'))).toBeNull();
  });

  it('a run that never ends counts its attempts too: after the last, the period is given up', () => {
    const db = household();
    let now = at('2026-12-01T20:00:00Z');
    for (let i = 1; i <= SCHEDULE.maxAttempts; i++) {
      expect(claim(db, 'monthly', '2026-12', now)?.attempt).toBe(i);
      now = new Date(now.getTime() + SCHEDULE.leaseMs);
    }
    expect(claim(db, 'monthly', '2026-12', now)).toBeNull();
    expect(row(db, '2026-12')).toMatchObject({ status: 'gave_up' });
  });

  it('a run that ended blocked (a step that cannot run here, say) is done: it is not tried again', () => {
    const db = household();
    const c = claim(db, 'monthly', '2026-12', at('2026-12-01T20:00:00Z'))!;
    finish(db, c, { status: 'blocked', detail: 'no mailbox' }, runRow(db), at('2026-12-01T20:05:00Z'));
    expect(row(db, '2026-12')).toMatchObject({ status: 'done' });
  });

  it('after a restart, a claim the old server held is free at once and keeps its finished steps', () => {
    const db = household();
    const c = claim(db, 'monthly', '2026-12', at('2026-12-01T20:00:00Z'))!;
    stepDone(db, c, 'mail', at('2026-12-01T20:01:00Z'));
    stepDone(db, c, 'shares', at('2026-12-01T20:02:00Z'));
    releaseInterrupted(db, at('2026-12-01T20:10:00Z'));
    expect(claim(db, 'monthly', '2026-12', at('2026-12-01T20:10:00Z'))).toMatchObject({ attempt: 2, steps: ['mail', 'shares'] });
  });

  it('a lease outlasts the run\'s deadline and its longest request', () => {
    expect(SCHEDULE.leaseMs).toBeGreaterThan(SCHEDULE.deadlineMs + POST_TIMEOUT_MAX_MS);
  });
});

describe('the scheduler', () => {
  const sched = (db: Db, clock: { now: Date }, run: () => Promise<{ status: 'done' | 'failed'; detail: string }>) => new Scheduler(db, [{ job: 'monthly', run }], { now: () => clock.now });

  it('starts nothing before the household\'s moment, then once', async () => {
    const db = household();
    setCycle(db, { day: 1, time: '20:17', timezone: Z });
    const clock = { now: at('2026-12-01T19:16:00Z') };
    let runs = 0;
    const s = sched(db, clock, async () => { runs++; return ok; });
    expect(await s.tick()).toEqual([]);
    clock.now = at('2026-12-01T19:17:00Z');
    await Promise.all(await s.tick());
    clock.now = at('2026-12-01T19:18:00Z');
    await Promise.all(await s.tick());
    expect(runs).toBe(1);
    expect(db.select().from(t.jobRun).where(eq(t.jobRun.job, 'monthly')).all()).toEqual([expect.objectContaining({ status: 'done', period: '2026-12' })]);
  });

  for (const [name, day, timezone, from] of [
    ['the night the clocks go back (02:30 twice)', 25, Z, '2026-10-24T22:00:00Z'],
    ['the night the clocks go forward (no 02:30)', 8, 'America/New_York', '2026-03-08T04:00:00Z'],
  ] as const) {
    it(`once on ${name}`, async () => {
      const db = household();
      setCycle(db, { day, time: '02:30', timezone });
      const clock = { now: at(from) };
      const runs: string[] = [];
      const s = sched(db, clock, async () => { runs.push(clock.now.toISOString()); return ok; });
      for (let i = 0; i < 6 * 8; i++) { await Promise.all(await s.tick()); clock.now = new Date(clock.now.getTime() + 10 * 60_000); }
      expect(runs).toHaveLength(1);
    });
  }

  it('a month the server was off for is not made up; the month it comes back in runs', async () => {
    const db = household();
    setCycle(db, { timezone: Z });
    const clock = { now: at('2026-12-01T20:00:00Z') };
    const s = sched(db, clock, async () => ok);
    await Promise.all(await s.tick());
    clock.now = at('2027-02-10T08:00:00Z');
    await Promise.all(await s.tick());
    expect(db.select({ p: t.jobPeriod.period }).from(t.jobPeriod).all().map((r) => r.p)).toEqual(['2026-12', '2027-02']);
  });

  it('never next to a run of the same job, by hand or not', async () => {
    const db = household();
    setCycle(db, { timezone: Z });
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const byHand = startJob(db, 'monthly', async () => { await gate; return ok; })!;
    const clock = { now: at('2026-12-01T20:00:00Z') };
    const s = sched(db, clock, async () => ok);
    expect(await s.tick()).toEqual([]);
    expect(row(db, '2026-12')).toBeUndefined();
    release();
    await byHand.done;
    expect(await s.tick()).toHaveLength(1);
  });

  it('a clock set forward for one tick, then corrected: every month after it runs exactly once, and Settings says what happened', async () => {
    const db = household();
    setCycle(db, { day: 1, time: '20:17', timezone: Z });
    const clock = { now: at('2027-11-02T10:00:00Z') };
    const s = sched(db, clock, async () => ok);
    await Promise.all(await s.tick());
    clock.now = at('2026-12-01T20:30:00Z');
    await Promise.all(await s.tick());
    expect(cycleView(db, 'monthly', clock.now)).toMatchObject({ next: '2027-01-01T19:17:00.000Z', last: { period: '2026-12', status: 'done' }, futureRun: '2027-11' });
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      // The month the wrong clock ran: Settings says it runs again, on its day.
      if (m === 11) expect(cycleView(db, 'monthly', at('2027-11-01T12:00:00Z'))).toMatchObject({ next: '2027-11-01T19:17:00.000Z', last: { period: '2027-10', status: 'done' } });
      for (const when of [`2027-${mm}-01T20:30:00Z`, `2027-${mm}-01T23:00:00Z`, `2027-${mm}-15T12:00:00Z`]) {
        clock.now = at(when);
        await Promise.all(await s.tick());
      }
    }
    const runs = db.select({ p: t.jobRun.period }).from(t.jobRun).where(eq(t.jobRun.job, 'monthly')).all().map((r) => r.p);
    // The one tick at the wrong time ran "2027-11" once; after it, each month once.
    expect(runs).toEqual(['2027-11', '2026-12', ...Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, '0')}`)]);
    expect(cycleView(db, 'monthly', clock.now)).not.toHaveProperty('futureRun');
  });

  it('a stored zone this server does not know: the tick logs it and starts nothing, Settings says so, and nothing throws', async () => {
    const db = household();
    setCycle(db, { timezone: Z });
    db.update(t.householdSettings).set({ timezone: 'Mars/Olympus' }).run();
    const logged: string[] = [];
    let runs = 0;
    const s = new Scheduler(db, [{ job: 'monthly', run: async () => { runs++; return ok; } }], { now: () => at('2026-12-01T20:00:00Z'), log: (m) => logged.push(m) });
    await expect(s.tick()).resolves.toEqual([]);
    expect(runs).toBe(0);
    expect(logged).toEqual([expect.stringMatching(/Mars\/Olympus.*not one this server knows/)]);
    expect(cycleView(db, 'monthly', at('2026-12-01T20:00:00Z'))).toMatchObject({ problem: expect.stringContaining('not one this server knows') });
    expect(() => setCycle(db, { day: 2 })).toThrow(/timezone/);
    expect(setCycle(db, { timezone: Z }).timezone).toBe(Z);
    await Promise.all(await s.tick());
    expect(runs).toBe(1);
  });

  it('Settings shows when it runs next and how the last month went', () => {
    const db = household();
    setCycle(db, { day: 3, time: '08:00', timezone: Z });
    expect(cycleView(db, 'monthly', at('2026-12-01T00:00:00Z'))).toEqual({ day: 3, time: '08:00', timezone: Z, next: '2026-12-03T07:00:00.000Z' });
    finish(db, claim(db, 'monthly', '2026-12', at('2026-12-03T07:00:00Z'))!, ok, runRow(db), at('2026-12-03T07:05:00Z'));
    expect(cycleView(db, 'monthly', at('2026-12-03T08:00:00Z'))).toMatchObject({ next: '2027-01-03T07:00:00.000Z', last: { period: '2026-12', status: 'done', attempts: 1 } });
  });
});

describe('the monthly refresh', () => {
  const steps = (log: string[], fail: string[] = []) => Object.fromEntries(['mail', 'shares', 'prices', 'plan', 'ai_suggest', 'ai_explain', 'push'].map((s) => [s, async () => { log.push(s); return fail.includes(s) ? { status: 'failed' as const, detail: 'down' } : ok; }]));

  it('every step in order; a failed one does not stop the rest; a retry does only the steps left', async () => {
    const log: string[] = [];
    const done: string[] = [];
    const deadline = new Date(Date.now() + 60_000);
    const first = await monthlyRefresh(steps(log, ['mail', 'prices']), { deadline, step: (s) => done.push(s) });
    expect(first.status).toBe('failed');
    expect(log).toEqual(['mail', 'shares', 'prices', 'plan', 'ai_suggest', 'ai_explain', 'push']);
    expect(done).toEqual(['shares', 'plan', 'ai_suggest', 'ai_explain', 'push']);
    log.length = 0;
    const second = await monthlyRefresh(steps(log), { deadline, done, step: (s) => done.push(s) });
    expect(log).toEqual(['mail', 'prices']);
    expect(second).toMatchObject({ status: 'done' });
  });

  it('a step waits for the same job run by hand, and then runs', async () => {
    const db = household();
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const byHand = startJob(db, 'prices', async () => { await gate; order.push('by hand'); return ok; })!;
    const run = monthlyRefresh({ prices: async () => { order.push('step'); return ok; } }, { deadline: new Date(Date.now() + 60_000) });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    release();
    await Promise.all([byHand.done, run]);
    expect(order).toEqual(['by hand', 'step']);
  });

  it('nothing new starts past the deadline; the price lookup stops at it too', async () => {
    const log: string[] = [];
    const r = await monthlyRefresh(steps(log), { deadline: new Date(Date.now() - 1) });
    expect(log).toEqual([]);
    expect(r).toMatchObject({ status: 'failed', detail: expect.stringContaining('time limit') });
    const db = household();
    let clock = Date.parse('2026-12-01T20:00:00Z');
    const looked: string[] = [];
    const now = new Date().toISOString();
    for (const id of ['b_a', 'b_b', 'b_c']) {
      db.insert(t.book).values({ id, title: id, authorsJson: '[]', audience: 'adult', normKey: id, createdAt: now }).run();
      db.insert(t.candidate).values({ personId: 'p_alex', bookId: id, origin: 'manual', addedAt: now, touchedAt: now }).run();
    }
    const src: PriceSource = { id: 'quillmere', find: async (b) => { looked.push(b.title); return null; } };
    const out = await refreshPrices(db, src, { now: () => new Date(clock), sleep: async (ms) => { clock += ms; }, deadline: new Date(Date.parse('2026-12-01T20:00:05Z')) });
    expect(out).toMatchObject({ status: 'failed', detail: expect.stringContaining('time limit') });
    expect(looked).toHaveLength(2);
  });

  it('the AI\'s steps stop at the deadline: the picks left are explained by the retry, suggestions are never asked twice', async () => {
    const db = household();
    const cfg = loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY });
    let clock = Date.parse('2026-12-01T20:00:00Z');
    const m = fakeModel((r) => { clock += 60_000; return r.job === 'explainPick' ? { why: 'Deepens Markets and value.' } : { suggestions: [] }; });
    const ai = new AiJobs(db, cfg, { model: () => m, now: () => new Date(clock) });
    const until = new Date(clock + 90_000);
    const s = await ai.suggest({ until });
    expect(s).toMatchObject({ status: 'blocked', detail: expect.stringContaining('time limit') });
    expect(m.requests.filter((r) => r.job === 'suggestNext')).toHaveLength(2);
    const now = new Date().toISOString();
    db.insert(t.order).values({ id: 'o_dec', month: '2026-12', status: 'picked', createdAt: now }).run();
    db.insert(t.book).values({ id: 'b_two', title: 'Two', authorsJson: '[]', audience: 'adult', normKey: 'two', createdAt: now }).run();
    db.insert(t.orderLine).values([{ orderId: 'o_dec', bookId: 'b_tide', forPerson: 'p_alex' }, { orderId: 'o_dec', bookId: 'b_two', forPerson: 'p_sam' }]).run();
    // A month other than this one (the household's zone may be ahead of or behind the server's): that month's plan.
    db.update(t.order).set({ month: '2027-01' }).where(eq(t.order.id, 'o_dec')).run();
    const e = await ai.explain({ month: '2027-01', until: new Date(clock + 30_000) });
    expect(e).toMatchObject({ status: 'failed', detail: '1 picks explained; stopped at the time limit' });
    expect(db.select().from(t.orderLine).where(eq(t.orderLine.orderId, 'o_dec')).all().filter((l) => l.why).length).toBe(1);
  });
});

describe('through the app', () => {
  const app = async (clock: { now: Date }, find: PriceSource['find'] = async () => null) => {
    const db = household();
    setCycle(db, { timezone: Z });
    const pushed: string[] = [];
    const byHand: Promise<void>[] = [];
    const push: Egress = {
      get: async () => { throw new Error('no'); }, post: async () => { throw new Error('no'); },
      push: async (url) => { pushed.push(url); return { status: 201, type: '', body: Buffer.alloc(0), url }; },
    };
    let scheduler: Scheduler | undefined;
    const built = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY, PHILOBIBLOS_EGRESS: 'off' }), db, {
      push,
      jobs: { prices: { id: 'quillmere', find }, env: { sleep: async () => {} }, started: (_j, d) => byHand.push(d), schedule: { now: () => clock.now, start: false, onScheduler: (s) => { scheduler = s; } } },
    });
    return { db, pushed, byHand, app: built.app, scheduler: scheduler!, admin: { cookie: sessionCookie(db, 'p_alex'), origin: ORIGIN }, adult: { cookie: sessionCookie(db, 'p_sam'), origin: ORIGIN } };
  };

  it('on the day: the month\'s plan is kept with no one\'s view, every step logged in job_run with its period', async () => {
    const clock = { now: at('2026-12-01T20:00:00Z') };
    const a = await app(clock);
    await Promise.all(await a.scheduler.tick());
    const run = a.db.select().from(t.jobRun).where(eq(t.jobRun.job, 'monthly')).get()!;
    expect(run).toMatchObject({ status: 'done', period: '2026-12' });
    for (const s of ['mail:', 'prices:', 'plan: kept, 1 picks']) expect(run.detail).toContain(s);
    expect(a.db.select().from(t.order).where(eq(t.order.month, '2026-12')).get()).toMatchObject({ status: 'picked' });
    expect(JSON.parse(row(a.db, '2026-12')!.stepsJson)).toEqual(['mail', 'shares', 'prices', 'plan', 'ai_suggest', 'ai_explain', 'push']);
  });

  it('the month is the household\'s: the plan kept and its picks explained for the month in its zone', async () => {
    // 03:00 UTC on 1 December: December in Zurich (the server's PHILOBIBLOS_TZ), still November in New York (the household's).
    const clock = { now: at('2026-12-01T03:00:00Z') };
    const db = household();
    setCycle(db, { day: 1, time: '00:00', timezone: 'America/New_York' });
    let scheduler: Scheduler | undefined;
    const m = fakeModel((r) => (r.job === 'explainPick' ? { why: 'Deepens Markets and value.' } : { suggestions: [] }));
    await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY, PHILOBIBLOS_EGRESS: 'off' }), db, {
      ai: { model: () => m, now: () => clock.now },
      jobs: { env: { sleep: async () => {} }, schedule: { now: () => clock.now, start: false, onScheduler: (s) => { scheduler = s; } } },
    });
    await Promise.all(await scheduler!.tick());
    const nov = db.select().from(t.order).where(eq(t.order.month, '2026-11')).get()!;
    expect(db.select().from(t.orderLine).where(eq(t.orderLine.orderId, nov.id)).all()).toEqual([expect.objectContaining({ why: 'Deepens Markets and value.' })]);
    expect(db.select().from(t.order).where(eq(t.order.month, '2026-12')).get()).toBeUndefined();
  });

  it('the adults hear once a month that the plan is ready: by the scheduled run, not by hand, not by its retry', async () => {
    const clock = { now: at('2026-12-01T20:00:00Z') };
    let fail = true;
    const a = await app(clock, async () => { if (fail) throw new Error('down'); return null; });
    const b = createECDH('prime256v1'); b.generateKeys();
    const keys = { p256dh: b.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') };
    subscribe(a.db, 'p_sam', { endpoint: 'https://fcm.googleapis.com/fcm/send/sam', keys });
    await Promise.all(await a.scheduler.tick());
    expect(a.pushed).toEqual(['https://fcm.googleapis.com/fcm/send/sam']);
    expect(row(a.db, '2026-12')).toMatchObject({ status: 'retry' });
    fail = false;
    clock.now = new Date(clock.now.getTime() + backoff(1));
    await Promise.all(await a.scheduler.tick());
    expect(row(a.db, '2026-12')).toMatchObject({ status: 'done' });
    const r = await a.app.inject({ method: 'POST', url: '/api/jobs/monthly/run', headers: a.admin });
    expect(r.statusCode).toBe(202);
    await Promise.all(a.byHand);
    expect(a.db.select().from(t.jobRun).where(eq(t.jobRun.id, r.json().id)).get()).toMatchObject({ status: 'done', detail: expect.stringContaining('ai_explain') });
    expect(a.pushed).toHaveLength(1);
  });

  it('clocks a few minutes off, an hour back, a month back: each month runs once and the adults hear at most once a month', async () => {
    const clock = { now: at('2026-12-01T19:17:00Z') };
    const a = await app(clock);
    setCycle(a.db, { day: 1, time: '20:17', timezone: Z });
    const b = createECDH('prime256v1'); b.generateKeys();
    subscribe(a.db, 'p_sam', { endpoint: 'https://fcm.googleapis.com/fcm/send/sam', keys: { p256dh: b.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') } });
    const tick = async (iso: string) => { clock.now = at(iso); await Promise.all(await a.scheduler.tick()); };
    // A: ten minutes ahead while it runs (the clock says 19:17Z at 19:07Z), then corrected and ticking from 19:13Z.
    await tick('2026-12-01T19:17:00Z');
    clock.now = at('2026-12-01T19:22:00Z');
    for (let m = 13; m < 40; m++) await tick(`2026-12-01T19:${m}:00Z`);
    // An hour back, then right again.
    await tick('2026-12-01T18:45:00Z');
    await tick('2026-12-01T19:45:00Z');
    expect(a.db.select({ p: t.jobRun.period }).from(t.jobRun).where(eq(t.jobRun.job, 'monthly')).all()).toEqual([{ p: '2026-12' }]);
    expect(a.pushed).toHaveLength(1);
    // A month back for one tick (November never ran: it runs, once), then right: December's other steps run again,
    // but its push and its AI do not.
    await tick('2026-11-20T12:00:00Z');
    await tick('2026-12-01T20:00:00Z');
    await tick('2026-12-01T21:00:00Z');
    const runs = a.db.select({ p: t.jobRun.period, d: t.jobRun.detail }).from(t.jobRun).where(eq(t.jobRun.job, 'monthly')).all();
    expect(runs.map((r) => r.p)).toEqual(['2026-12', '2026-11', '2026-12']);
    expect(runs[2]!.d).not.toMatch(/push:|ai_suggest:|ai_explain:/);
    expect(a.pushed).toHaveLength(2);
  });

  it('a step that failed is done again by the retry, and only it', async () => {
    const clock = { now: at('2026-12-01T20:00:00Z') };
    let calls = 0;
    const a = await app(clock, async () => { calls++; throw new Error('the bookshop is down'); });
    await Promise.all(await a.scheduler.tick());
    expect(row(a.db, '2026-12')).toMatchObject({ status: 'retry', attempts: 1 });
    // The plan was kept; delete it: the retry must not keep it again (its step is done).
    a.db.delete(t.orderLine).run();
    a.db.delete(t.order).where(eq(t.order.month, '2026-12')).run();
    clock.now = new Date(clock.now.getTime() + backoff(1));
    const before = calls;
    await Promise.all(await a.scheduler.tick());
    expect(calls).toBeGreaterThan(before);
    expect(a.db.select().from(t.order).where(eq(t.order.month, '2026-12')).get()).toBeUndefined();
    expect(a.db.select({ p: t.jobRun.period, s: t.jobRun.status }).from(t.jobRun).where(eq(t.jobRun.job, 'monthly')).all()).toEqual([{ p: '2026-12', s: 'failed' }, { p: '2026-12', s: 'failed' }]);
  });

  it('by hand: admins only, 409 next to a scheduled run, no claim taken', async () => {
    const clock = { now: at('2026-12-01T20:00:00Z') };
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const a = await app(clock, async () => { await gate; return null; });
    expect((await a.app.inject({ method: 'POST', url: '/api/jobs/monthly/run', headers: a.adult })).statusCode).toBe(403);
    const runs = await a.scheduler.tick();
    expect((await a.app.inject({ method: 'POST', url: '/api/jobs/monthly/run', headers: a.admin })).statusCode).toBe(409);
    release();
    await Promise.all(runs);
    const r = await a.app.inject({ method: 'POST', url: '/api/jobs/monthly/run', headers: a.admin });
    expect(r.statusCode).toBe(202);
    await new Promise((ok) => setTimeout(ok, 50));
    expect(a.db.select().from(t.jobRun).where(eq(t.jobRun.id, r.json().id)).get()).toMatchObject({ period: null });
    expect(a.db.select().from(t.jobPeriod).all()).toHaveLength(1);
  });

  it('one time zone, the household\'s: at 00:30 on the 1st in Zurich with PHILOBIBLOS_TZ in New York, the plan, the push, /month and "add to this month" are all December', async () => {
    vi.useFakeTimers({ now: at('2026-11-30T23:45:00Z'), toFake: ['Date'] });
    try {
      const db = household();
      setCycle(db, { day: 1, time: '00:30', timezone: Z });
      let scheduler: Scheduler | undefined;
      const pushed: string[] = [];
      const push: Egress = { get: async () => { throw new Error('no'); }, post: async () => { throw new Error('no'); }, push: async (url) => { pushed.push(url); return { status: 201, type: '', body: Buffer.alloc(0), url }; } };
      const { app: built } = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY, PHILOBIBLOS_EGRESS: 'off', PHILOBIBLOS_TZ: 'America/New_York' }), db, {
        push, jobs: { env: { sleep: async () => {} }, schedule: { start: false, onScheduler: (x) => { scheduler = x; } } },
      });
      const b = createECDH('prime256v1'); b.generateKeys();
      subscribe(db, 'p_sam', { endpoint: 'https://fcm.googleapis.com/fcm/send/sam', keys: { p256dh: b.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') } });
      await Promise.all(await scheduler!.tick());
      expect(row(db, '2026-12')).toMatchObject({ status: 'done' });
      expect(pushed).toHaveLength(1);
      expect(db.select().from(t.order).where(eq(t.order.month, '2026-12')).get()).toMatchObject({ status: 'picked' });
      const h = { cookie: sessionCookie(db, 'p_alex'), origin: ORIGIN };
      expect((await built.inject({ url: '/api/month', headers: h })).json().month).toBe('2026-12');
      const now = new Date().toISOString();
      db.insert(t.book).values({ id: 'b_more', title: 'More', authorsJson: '[]', audience: 'adult', normKey: 'more', createdAt: now }).run();
      db.insert(t.candidate).values({ personId: 'p_alex', bookId: 'b_more', origin: 'manual', addedAt: now, touchedAt: now }).run();
      const r = await built.inject({ method: 'POST', url: '/api/backlog/bulk', headers: { ...h, 'content-type': 'application/json' }, payload: JSON.stringify({ ids: ['p_alex.b_more'], action: 'add_to_month' }) });
      expect(r.statusCode, r.body).toBe(200);
      const dec = db.select().from(t.order).where(eq(t.order.month, '2026-12')).get()!;
      expect(db.select().from(t.orderLine).where(eq(t.orderLine.orderId, dec.id)).all().map((l) => l.bookId)).toContain('b_more');
      expect(db.select().from(t.order).where(eq(t.order.month, '2026-11')).get()).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('PHILOBIBLOS_TZ is only the zone the household starts with: once its settings exist, it is never read again', async () => {
    // household() made the settings row (the example shop's currency); a first start makes it, so it starts without.
    const db = household();
    db.delete(t.householdSettings).run();
    const start = (tz: string) => buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY, PHILOBIBLOS_EGRESS: 'off', PHILOBIBLOS_TZ: tz }), db, { jobs: { schedule: { start: false } } });
    await start('Asia/Tokyo');
    expect(cycleView(db, 'monthly').timezone).toBe('Asia/Tokyo');
    await start('America/New_York');
    expect(cycleView(db, 'monthly').timezone).toBe('Asia/Tokyo');
    expect(() => loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_TZ: 'Mars/Olympus' })).toThrow(/PHILOBIBLOS_TZ/);
    // The row itself is never made with a zone this server does not know, whoever makes it.
    const fresh = household();
    fresh.delete(t.householdSettings).run();
    expect(() => initHousehold(fresh, 'Mars/Olympus')).toThrow(/PHILOBIBLOS_TZ/);
    expect(fresh.select().from(t.householdSettings).all()).toEqual([]);
  });

  it('Settings: the cycle is the household\'s, admins change it', async () => {
    const clock = { now: at('2026-12-01T20:00:00Z') };
    const a = await app(clock);
    const patch = (h: Record<string, string>, cycle: unknown) => a.app.inject({ method: 'PATCH', url: '/api/settings', headers: { ...h, 'content-type': 'application/json' }, payload: JSON.stringify({ cycle }) });
    expect((await patch(a.adult, { day: 2 })).statusCode).toBe(403);
    expect((await patch(a.admin, { day: 31 })).statusCode).toBe(400);
    expect((await patch(a.admin, { day: 2, time: '07:30', timezone: 'America/New_York' })).statusCode).toBe(200);
    const s = (await a.app.inject({ url: '/api/settings', headers: { cookie: a.adult.cookie } })).json();
    expect(s.cycle).toMatchObject({ day: 2, time: '07:30', timezone: 'America/New_York', next: expect.any(String) });
  });
});
