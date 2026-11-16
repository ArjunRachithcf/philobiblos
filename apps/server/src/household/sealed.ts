// Sealed values (docs/security.md): the delivery address and the bookshop's address, AES-256-GCM in `sealed_secret`
// with a key that is never in the database or its backup (config.sealingKey). The row's name is bound to the
// ciphertext (associated data), so a sealed value cannot be moved to another name. Values never reach logs.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';

export class SealError extends Error {}

function decode(text: string): Buffer {
  const k = Buffer.from(text.trim(), 'base64');
  if (k.length !== 32) throw new SealError('the sealing key must be 32 bytes, base64');
  return k;
}

/** The key, or null when there is none (homerslab mode without SHELF_SEALING_KEY). Standalone makes its key once. */
export function sealingKey(cfg: Pick<Config, 'sealingKey'>): Buffer | null {
  const src = cfg.sealingKey;
  if (!src) return null;
  // A row sealed under a key that is gone stays unreadable: unseal() says so (SealError), nothing is guessed.
  if ('value' in src) return decode(src.value);
  if (!existsSync(src.file)) {
    if (!src.create) throw new SealError('SHELF_SEALING_KEY_FILE names no file');
    mkdirSync(dirname(src.file), { recursive: true });
    try {
      // O_EXCL: two starts never write two keys; 0600: only Shelf's user reads it.
      const fd = openSync(src.file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeSync(fd, randomBytes(32).toString('base64') + '\n');
      closeSync(fd);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
  return decode(readFileSync(src.file, 'utf8'));
}

/**
 * What is wrong with the key's configuration, without making a key: 'missing' (none configured, or the named file is
 * not there) or 'unreadable' (not 32 bytes of base64, or the file cannot be read); null when it is usable (a standalone
 * key that does not exist yet is made on the first seal).
 */
export function keyProblem(cfg: Pick<Config, 'sealingKey'>): 'missing' | 'unreadable' | null {
  const src = cfg.sealingKey;
  if (!src) return 'missing';
  try {
    if ('value' in src) decode(src.value);
    else if (existsSync(src.file)) decode(readFileSync(src.file, 'utf8'));
    else if (!src.create) return 'missing';
    return null;
  } catch { return 'unreadable'; }
}

const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 12);

function sealedRow(key: Buffer, name: string, value: string, now: Date) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(name));
  const body = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return { key: name, ciphertext: Buffer.concat([iv, c.getAuthTag(), body]), keyId: keyId(key), updatedAt: now.toISOString() };
}

export function seal(db: Db, key: Buffer, name: string, value: string | null, now = new Date()): void {
  if (value === null) { db.delete(t.sealedSecret).where(eq(t.sealedSecret.key, name)).run(); return; }
  const row = sealedRow(key, name, value, now);
  db.insert(t.sealedSecret).values(row).onConflictDoUpdate({ target: t.sealedSecret.key, set: { ciphertext: row.ciphertext, keyId: row.keyId, updatedAt: row.updatedAt } }).run();
}

/** Seals `value` only when nothing is sealed under `name` yet (the row's name is unique: of two at once, the first wins). */
export function sealIfAbsent(db: Db, key: Buffer, name: string, value: string, now = new Date()): void {
  db.insert(t.sealedSecret).values(sealedRow(key, name, value, now)).onConflictDoNothing().run();
}

/** The value, or null when nothing is sealed under that name. No key, a wrong key or a changed row: SealError. */
export function unseal(db: Db, key: Buffer | null, name: string): string | null {
  const row = db.select().from(t.sealedSecret).where(eq(t.sealedSecret.key, name)).get();
  if (!row) return null;
  if (!key || row.keyId !== keyId(key)) throw new SealError('sealed with another key');
  const buf = row.ciphertext;
  try {
    const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAAD(Buffer.from(name));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch { throw new SealError('the sealed value does not open'); }
}

export const isSealed = (db: Db, name: string) => Boolean(db.select({ k: t.sealedSecret.key }).from(t.sealedSecret).where(eq(t.sealedSecret.key, name)).get());
