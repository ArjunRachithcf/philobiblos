// Household join links (standalone; ADR 0011, philobiblos#34 slice 2). An admin makes one with a fresh sign-in, once a
// home network is listed: 7 days and 5 uses by default (1 to 14 days, 1 to 10 uses). The token is in the link's
// #fragment and the database keeps its SHA-256. Whoever opens it from the household's networks gives a name and enrols
// a passkey, then waits for an admin (household/waiting.ts). A use counts only at that enrolment, in its transaction.
// Revoking a link declines its waiting people; an admin who is removed or stops being one takes their links along.
//
// Rules (slice 3, ADR 0011 "Rules that accept automatically"): the household's rule is its networks, and every link
// keeps it; a link's own rules only add to it (narrower ranges inside the household's). A link set to accept
// automatically lets in, as an adult and never an admin, whoever matches every rule, with immediate use; whoever does not
// match waits, or is refused when the link refuses non-matches. Outside the household's networks everyone is refused.
import { and, desc, eq, gt, inArray, lt, lte, notExists, or, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { hashToken, looksLikeToken, newToken } from '../auth/tokens';
import { NETWORKS, NO_SURROUNDINGS, homeNetworks, inHomeNetwork, inRanges, parseCidr, rangeProblem, type Cidr, type Surroundings } from '../net/networks';
import { WAITING, dropWaiting, waitingNow } from './waiting-rows';

export type JoinLink = typeof t.joinLink.$inferSelect;
export const JOIN_LINK = { days: 7, uses: 5, maxDays: 14, maxUses: 10 } as const;
const DAY = 86_400_000;

export class JoinLinkError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

/** The only role a rule ever gives: a match is an adult, never an admin (ADR 0011). */
export const RULE_ROLE = 'adult' as const;

/** A link's own rules, as an admin sets them; each only narrows the household's. */
export interface LinkRules {
  /** Let in at once whoever matches every rule (false: everyone waits for an admin). */
  automatic: boolean;
  /** Refuse whoever does not match, instead of letting them wait. */
  refuseNonMatches: boolean;
  /** Ranges inside the household's networks the link opens from; null: all of the household's. */
  networks: Cidr[] | null;
}
export const NO_RULES: LinkRules = { automatic: false, refuseNonMatches: false, networks: null };

/** Whether `inner` lies wholly inside `outer`. */
const within = (inner: Cidr, outer: Cidr) => inner.family === outer.family && inner.prefix >= outer.prefix && inRanges([outer], inner.network);

/**
 * A link's ranges as an admin gives them (1 to NETWORKS.max CIDRs), each inside one of the household's networks: a
 * link never opens wider than the household (rules only narrow). Throws a 400 JoinLinkError otherwise.
 */
export function linkNetworks(db: Db, given: unknown, s: Surroundings = NO_SURROUNDINGS): Cidr[] {
  if (!Array.isArray(given) || given.length < 1 || given.length > NETWORKS.max) {
    throw new JoinLinkError(400, `networks: 1 to ${NETWORKS.max} ranges inside the home network (leave it out for all of it)`);
  }
  const household = homeNetworks(db).map((n) => parseCidr(n.cidr)).filter((c): c is Cidr => c !== null);
  if (!household.length) throw new JoinLinkError(409, 'list the home network first: a join link opens only from it');
  const out: Cidr[] = [];
  for (const g of given) {
    const c = parseCidr(g);
    if (!c) throw new JoinLinkError(400, `not a range Philobiblos takes: ${String(g).slice(0, 64)}`);
    const problem = rangeProblem(s, c);
    if (problem) throw new JoinLinkError(400, problem);
    if (!household.some((h) => within(c, h))) throw new JoinLinkError(400, `${c.cidr} is not inside the home network: a link's rules only narrow the household's`);
    if (!out.some((o) => o.cidr === c.cidr)) out.push(c);
  }
  return out;
}

/** A stored link's rules. Stored ranges that no longer parse match no one (fail closed). */
export function rulesOf(row: Pick<JoinLink, 'automatic' | 'refuseNonMatches' | 'networksJson'>): LinkRules {
  let networks: Cidr[] | null = null;
  if (row.networksJson !== null) {
    let parsed: unknown;
    try { parsed = JSON.parse(row.networksJson); } catch { parsed = null; }
    const list = Array.isArray(parsed) ? parsed.map((c) => parseCidr(c)) : [null];
    networks = list.every((c): c is Cidr => c !== null) ? list : [];
  }
  return { automatic: row.automatic === 1, refuseNonMatches: row.refuseNonMatches === 1, networks };
}

/** A new link; 409 while no home network is listed (an empty list never means anywhere). */
export function createJoinLink(db: Db, cfg: Pick<Config, 'origin'>, o: { createdBy: string; days?: number; uses?: number; rules?: LinkRules; now?: Date }) {
  const now = o.now ?? new Date();
  if (!homeNetworks(db).length) throw new JoinLinkError(409, 'list the home network first: a join link opens only from it');
  const rules = o.rules ?? NO_RULES;
  const token = newToken();
  const expiresAt = new Date(now.getTime() + (o.days ?? JOIN_LINK.days) * DAY);
  const id = ulid();
  db.insert(t.joinLink).values({
    id, tokenHash: hashToken(token), createdBy: o.createdBy, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString(), maxUses: o.uses ?? JOIN_LINK.uses,
    automatic: rules.automatic ? 1 : 0, refuseNonMatches: rules.refuseNonMatches ? 1 : 0, networksJson: rules.networks ? JSON.stringify(rules.networks.map((c) => c.cidr)) : null,
  }).run();
  return { id, url: `${cfg.origin}/join#${token}`, token, expiresAt, maxUses: o.uses ?? JOIN_LINK.uses };
}

/** The hash a presented token is looked up by; anything that is not a token's shape hashes as the empty one (the same work). */
export const presentedHash = (token: unknown) => hashToken(looksLikeToken(token) ? token : '');

/**
 * What a presented link does for this address: `accept` (they match every rule of a link that accepts automatically:
 * an adult at once), `wait` (for an admin), or null (the one answer for every link that does not open: unknown,
 * expired, used up, outside the household's networks (never a hop: net/networks.ts isHop), a non-match on a link that
 * refuses them, or a full waiting list for someone who would wait). Every case does the same work (one lookup by hash, the whole network list, the
 * link's ranges, the count), so neither the answer nor its time says which it was. The caller lapses old requests
 * first (household/waiting-rows.ts), so a lapsed one frees its place. A rule match takes no waiting place, so a full
 * list never holds one back.
 */
/** `matches`: whether they matched the link's own rules; null when it has none beyond the household's. */
export interface Admission { link: JoinLink; outcome: 'accept' | 'wait'; matches: boolean | null }
export function checkLink(tx: Db, by: { hash: string } | { id: string }, address: string | null | undefined, now = new Date(), s: Surroundings = NO_SURROUNDINGS): Admission | null {
  const row = tx.select().from(t.joinLink).where('hash' in by ? eq(t.joinLink.tokenHash, by.hash) : eq(t.joinLink.id, by.id)).get();
  // The household's rule, which every link keeps: its networks.
  const home = inHomeNetwork(tx, address, s);
  const rules = rulesOf(row ?? { automatic: 0, refuseNonMatches: 0, networksJson: '[]' });
  // The link's own: inside its ranges too, when it has any (they add to the household's, never replace it).
  const inOwn = rules.networks === null || inRanges(rules.networks, address);
  const matches = home && inOwn;
  const room = waitingNow(tx) < WAITING.max;
  const open = row !== undefined && row.expiresAt > now.toISOString() && row.uses < row.maxUses;
  if (!open || !home || (!matches && rules.refuseNonMatches)) return null;
  const outcome = matches && rules.automatic ? 'accept' as const : 'wait' as const;
  if (outcome === 'wait' && !room) return null;
  return { link: row, outcome, matches: rules.networks === null ? null : matches };
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

export interface JoinLinkView {
  id: string; createdAt: string; expiresAt: string; maxUses: number; uses: number; createdBy: string | null; waiting: number; open: boolean;
  accept: 'approval' | 'automatic'; nonMatches: 'wait' | 'refuse'; networks: string[] | null;
}

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
      waiting: Number(waiting ?? 0), open: l.expiresAt > iso && l.uses < l.maxUses, ...rulesView(rulesOf(l)),
    }));
}

/** A link's rules as the API shows them. */
export const rulesView = (r: LinkRules) => ({
  accept: r.automatic ? 'automatic' as const : 'approval' as const,
  nonMatches: r.refuseNonMatches ? 'refuse' as const : 'wait' as const,
  networks: r.networks ? r.networks.map((c) => c.cidr) : null,
});
