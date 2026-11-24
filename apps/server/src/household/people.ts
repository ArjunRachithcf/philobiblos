// The household (ADR 0001): people, their roles and, for kids, birth years. Standalone keeps them here; under
// HomersLab they arrive with each request from the proxy (identity.ts) and are kept in step.
import { and, count, eq, isNull, ne } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { components } from '@philobiblos/contracts/openapi';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { purgeTakeawayRuns } from '../library/ai-context';
import type { Role } from '../identity';
import { revokeJoinLinksBy } from './join-links';

export type Person = typeof t.person.$inferSelect;
export type PersonView = components['schemas']['Person'];

export function ageBand(birthYear: number | null, now = new Date()): PersonView['ageBand'] {
  if (birthYear == null) return null;
  const age = now.getUTCFullYear() - birthYear;
  if (age < 0) return null;
  if (age <= 2) return '0-2';
  if (age <= 5) return '3-5';
  if (age <= 8) return '6-8';
  if (age <= 12) return '9-12';
  return null;
}

export function view(db: Db, p: Person): PersonView {
  const keys = db.select({ n: count() }).from(t.passkey).where(eq(t.passkey.personId, p.id)).get()?.n ?? 0;
  return {
    id: p.id, name: p.name, role: p.role, handle: p.handle,
    birthYear: p.role === 'kid' ? p.birthYear : null,
    ageBand: p.role === 'kid' ? ageBand(p.birthYear) : null,
    signsIn: keys > 0,
  };
}

/**
 * view() plus what only an admin sees (the household list of /me, for an admin caller only): whether a join link's rules
 * let them in, when, and whose link (the admin's name; null once they are gone).
 */
export function adminView(db: Db, p: Person): PersonView {
  const by = p.admittedBy ? db.select({ name: t.person.name }).from(t.person).where(eq(t.person.id, p.admittedBy)).get()?.name ?? null : null;
  return { ...view(db, p), letInByLink: p.admittedLink ? { linkId: p.admittedLink, by, at: p.arrivedAt } : null };
}

/** The household's members (a waiting person is not one: household/waiting.ts). */
export function household(db: Db): Person[] {
  return db.select().from(t.person).where(eq(t.person.state, 'active')).all().sort((a, b) => rank(a.role) - rank(b.role) || a.name.localeCompare(b.name));
}
const rank = (r: Role) => ({ admin: 0, adult: 1, kid: 2 })[r];

/** A member by id; a waiting person is no one here (household/waiting.ts anyPerson finds them). */
export function getPerson(db: Db, id: string): Person | undefined {
  return db.select().from(t.person).where(and(eq(t.person.id, id), eq(t.person.state, 'active'))).get();
}

/**
 * Who may change a person's backlog and picks (the one rule, used by the Backlog and This month): yourself, and the
 * kids (adults act for them); another adult's are theirs. 'none': no such person.
 */
export function actsFor(db: Db, me: string, personId: string): 'yes' | 'none' | 'other' {
  const p = getPerson(db, personId);
  if (!p) return 'none';
  return p.id === me || p.role === 'kid' ? 'yes' : 'other';
}

/** Admins who can sign in (standalone): at least one must stay. */
export function adminsWithPasskey(db: Db, except?: string): number {
  const rows = db.selectDistinct({ id: t.person.id }).from(t.person).innerJoin(t.passkey, eq(t.passkey.personId, t.person.id))
    .where(except ? and(eq(t.person.role, 'admin'), ne(t.person.id, except)) : eq(t.person.role, 'admin')).all();
  return rows.length;
}

/** No admin can sign in yet (standalone): the household needs its setup link. */
export function setupNeeded(db: Db): boolean {
  const row = db.select({ n: count() }).from(t.passkey).innerJoin(t.person, eq(t.person.id, t.passkey.personId))
    .where(eq(t.person.role, 'admin')).get();
  return (row?.n ?? 0) === 0;
}

export class HouseholdError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

