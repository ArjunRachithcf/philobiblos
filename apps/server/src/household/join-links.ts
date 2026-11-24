// Household join links (standalone; ADR 0011, philobiblos#34 slice 2). An admin makes one with a fresh sign-in, once a
// home network is listed: 7 days and 5 uses by default (1 to 14 days, 1 to 10 uses). The token is in the link's
// #fragment and the database keeps its SHA-256. Whoever opens it from the household's networks gives a name and enrols
// a passkey, then waits for an admin (household/waiting.ts). A use counts only at that enrolment, in its transaction.
// Revoking a link declines its waiting people; an admin who is removed or stops being one takes their links along.
import { and, desc, eq, gt, inArray, lt, lte, notExists, or, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { hashToken, looksLikeToken, newToken } from '../auth/tokens';
import { NO_SURROUNDINGS, homeNetworks, inHomeNetwork, type Surroundings } from '../net/networks';
import { WAITING, dropWaiting, waitingNow } from './waiting-rows';

export type JoinLink = typeof t.joinLink.$inferSelect;
export const JOIN_LINK = { days: 7, uses: 5, maxDays: 14, maxUses: 10 } as const;
const DAY = 86_400_000;

export class JoinLinkError extends Error {
  constructor(readonly status: 404 | 409, message: string) { super(message); }
}

/** A new link; 409 while no home network is listed (an empty list never means anywhere). */
export function createJoinLink(db: Db, cfg: Pick<Config, 'origin'>, o: { createdBy: string; days?: number; uses?: number; now?: Date }) {
  const now = o.now ?? new Date();
  if (!homeNetworks(db).length) throw new JoinLinkError(409, 'list the home network first: a join link opens only from it');
  const token = newToken();
  const expiresAt = new Date(now.getTime() + (o.days ?? JOIN_LINK.days) * DAY);
  const id = ulid();
  db.insert(t.joinLink).values({
    id, tokenHash: hashToken(token), createdBy: o.createdBy, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString(), maxUses: o.uses ?? JOIN_LINK.uses,
  }).run();
  return { id, url: `${cfg.origin}/join#${token}`, token, expiresAt, maxUses: o.uses ?? JOIN_LINK.uses };
}

/** The hash a presented token is looked up by; anything that is not a token's shape hashes as the empty one (the same work). */
export const presentedHash = (token: unknown) => hashToken(looksLikeToken(token) ? token : '');

/**
 * The one check of a presented link, for opening it, joining with it and enrolling: the link, if it is known, unexpired,
 * not used up, the address is in the household's networks (never a hop: net/networks.ts isHop) and the waiting list has room; null otherwise. Every case
 * does the same work (one lookup by hash, the whole network list, the count), so neither the answer nor its time says
 * which it was. The caller lapses old requests first (household/waiting-rows.ts), so a lapsed one frees its place.
 */
export function checkLink(tx: Db, by: { hash: string } | { id: string }, address: string | undefined, now = new Date(), s: Surroundings = NO_SURROUNDINGS): JoinLink | null {
  const row = tx.select().from(t.joinLink).where('hash' in by ? eq(t.joinLink.tokenHash, by.hash) : eq(t.joinLink.id, by.id)).get();
  const home = inHomeNetwork(tx, address, s);
  const room = waitingNow(tx) < WAITING.max;
  const open = row !== undefined && row.expiresAt > now.toISOString() && row.uses < row.maxUses;
  return open && home && room ? row : null;
}

/** Counts a use, at an enrolment, inside its transaction: false if the link was used up or expired in between. */
export function spendUse(tx: Db, id: string, now = new Date()): boolean {
  return tx.update(t.joinLink).set({ uses: sql`${t.joinLink.uses} + 1` })
    .where(and(eq(t.joinLink.id, id), lt(t.joinLink.uses, t.joinLink.maxUses), gt(t.joinLink.expiresAt, now.toISOString()))).run().changes === 1;
}

/** The waiting people who came with these links. */
const waitersOf = (db: Db, linkIds: string[]) => linkIds.length
  ? db.select({ id: t.joinRequest.personId }).from(t.joinRequest).innerJoin(t.person, eq(t.person.id, t.joinRequest.personId))
    .where(and(inArray(t.joinRequest.joinLinkId, linkIds), eq(t.person.state, 'waiting'))).all().map((r) => r.id)
  : [];

/** Revokes a link: it goes, and its waiting people are declined (a revoked link is one an admin no longer trusts). */
export function revokeJoinLink(db: Db, id: string): void {
  db.transaction((tx0) => {
    const tx = tx0 as unknown as Db;
    if (!tx.select({ id: t.joinLink.id }).from(t.joinLink).where(eq(t.joinLink.id, id)).get()) throw new JoinLinkError(404, 'no such join link');
    dropWaiting(tx, waitersOf(tx, [id]));
    tx.delete(t.joinLink).where(eq(t.joinLink.id, id)).run();
  }, { behavior: 'immediate' });
}

/** An admin removed or no longer one: their links go, as revoked (inside the caller's transaction). */
export function revokeJoinLinksBy(tx: Db, adminId: string): void {
  const ids = tx.select({ id: t.joinLink.id }).from(t.joinLink).where(eq(t.joinLink.createdBy, adminId)).all().map((r) => r.id);
  if (!ids.length) return;
  dropWaiting(tx, waitersOf(tx, ids));
  tx.delete(t.joinLink).where(inArray(t.joinLink.id, ids)).run();
}

export interface JoinLinkView { id: string; createdAt: string; expiresAt: string; maxUses: number; uses: number; createdBy: string | null; waiting: number; open: boolean }

/**
 * The links an admin sees: every one still open, and closed ones (expired or used up) while someone who came with
 * them waits. A closed link nobody waits for is forgotten here.
 */
export function listJoinLinks(db: Db, now = new Date()): JoinLinkView[] {
  const iso = now.toISOString();
  const waits = sql<number>`(SELECT count(*) FROM ${t.joinRequest} INNER JOIN ${t.person} ON ${t.person.id} = ${t.joinRequest.personId}
    WHERE ${t.joinRequest.joinLinkId} = ${t.joinLink.id} AND ${t.person.state} = 'waiting')`;
  const closed = or(lte(t.joinLink.expiresAt, iso), eq(t.joinLink.uses, t.joinLink.maxUses));
  db.delete(t.joinLink).where(and(closed, notExists(db.select({ x: t.joinRequest.personId }).from(t.joinRequest).where(eq(t.joinRequest.joinLinkId, t.joinLink.id))))).run();
  return db.select({ l: t.joinLink, by: t.person.name, waiting: waits }).from(t.joinLink).leftJoin(t.person, eq(t.person.id, t.joinLink.createdBy))
    .orderBy(desc(t.joinLink.createdAt), desc(t.joinLink.id)).all()
    .map(({ l, by, waiting }) => ({
      id: l.id, createdAt: l.createdAt, expiresAt: l.expiresAt, maxUses: l.maxUses, uses: l.uses, createdBy: by ?? null,
      waiting: Number(waiting ?? 0), open: l.expiresAt > iso && l.uses < l.maxUses,
    }));
}
