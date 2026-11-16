// The monthly refresh (spec §5 step 1, shelf#8 h): new invoices → copies (the mail), new shares read, prices refreshed
// for the candidates, the month's plan kept (scored by packages/scoring as it is made), the AI's suggestions and its one
// line of why for the picks, then a push to the adults (push/push.ts: "this month's plan is ready", the scheduled run
// only, once a period). Run by the scheduler on the household's day (jobs/schedule.ts), or by an admin by hand.
//
// - No request identity: each step is a job that runs for the household, as by hand, with what that job needs and no
//   more (the mail its mailbox, the prices the book sites' client, the AI its provider's own client, the plan no one's
//   view: plan.ts keepPlan).
// - Each step in its own job's slot (jobs/run.ts inSlot): never next to the same job run by hand.
// - A step that fails does not stop the others; the run then fails, and its retry does only the steps not done.
// - Nothing new starts past the deadline; the long steps check it inside their loops too.
import type { Outcome } from '../jobs/books';
import { inSlot } from '../jobs/run';

export const MONTHLY_STEPS = ['mail', 'shares', 'prices', 'plan', 'ai_suggest', 'ai_explain', 'push'] as const;
export type MonthlyStep = (typeof MONTHLY_STEPS)[number];

/** The steps this server can do; one it lacks (no AI, no media worker) is nothing to do. */
export type MonthlyWork = Partial<Record<MonthlyStep, () => Promise<Outcome>>>;

export interface RefreshControl {
  deadline: Date;
  /** Steps a run before this one finished. */
  done?: readonly string[];
  step?: (s: MonthlyStep) => void;
  now?: () => Date;
}

export async function monthlyRefresh(work: MonthlyWork, ctl: RefreshControl): Promise<Outcome> {
  const now = ctl.now ?? (() => new Date());
  const parts: string[] = [];
  let failed = false;
  for (const s of MONTHLY_STEPS) {
    if (ctl.done?.includes(s)) continue;
    const w = work[s];
    if (!w) { ctl.step?.(s); continue; }
    if (now() >= ctl.deadline) { failed = true; parts.push(`${s}: not started (the run's time limit)`); continue; }
    let r: Outcome;
    try { r = await inSlot(s, w); } catch { r = { status: 'failed', detail: 'stopped by an unexpected error' }; }
    parts.push(`${s}: ${r.detail.slice(0, 160)}`);
    if (r.status === 'failed') failed = true;
    else ctl.step?.(s);
  }
  return { status: failed ? 'failed' : 'done', detail: parts.join('; ') || 'nothing left to do' };
}
