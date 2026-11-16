// The scheduler and the monthly refresh (spec §5 step 1, shelf#8 h): a period runs once whatever restarts, overlaps,
// clocks and time zones do; failures are tried again with a backoff, then given up; a retry does only the steps left;
// nothing new starts past the run's deadline. The clock is a fake one throughout; no request leaves (egress off).
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { fakeModel } from '@shelf/ai';
import { AiJobs } from '../src/ai/jobs';
import { buildApp } from '../src/app';
import type { PriceSource } from '../src/books/prices';
import { loadConfig } from '../src/config';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { refreshPrices } from '../src/jobs/books';
import { startJob } from '../src/jobs/run';
import { SCHEDULE, Scheduler, backoff, claim, cycleView, dueAt, finish, releaseInterrupted, setCycle, stepDone, zonedInstant, type Cycle } from '../src/jobs/schedule';
import { monthlyRefresh } from '../src/month/refresh';
import { POST_TIMEOUT_MAX_MS } from '../src/net/egress';
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

  it('a clock set back never runs an earlier month, even one that never ran', () => {
    const db = household();
    const c = claim(db, 'monthly', '2026-12', at('2026-12-01T20:00:00Z'))!;
    finish(db, c, ok, runRow(db));
    expect(claim(db, 'monthly', '2026-11', at('2026-11-20T20:00:00Z'))).toBeNull();
    expect(row(db, '2026-11')).toBeUndefined();
    // The next month runs as usual.
    expect(claim(db, 'monthly', '2027-01', at('2027-01-01T20:00:00Z'))).not.toBeNull();
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
    finish(db, c, { status: 'blocked', detail: 'no mailbox' }, runRow(db));
    expect(row(db, '2026-12')).toMatchObject({ status: 'done' });
  });

  it('after a restart, a claim the old server held is free at once and keeps its finished steps', () => {
    const db = household();
    const c = claim(db, 'monthly', '2026-12', at('2026-12-01T20:00:00Z'))!;
    stepDone(db, c, 'mail');
    stepDone(db, c, 'shares');
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
    const clock = { now: at('2026-12-01T20:00:00Z') };
    const s = sched(db, clock, async () => ok);
    await Promise.all(await s.tick());
    clock.now = at('2027-02-10T08:00:00Z');
    await Promise.all(await s.tick());
    expect(db.select({ p: t.jobPeriod.period }).from(t.jobPeriod).all().map((r) => r.p)).toEqual(['2026-12', '2027-02']);
  });

  it('never next to a run of the same job, by hand or not', async () => {
    const db = household();
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

  it('Settings shows when it runs next and how the last month went', () => {
    const db = household();
    setCycle(db, { day: 3, time: '08:00', timezone: Z });
    expect(cycleView(db, 'monthly', at('2026-12-01T00:00:00Z'))).toEqual({ day: 3, time: '08:00', timezone: Z, next: '2026-12-03T07:00:00.000Z' });
    finish(db, claim(db, 'monthly', '2026-12', at('2026-12-03T07:00:00Z'))!, ok, runRow(db));
    expect(cycleView(db, 'monthly', at('2026-12-03T08:00:00Z'))).toMatchObject({ next: '2027-01-03T07:00:00.000Z', last: { period: '2026-12', status: 'done', attempts: 1 } });
  });
});

