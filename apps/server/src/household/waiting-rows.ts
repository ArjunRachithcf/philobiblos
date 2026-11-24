// The rows of people who wait (ADR 0011): how many may wait, when a request lapses, and how a waiting person goes
// (a decline, a revoked link, a lapse). Shared by household/waiting.ts and household/join-links.ts.
import { and, count, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../db/open';
import * as t from '../db/schema';

/** At most `max` people wait in a household; a request unanswered for `lapseDays` lapses (both modes). */
export const WAITING = { max: 10, lapseDays: 7 } as const;

const cutoff = (now: Date) => new Date(now.getTime() - WAITING.lapseDays * 86_400_000).toISOString();

/** A waiting person whose request is older than WAITING.lapseDays (a row without a time lapses too). */
export const hasLapsed = (p: { state: string; arrivedAt: string | null }, now = new Date()) =>
  p.state === 'waiting' && (p.arrivedAt === null || p.arrivedAt < cutoff(now));

/** Waiting people go: their passkeys, sessions, links and request with them. Members are never touched. */
export function dropWaiting(db: Db, ids: string[]): number {
  if (!ids.length) return 0;
  db.delete(t.session).where(inArray(t.session.personId, ids)).run();
  db.delete(t.passkey).where(inArray(t.passkey.personId, ids)).run();
  db.delete(t.invite).where(inArray(t.invite.personId, ids)).run();
  return db.delete(t.person).where(and(inArray(t.person.id, ids), eq(t.person.state, 'waiting'))).run().changes;
}

/**
 * Requests older than WAITING.lapseDays go, from join links and from Homeward's edge alike (a HomersLab person who
 * comes again after that waits again, as a new request). A plain read when there is nothing to do.
 */
export function lapseWaiting(db: Db, now = new Date()): number {
  if (!lapsedIds(db, now).length) return 0;
  return db.transaction((tx) => lapseIn(tx as unknown as Db, now), { behavior: 'immediate' });
}

/** lapseWaiting, inside a transaction the caller holds. */
export function lapseIn(tx: Db, now = new Date()): number {
  return dropWaiting(tx, lapsedIds(tx, now));
}

const lapsedIds = (db: Db, now: Date) => db.select({ id: t.person.id }).from(t.person)
  .where(and(eq(t.person.state, 'waiting'), or(isNull(t.person.arrivedAt), lt(t.person.arrivedAt, cutoff(now))))).all().map((r) => r.id);

/** How many wait now, inside a transaction the caller holds (lapsed requests gone first). */
export function waitingCount(tx: Db, now = new Date()): number {
  lapseIn(tx, now);
  return waitingNow(tx);
}

/** How many wait, as the rows are (the caller lapsed old requests already). */
export const waitingNow = (db: Db) => db.select({ n: count() }).from(t.person).where(eq(t.person.state, 'waiting')).get()?.n ?? 0;
