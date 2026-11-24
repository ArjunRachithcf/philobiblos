// People with a state (ADR 0011, philobiblos#34 slice 1): waiting for an admin's approval, or a member.
//
// - A waiting person is an adult without a handle. They count nowhere (household() and getPerson() know only members),
//   see nothing (the auth hook answers every route 403 "waiting"), and nothing they add is stored.
// - An admin approves (as an adult by default, as an admin by their choice) or declines, each with a fresh sign-in
//   (auth/hook.ts requireFreshSignIn). A decline deletes the person, their passkeys and sessions in one transaction.
// - At most WAITING.max people wait: a full list stores no one new (the newcomer still gets the one "waiting" answer).
// - A request unanswered for WAITING.lapseDays lapses (household/waiting-rows.ts), from a join link or the edge alike.
// - Under HomersLab (arrive): a person the edge sends for the first time waits, except a Homeward admin, who is a
//   Philobiblos admin at once. After that the Homeward role is the ceiling: a Philobiblos role above it is lowered on the
//   request that shows it; a Homeward promotion never raises one by itself. The one exception keeps a household from
//   locking itself out: while no Philobiblos admin is left, a Homeward admin who arrives is made one.
import { and, count, desc, eq, max } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import type { Identity, Role } from '../identity';
import { HouseholdError, becameKid, suggestHandle, type Person } from './people';
import { WAITING, dropWaiting, hasLapsed, lapseIn, lapseWaiting, waitingCount } from './waiting-rows';

export { WAITING, lapseWaiting };

/** How often the edge's last sight of a person is written (person.seen_at): at most once this long. */
export const SEEN_EVERY_MS = 3_600_000;

const RANK: Record<Role, number> = { kid: 0, adult: 1, admin: 2 };
/** `role`, lowered to `ceiling` when it is above it. */
export const capped = (role: Role, ceiling: Role): Role => (RANK[role] > RANK[ceiling] ? ceiling : role);

/** Any person by id, waiting or not (the auth hook and the decisions here; everything else uses getPerson). */
export function anyPerson(db: Db, id: string): Person | undefined {
  return db.select().from(t.person).where(eq(t.person.id, id)).get();
}

export function waitingPeople(db: Db, now = new Date()): Person[] {
  lapseWaiting(db, now);
  return db.select().from(t.person).where(eq(t.person.state, 'waiting')).orderBy(desc(t.person.arrivedAt), desc(t.person.id)).all();
}

/** How many wait, and when the latest came (the Inbox's item). */
export function waitingSummary(db: Db, now = new Date()): { n: number; latest: string | null } {
  lapseWaiting(db, now);
  const r = db.select({ n: count(), latest: max(t.person.arrivedAt) }).from(t.person).where(eq(t.person.state, 'waiting')).get();
  return { n: r?.n ?? 0, latest: r?.latest ?? null };
}
const activeAdmins = (db: Db) => db.select({ n: count() }).from(t.person).where(and(eq(t.person.state, 'active'), eq(t.person.role, 'admin'))).get()?.n ?? 0;

/** A waiting person, or 404: the same answer for an unknown id, a member's and a lapsed request. */
function waiter(db: Db, id: string): Person {
  lapseIn(db);
  const p = anyPerson(db, id);
  if (!p || p.state !== 'waiting') throw new HouseholdError(404, 'no one waits with that id');
  return p;
}

/**
 * Lets a waiting person in as `role` (adult or admin). Under HomersLab the role may not be above their Homeward role
 * (`p.ceiling`, set at each request): 409. The fresh sign-in is the route's to check.
 */
export function approve(db: Db, id: string, role: 'adult' | 'admin'): Person {
  return db.transaction((tx) => {
    const p = waiter(tx as unknown as Db, id);
    if (p.ceiling && capped(role, p.ceiling) !== role) throw new HouseholdError(409, 'their Homeward role is lower than that');
    tx.update(t.person).set({ state: 'active', role, handle: suggestHandle(tx as unknown as Db, p.name) }).where(eq(t.person.id, id)).run();
    // What their request said was for the decision only.
    tx.delete(t.joinRequest).where(eq(t.joinRequest.personId, id)).run();
    return anyPerson(tx as unknown as Db, id)!;
  }, { behavior: 'immediate' });
}

/** Declines a waiting person: their row, passkeys, sessions and request go together. */
export function decline(db: Db, id: string): void {
  db.transaction((tx) => {
    waiter(tx as unknown as Db, id);
    dropWaiting(tx as unknown as Db, [id]);
  }, { behavior: 'immediate' });
}

export type Arrival =
  | { kind: 'member'; person: Person }
  /** `joined`: a new waiting person was stored just now (the admins are told). `person` null: the list was full. */
  | { kind: 'waiting'; person: Person | null; joined: boolean }
  | { kind: 'refused' };

