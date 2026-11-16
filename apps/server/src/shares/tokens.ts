// Phone share tokens (ADR 0009, contracts/connectors.md "Phone share"): per person, good for POST /shares and nothing
// else, shown once, stored as a SHA-256 hash, listed by label, revocable.
//
// A token is its row's id (a ULID, 26 characters) followed by 256 random bits (43 base64url characters). The id finds
// the row; the hashes are then compared in constant time, so no answer, and no time an answer takes, depends on how
// much of a guess was right. A token that is not exactly that shape is refused before anything is looked up.
import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { newToken } from '../auth/tokens';

export const SHARE_TOKEN = /^([0-9A-HJKMNP-TV-Z]{26})([A-Za-z0-9_-]{43})$/;
/** Live (not revoked) tokens a person may hold. */
export const MAX_LIVE_TOKENS = 10;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export type TokenRow = typeof t.shareToken.$inferSelect;
export const tokenView = (r: TokenRow) => ({ id: r.id, label: r.label, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, revoked: r.revokedAt != null });

export class TokenError extends Error {
  constructor(readonly status: 409, message: string) { super(message); }
}

/** A new token for `personId`: the row (its hash only) and the token, which is returned this once. */
export function createShareToken(db: Db, personId: string, label: unknown, now = new Date()): { row: TokenRow; token: string } {
  const name = typeof label === 'string' && label.trim() ? label.trim().slice(0, 60) : 'Phone';
  const live = db.select({ id: t.shareToken.id }).from(t.shareToken).where(and(eq(t.shareToken.personId, personId), isNull(t.shareToken.revokedAt))).all().length;
  if (live >= MAX_LIVE_TOKENS) throw new TokenError(409, `${MAX_LIVE_TOKENS} live share tokens already: revoke one first`);
  const id = ulid();
  const token = id + newToken();
  const row: TokenRow = { id, personId, label: name, tokenHash: sha256(token).toString('hex'), createdAt: now.toISOString(), lastUsedAt: null, revokedAt: null };
  db.insert(t.shareToken).values(row).run();
  return { row, token };
}

/** The live token row a presented token is, or null. */
export function findShareToken(db: Db, presented: string): TokenRow | null {
  const m = SHARE_TOKEN.exec(presented);
  if (!m) return null;
  const row = db.select().from(t.shareToken).where(and(eq(t.shareToken.id, m[1]!), isNull(t.shareToken.revokedAt))).get();
  // Compared whether or not a row was found, against a hash of the right length either way.
  const want = row && /^[0-9a-f]{64}$/.test(row.tokenHash) ? Buffer.from(row.tokenHash, 'hex') : Buffer.alloc(32);
  const same = timingSafeEqual(sha256(presented), want);
  return row && same ? row : null;
}

export function revokeShareToken(db: Db, personId: string, id: string, now = new Date()): void {
  db.update(t.shareToken).set({ revokedAt: now.toISOString() })
    .where(and(eq(t.shareToken.id, id), eq(t.shareToken.personId, personId), isNull(t.shareToken.revokedAt))).run();
}

/**
 * A fixed-window counter per key (an address, a person): `hit` says whether this one is still allowed. Bounded: past
 * `maxKeys` the oldest windows go first.
 */
export class Limiter {
  private readonly seen = new Map<string, { n: number; until: number }>();
  constructor(readonly max: number, readonly windowMs: number, readonly maxKeys = 10_000) {}
  hit(key: string, now = Date.now()): boolean {
    let w = this.seen.get(key);
    if (!w || w.until <= now) {
      this.seen.delete(key);
      if (this.seen.size >= this.maxKeys) this.seen.delete(this.seen.keys().next().value!);
      w = { n: 0, until: now + this.windowMs };
      this.seen.set(key, w);
    }
    w.n++;
    return w.n <= this.max;
  }
}
