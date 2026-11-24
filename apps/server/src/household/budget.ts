// The household's monthly budget (spec §5): one shared range for the month's order, set by admins. There is no
// rollover: what a month leaves unspent is not added to the next (decided). A one-month override is This month's
// (M2, month_override).
import { eq } from 'drizzle-orm';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { amountProblem, getMoney } from './money';

export interface Budget { min: number; max: number }

export class BudgetError extends Error {}

export function getBudget(db: Db): Budget {
  const row = db.select().from(t.householdSettings).where(eq(t.householdSettings.id, 1)).get();
  return { min: row?.budgetMinC ?? 10000, max: row?.budgetMaxC ?? 15000 };
}

export function setBudget(db: Db, body: unknown): Budget {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BudgetError('budget: { min, max } in hundredths of the household currency');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'min' && k !== 'max') throw new BudgetError(`budget: unknown field ${k}`);
  const cur = getBudget(db);
  const next = { min: b.min ?? cur.min, max: b.max ?? cur.max };
  for (const [k, v] of Object.entries(next)) {
    const problem = amountProblem(v, getMoney(db).currency);
    if (problem) throw new BudgetError(`budget.${k}: ${problem}`);
  }
  if ((next.min as number) > (next.max as number)) throw new BudgetError('budget: the minimum is above the maximum');
  const row = { id: 1, budgetMinC: next.min as number, budgetMaxC: next.max as number };
  db.insert(t.householdSettings).values(row).onConflictDoUpdate({ target: t.householdSettings.id, set: { budgetMinC: row.budgetMinC, budgetMaxC: row.budgetMaxC } }).run();
  return { min: row.budgetMinC, max: row.budgetMaxC };
}
