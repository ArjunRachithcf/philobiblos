// Opens (and migrates) the SQLite database.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolveEnv } from '@philobiblos/contracts/env';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** drizzle/ next to the bundle (dist/) or two levels up from this file (src/db/). */
export function migrationsDir(): string {
  const set = resolveEnv().PHILOBIBLOS_MIGRATIONS_DIR;
  if (set) return set;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const d of [join(here, '../drizzle'), join(here, '../../drizzle')]) if (existsSync(join(d, 'meta/_journal.json'))) return d;
  throw new Error('drizzle migrations folder not found; set PHILOBIBLOS_MIGRATIONS_DIR');
}

/** `file` is a path or ':memory:'. */
export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const client = new Database(file);
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  const db = drizzle(client, { schema });
  migrate(db, { migrationsFolder: migrationsDir() });
  return db as Db;
}