/** A handle from a name: lower case, letters and digits, unique in the household. */
export function suggestHandle(db: Db, name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 16) || 'person';
  for (let i = 1; ; i++) {
    const h = i === 1 ? base : `${base}${i}`;
    if (!db.select().from(t.person).where(eq(t.person.handle, h)).get()) return h;
  }
}

export interface PersonInput { name: string; role: Role; handle?: string | null; birthYear?: number | null }

function checkHandle(db: Db, handle: string, self?: string) {
  const other = db.select().from(t.person).where(eq(t.person.handle, handle)).get();
  if (other && other.id !== self) throw new HouseholdError(409, 'that handle is taken');
}

export function addPerson(db: Db, i: PersonInput): Person {
  const handle = i.handle ?? suggestHandle(db, i.name);
  checkHandle(db, handle);
  const p = { id: ulid(), name: i.name.trim(), role: i.role, handle, birthYear: i.role === 'kid' ? i.birthYear ?? null : null, settingsJson: '{}' };
  db.insert(t.person).values(p).run();
  return getPerson(db, p.id)!;
}

export function editPerson(db: Db, id: string, patch: Partial<PersonInput>): Person {
  const p = getPerson(db, id);
  if (!p) throw new HouseholdError(404, 'no such person');
  if (patch.role && patch.role !== 'admin' && p.role === 'admin' && adminsWithPasskey(db, id) === 0) throw new HouseholdError(409, 'the household needs an admin who can sign in');
  if (patch.handle) checkHandle(db, patch.handle, id);
  const role = patch.role ?? p.role;
  db.transaction((tx) => {
    tx.update(t.person).set({
      name: patch.name?.trim() ?? p.name,
      role,
      handle: patch.handle === undefined ? p.handle : patch.handle,
      birthYear: role === 'kid' ? (patch.birthYear === undefined ? p.birthYear : patch.birthYear) : null,
    }).where(eq(t.person.id, id)).run();
    // Kids never sign in: becoming one ends every session and removes every passkey and device.
    if (role === 'kid' && p.role !== 'kid') becameKid(tx as unknown as Db, id);
    if (role !== 'admin' && p.role === 'admin') {
      revokeInvitesBy(tx as unknown as Db, id);
      revokeJoinLinksBy(tx as unknown as Db, id); // and their join links, as revoked: the people who came with them are declined
    }
  });
  return getPerson(db, id)!;
}

/**
 * Kids never sign in: becoming one ends every session and removes every passkey, link and device (here and under
 * HomersLab, household/waiting.ts). Nor do they get notifications (push/push.ts checks the role at each send too).
 */
export function becameKid(db: Db, id: string): void {
  db.delete(t.session).where(eq(t.session.personId, id)).run();
  db.delete(t.passkey).where(eq(t.passkey.personId, id)).run();
  db.delete(t.invite).where(eq(t.invite.personId, id)).run();
  db.delete(t.pushSubscription).where(eq(t.pushSubscription.personId, id)).run();
}

/** An admin's open invites, gone when the admin is removed or stops being one. */
export function revokeInvitesBy(db: Db, adminId: string): void {
  db.delete(t.invite).where(and(eq(t.invite.createdBy, adminId), eq(t.invite.kind, 'admin'), isNull(t.invite.usedAt))).run();
}

export function removePerson(db: Db, id: string, by: string): void {
  const p = getPerson(db, id);
  if (!p) throw new HouseholdError(404, 'no such person');
  if (id === by) throw new HouseholdError(409, 'you cannot remove yourself');
  if (p.role === 'admin' && adminsWithPasskey(db, id) === 0) throw new HouseholdError(409, 'the household needs an admin who can sign in');
  try {
    db.transaction((tx) => {
      revokeInvitesBy(tx as unknown as Db, id); // otherwise they would outlive their admin, with no one behind them
      revokeJoinLinksBy(tx as unknown as Db, id); // their join links too, as revoked
      purgeTakeawayRuns(tx as unknown as Db, id); // their runs go with them (ai_run.takeaways_of cascades)
      tx.delete(t.person).where(eq(t.person.id, id)).run();
    });
  } catch {
    throw new HouseholdError(409, 'this person still has shares or orders');
  }
}