describe('the monthly refresh', () => {
  const steps = (log: string[], fail: string[] = []) => Object.fromEntries(['mail', 'shares', 'prices', 'plan', 'ai_suggest', 'ai_explain'].map((s) => [s, async () => { log.push(s); return fail.includes(s) ? { status: 'failed' as const, detail: 'down' } : ok; }]));

  it('every step in order; a failed one does not stop the rest; a retry does only the steps left', async () => {
    const log: string[] = [];
    const done: string[] = [];
    const deadline = new Date(Date.now() + 60_000);
    const first = await monthlyRefresh(steps(log, ['mail', 'prices']), { deadline, step: (s) => done.push(s) });
    expect(first.status).toBe('failed');
    expect(log).toEqual(['mail', 'shares', 'prices', 'plan', 'ai_suggest', 'ai_explain']);
    expect(done).toEqual(['shares', 'plan', 'ai_suggest', 'ai_explain']);
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
    const src: PriceSource = { id: 'orellfuessli', find: async (b) => { looked.push(b.title); return null; } };
    const out = await refreshPrices(db, src, { now: () => new Date(clock), sleep: async (ms) => { clock += ms; }, deadline: new Date(Date.parse('2026-12-01T20:00:05Z')) });
    expect(out).toMatchObject({ status: 'failed', detail: expect.stringContaining('time limit') });
    expect(looked).toHaveLength(2);
  });

  it('the AI\'s steps stop at the deadline: the picks left are explained by the retry, suggestions are never asked twice', async () => {
    const db = household();
    const cfg = loadConfig({ SHELF_MODE: 'standalone', SHELF_DATA_DIR: '/nonexistent', SHELF_SEALING_KEY: TEST_SEALING_KEY });
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
    let scheduler: Scheduler | undefined;
    const built = await buildApp(loadConfig({ SHELF_MODE: 'standalone', SHELF_DATA_DIR: '/nonexistent', SHELF_SEALING_KEY: TEST_SEALING_KEY, SHELF_EGRESS: 'off' }), db, {
      jobs: { prices: { id: 'orellfuessli', find }, env: { sleep: async () => {} }, schedule: { now: () => clock.now, start: false, onScheduler: (s) => { scheduler = s; } } },
    });
    return { db, app: built.app, scheduler: scheduler!, admin: { cookie: sessionCookie(db, 'p_alex'), origin: ORIGIN }, adult: { cookie: sessionCookie(db, 'p_sam'), origin: ORIGIN } };
  };

  it('on the day: the month\'s plan is kept with no one\'s view, every step logged in job_run with its period', async () => {
    const clock = { now: at('2026-12-01T20:00:00Z') };
    const a = await app(clock);
    await Promise.all(await a.scheduler.tick());
    const run = a.db.select().from(t.jobRun).where(eq(t.jobRun.job, 'monthly')).get()!;
    expect(run).toMatchObject({ status: 'done', period: '2026-12' });
    for (const s of ['mail:', 'prices:', 'plan: kept, 1 picks']) expect(run.detail).toContain(s);
    expect(a.db.select().from(t.order).where(eq(t.order.month, '2026-12')).get()).toMatchObject({ status: 'picked' });
    expect(JSON.parse(row(a.db, '2026-12')!.stepsJson)).toEqual(['mail', 'shares', 'prices', 'plan', 'ai_suggest', 'ai_explain']);
  });

  it('the month is the household\'s: the plan kept and its picks explained for the month in its zone', async () => {
    // 03:00 UTC on 1 December: December in Zurich (the server's SHELF_TZ), still November in New York (the household's).
    const clock = { now: at('2026-12-01T03:00:00Z') };
    const db = household();
    setCycle(db, { day: 1, time: '00:00', timezone: 'America/New_York' });
    let scheduler: Scheduler | undefined;
    const m = fakeModel((r) => (r.job === 'explainPick' ? { why: 'Deepens Markets and value.' } : { suggestions: [] }));
    await buildApp(loadConfig({ SHELF_MODE: 'standalone', SHELF_DATA_DIR: '/nonexistent', SHELF_SEALING_KEY: TEST_SEALING_KEY, SHELF_EGRESS: 'off' }), db, {
      ai: { model: () => m, now: () => clock.now },
      jobs: { env: { sleep: async () => {} }, schedule: { now: () => clock.now, start: false, onScheduler: (s) => { scheduler = s; } } },
    });
    await Promise.all(await scheduler!.tick());
    const nov = db.select().from(t.order).where(eq(t.order.month, '2026-11')).get()!;
    expect(db.select().from(t.orderLine).where(eq(t.orderLine.orderId, nov.id)).all()).toEqual([expect.objectContaining({ why: 'Deepens Markets and value.' })]);
    expect(db.select().from(t.order).where(eq(t.order.month, '2026-12')).get()).toBeUndefined();
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
