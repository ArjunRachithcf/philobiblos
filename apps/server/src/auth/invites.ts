// One-time links to enrol a passkey (ADR 0010): the first admin's setup link, and invites for adults. The token
// travels in the link's #fragment (never in a request line or a log) and the database keeps only its hash.
import { closeSync, constants, fchmodSync, openSync, rmSync, writeSync } from 'node:fs';
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

export const SELF_HOURS = 24;
export const RECOVERY_HOURS = 24;

/**
 * A new one-time link. 'setup': the first admin's (24 h). 'enrol' for someone else: an admin's invite (7 days);
 * for yourself (createdBy = personId) or a recovery link from the CLI (createdBy null): 24 h.
 */
export function createInvite(db: Db, cfg: Pick<Config, 'origin'>, o: { purpose: 'setup' | 'enrol'; personId?: string; createdBy?: string; now?: Date }) {
  const now = o.now ?? new Date();
  const token = newToken();
  const hours = o.purpose === 'setup' ? SETUP_HOURS : o.createdBy && o.createdBy !== o.personId ? INVITE_DAYS * 24 : SELF_HOURS;
  const expiresAt = new Date(now.getTime() + hours * HOUR);
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

/** An open recovery link (an 'enrol' invite nobody in the household made, from `shelf recover`). */
export function openRecovery(db: Db, now = new Date()): boolean {
  return Boolean(db.select({ id: t.invite.id }).from(t.invite)
    .where(and(eq(t.invite.purpose, 'enrol'), isNull(t.invite.createdBy), isNull(t.invite.usedAt), gt(t.invite.expiresAt, now.toISOString()))).get());
}

/**
 * Standalone start-up: while no admin can sign in, a fresh setup link (older ones stop working) is written to
 * SHELF_DATA_DIR/setup-link.txt, readable by Shelf's user only. The log says where the file is, never the link.
 * Once an admin can sign in, the file goes, unless it holds an open recovery link.
 */
export function ensureSetupLink(db: Db, cfg: Pick<Config, 'mode' | 'origin' | 'dataDir'>): string | null {
  if (cfg.mode !== 'standalone' || !setupNeeded(db)) {
    if (!openRecovery(db)) removeSetupLink(cfg);
    return null;
  }
  db.delete(t.invite).where(eq(t.invite.purpose, 'setup')).run();
  const { url } = createInvite(db, cfg, { purpose: 'setup' });
  return writeLinkFile(cfg, url);
}

/**
 * `shelf recover <handle>`: a one-time link (24 hours) for an existing admin to enrol a new passkey, written to the
 * same file as the setup link. For the person who runs Shelf's container (they hold the data folder anyway).
 */
export function createRecoveryLink(db: Db, cfg: Pick<Config, 'mode' | 'origin' | 'dataDir'>, handle: string): string {
  if (cfg.mode !== 'standalone') throw new Error('under HomersLab, HomersLab signs people in');
  const p = db.select().from(t.person).where(eq(t.person.handle, handle)).get();
  if (!p || p.role !== 'admin') throw new Error(`no admin with the handle ${handle}`);
  const { url } = createInvite(db, cfg, { purpose: 'enrol', personId: p.id });
  return writeLinkFile(cfg, url);
}

/**
 * Writes the link file without following a link someone put there: the old name is removed (rm removes a symlink,
 * not its target), then the file is created anew, exclusively, 0600.
 */
function writeLinkFile(cfg: Pick<Config, 'dataDir'>, url: string): string {
  const file = join(cfg.dataDir, SETUP_FILE);
  rmSync(file, { force: true });
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${url}\n`);
  } finally {
    closeSync(fd);
  }
  return file;
}

export function removeSetupLink(cfg: Pick<Config, 'dataDir'>): void {
  rmSync(join(cfg.dataDir, SETUP_FILE), { force: true });
}