/**
 * Under HomersLab: the person the edge names, with the role it sends (the ceiling), on each request. See the top of
 * this file for the rules.
 */
export function arrive(db: Db, id: Identity & { role: Role }, now = new Date()): Arrival {
  // Most requests change nothing: a plain read answers them, and only a change takes the write lock.
  const known = db.select().from(t.person).where(eq(t.person.externalId, id.externalId)).get();
  const seen = now.toISOString();
  if (known && (id.name ?? known.name) === known.name && known.ceiling === id.role && id.role !== 'kid' && !hasLapsed(known, now)) {
    if (known.state === 'waiting' && !(id.role === 'admin' && activeAdmins(db) === 0)) return { kind: 'waiting', person: known, joined: false };
    if (known.state === 'active' && capped(known.role, id.role) === known.role && !(id.role === 'admin' && known.role !== 'admin' && activeAdmins(db) === 0)) {
      if (known.role === 'kid') return { kind: 'refused' };
      // The edge's last sight of them, to the hour: `join` pushes go only to admins it still sends (push/push.ts).
      if (!known.seenAt || now.getTime() - new Date(known.seenAt).getTime() >= SEEN_EVERY_MS) {
        db.update(t.person).set({ seenAt: seen }).where(eq(t.person.id, known.id)).run();
        return { kind: 'member', person: { ...known, seenAt: seen } };
      }
      return { kind: 'member', person: known };
    }
  }
  return db.transaction((tx0): Arrival => {
    const tx = tx0 as unknown as Db;
    // A request older than WAITING.lapseDays lapses first: the person then arrives anew.
    lapseIn(tx, now);
    const existing = tx.select().from(t.person).where(eq(t.person.externalId, id.externalId)).get();
    const name = id.name ?? existing?.name ?? 'Someone';
    if (!existing) {
      // A kid never arrives by themselves: nothing is stored.
      if (id.role === 'kid') return { kind: 'refused' };
      if (id.role === 'admin') {
        const p = { id: ulid(), externalId: id.externalId, name, role: 'admin' as const, handle: suggestHandle(tx, name), state: 'active' as const, ceiling: id.role, arrivedAt: seen, seenAt: seen, settingsJson: '{}' };
        tx.insert(t.person).values(p).run();
        return { kind: 'member', person: anyPerson(tx, p.id)! };
      }
      if (waitingCount(tx, now) >= WAITING.max) return { kind: 'waiting', person: null, joined: false };
      const p = { id: ulid(), externalId: id.externalId, name, role: 'adult' as const, handle: null, state: 'waiting' as const, ceiling: id.role, arrivedAt: now.toISOString(), settingsJson: '{}' };
      tx.insert(t.person).values(p).run();
      return { kind: 'waiting', person: anyPerson(tx, p.id)!, joined: true };
    }
    const lockedOut = id.role === 'admin' && activeAdmins(tx) === 0;
    if (existing.state === 'waiting') {
      if (id.role === 'kid') {
        // Homeward made them a kid while they waited: a kid never waits (nor signs in); the request goes.
        tx.delete(t.person).where(eq(t.person.id, existing.id)).run();
        return { kind: 'refused' };
      }
      if (lockedOut) {
        tx.update(t.person).set({ state: 'active', role: 'admin', handle: suggestHandle(tx, name), name, ceiling: id.role, seenAt: seen }).where(eq(t.person.id, existing.id)).run();
        return { kind: 'member', person: anyPerson(tx, existing.id)! };
      }
      if (existing.name !== name || existing.ceiling !== id.role) tx.update(t.person).set({ name, ceiling: id.role }).where(eq(t.person.id, existing.id)).run();
      return { kind: 'waiting', person: anyPerson(tx, existing.id)!, joined: false };
    }
    const role = lockedOut ? 'admin' : capped(existing.role, id.role);
    if (role !== existing.role || name !== existing.name || existing.ceiling !== id.role || existing.seenAt !== seen) {
      tx.update(t.person).set({ role, name, ceiling: id.role, seenAt: seen, birthYear: role === 'kid' ? existing.birthYear : null }).where(eq(t.person.id, existing.id)).run();
      // A demotion seen: admin-only pushes (`join`) stop by themselves: they go to the people who are admins when one
      // is sent (push/push.ts joinNotifier), and a device is not tied to a kind. (Under HomersLab there are no invites
      // or join links to take along: those routes answer 404 there.)
      if (role === 'kid') becameKid(tx, existing.id);
    }
    const person = anyPerson(tx, existing.id)!;
    return person.role === 'kid' ? { kind: 'refused' } : { kind: 'member', person };
  }, { behavior: 'immediate' });
}
