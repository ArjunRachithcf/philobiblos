// The household's AI spend with Claude, across every run (shares, tags, suggestions, explanations, whoever started
// them): at most `ai_daily_tokens` tokens in any 24 hours (Settings, admins; 200,000 by default).
//
// Before each call ai/run.ts reserves the most that call can cost: its prompt's UTF-8 bytes (a token is at least one
// byte), a bound per image (Claude scales an image to about 1,600 tokens at most) and its output limit. A call that
// would go past the allowance, counting what the last 24 hours spent and what calls in flight hold reserved, is not
// made: its job stops as blocked. Afterwards the reservation is replaced by what the provider counted (ai_run.tokens),
// or by the bound when the call failed without a count, so the sum stays within the allowance however many runs start
// at once.
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/open';
import * as t from '../db/schema';

export const SPEND = { windowMs: 24 * 3600_000, perImage: 1_800, overhead: 64 } as const;
/** The allowance Settings takes: from 10,000 tokens a day to 20 million. */
export const DAILY_TOKENS = { default: 200_000, min: 10_000, max: 20_000_000 } as const;

/** Tokens Claude counted in the last 24 hours, every run together. */
export function spentToday(db: Db, now = new Date()): number {
  const since = new Date(now.getTime() - SPEND.windowMs).toISOString();
  return db.select({ n: sql<number>`coalesce(sum(${t.aiRun.tokens}), 0)` }).from(t.aiRun).where(and(eq(t.aiRun.provider, 'claude'), gte(t.aiRun.startedAt, since))).get()?.n ?? 0;
}
