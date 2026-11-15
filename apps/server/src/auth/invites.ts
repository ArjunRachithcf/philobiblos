// One-time links to enrol a passkey (ADR 0010): the first admin's setup link, and invites for adults. The token
// travels in the link's #fragment (never in a request line or a log) and the database keeps only its hash.
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { setupNeeded } from '../household/people';
import { hashToken, looksLikeToken, newToken } from './tokens';

export type Invite = typeof t.invite.$inferSelect;
const HOUR = 3_600_000;
export const SETUP_HOURS = 24;
export const INVITE_DAYS = 7;
export const SETUP_FILE = 'setup-link.txt';

export function createInvite(db: Db, cfg: Pick<Config, 'origin'>, o: { purpose: 'setup' | 'enrol'; personId?: string; createdBy?: string; now?: Date }) {
  const now = o.now ?? new Date();
  const token = newToken();
  const expiresAt = new Date(now.getTime() + (o.purpose === 'setup' ? SETUP_HOURS * HOUR : INVITE_DAYS * 24 * HOUR));
  db.insert(t.invite).values({
    id: ulid(), purpose: o.purpose, personId: o.personId ?? null, tokenHash: hashToken(token),
    createdBy: o.createdBy ?? null, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
  }).run();
  const path = o.purpose === 'setup' ? 'setup' : 'enrol';
  return { url: `${cfg.origin}/${path}#${token}`, token, expiresAt };
}

/** The open invite a token belongs to (unused, unexpired), or null. */
export function findInvite(db: Db, token: unknown, now = new Date()): Invite | null {
  if (!looksLikeToken(token)) return null;
  return db.select().from(t.invite)
    .where(and(eq(t.invite.tokenHash, hashToken(token)), isNull(t.invite.usedAt), gt(t.invite.expiresAt, now.toISOString()))).get() ?? null;
}

/** Marks an invite used; false if someone else used it first. */
export function useInvite(db: Db, id: string, now = new Date()): boolean {
  return db.update(t.invite).set({ usedAt: now.toISOString() }).where(and(eq(t.invite.id, id), isNull(t.invite.usedAt))).run().changes === 1;
}

/**
 * Standalone start-up: while no admin can sign in, a fresh setup link (older ones stop working) is written to
 * SHELF_DATA_DIR/setup-link.txt, readable by Shelf's user only. The log says where the file is, never the link.
 */
export function ensureSetupLink(db: Db, cfg: Pick<Config, 'mode' | 'origin' | 'dataDir'>): string | null {
  const file = join(cfg.dataDir, SETUP_FILE);
  if (cfg.mode !== 'standalone' || !setupNeeded(db)) {
    rmSync(file, { force: true });
    return null;
  }
  db.delete(t.invite).where(eq(t.invite.purpose, 'setup')).run();
  const { url } = createInvite(db, cfg, { purpose: 'setup' });
  writeFileSync(file, `${url}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export function removeSetupLink(cfg: Pick<Config, 'dataDir'>): void {
  rmSync(join(cfg.dataDir, SETUP_FILE), { force: true });
}
