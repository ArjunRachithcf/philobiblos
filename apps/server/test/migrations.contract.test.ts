// contracts/schema.sql is the source of truth: the migrations, applied in order, build exactly that database, and
// the Drizzle schema in src/db/schema.ts describes it too. (0000_init.sql was the contract's v1, verbatim.)
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDb } from '../src/db/open';
import * as schema from '../src/db/schema';

const contractSql = readFileSync(new URL('../../../contracts/schema.sql', import.meta.url), 'utf8');

function checks(sql: string): string[] {
  const out: string[] = [];
  const re = /\bCHECK\s*\(/gi;
  while (re.exec(sql)) {
    let depth = 1, i = re.lastIndex, quote = false;
    for (; i < sql.length && depth > 0; i++) {
      const c = sql[i];
      if (c === "'") quote = !quote;
      else if (!quote && c === '(') depth++;
      else if (!quote && c === ')') depth--;
    }
    const body = sql.slice(re.lastIndex, i - 1)
      .replace(/"?\w+"?\."?(\w+)"?/g, '$1').replace(/["`]/g, '').replace(/\s+/g, '').toLowerCase();
    out.push(body);
  }
  return out.sort();
}

/** Tables, columns, keys, indexes and CHECKs of a database, normalised. */
function describeDb(db: Database.Database) {
  const tables = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name`).all() as { name: string; sql: string }[];
  return Object.fromEntries(tables.map(({ name, sql }) => {
    const q = JSON.stringify(name);
    const cols = (db.prepare(`PRAGMA table_info(${q})`).all() as { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[])
      .map((c) => ({ ...c, type: c.type.toUpperCase() }));
    const fks = (db.prepare(`PRAGMA foreign_key_list(${q})`).all() as { table: string; from: string; to: string; on_delete: string; on_update: string }[])
      .map((f) => `${f.from}->${f.table}.${f.to} del:${f.on_delete.toUpperCase()} upd:${f.on_update.toUpperCase()}`).sort();
    const idx = (db.prepare(`PRAGMA index_list(${q})`).all() as { name: string; unique: number; origin: string }[])
      .filter((i) => i.origin !== 'pk')
      .map((i) => {
        const on = (db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all() as { name: string }[]).map((c) => c.name).join(',');
        return i.unique ? `unique(${on})` : `${i.name}(${on})`;
      }).sort();
    return [name, { cols, fks, idx, checks: checks(sql) }];
  }));
}

function latestSnapshot(): string {
  const journal = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: { idx: number }[] };
  const last = journal.entries.at(-1)!.idx;
  return `${String(last).padStart(4, '0')}_snapshot.json`;
}

function fromSql(statements: string[]): Database.Database {
  const db = new Database(':memory:');
  for (const s of statements) db.exec(s);
  return db;
}

describe('migrations', () => {
  it('the migrations build the contract\'s database', () => {
    const migrated = openDb(':memory:');
    expect(describeDb(migrated.$client)).toEqual(describeDb(fromSql([contractSql])));
    expect(migrated.$client.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('the Drizzle schema describes the same database', async () => {
    const empty = await generateSQLiteDrizzleJson({});
    const current = await generateSQLiteDrizzleJson(schema);
    const fromTs = fromSql(await generateSQLiteMigration(empty, current));
    expect(describeDb(fromTs)).toEqual(describeDb(fromSql([contractSql])));
  });

  it('the Drizzle snapshot is in sync with the schema (pnpm db:generate has nothing to add)', async () => {
    const snapshot = JSON.parse(readFileSync(new URL(`../drizzle/meta/${latestSnapshot()}`, import.meta.url), 'utf8'));
    const current = await generateSQLiteDrizzleJson(schema, snapshot.id);
    expect(await generateSQLiteMigration(snapshot, current)).toEqual([]);
  });
});

// A released migration never changes: databases that ran it would never run the new text.
const RELEASED: Record<string, string> = {
  '0000_init.sql': 'a404d94116333a57b0145af574033b7f0e110f37905dbdf31dc0ac27a0d4fbaa', // contract v1 (M0)
  '0001_auth_and_household.sql': '8b7c16f8eef2aff40d747de07d65ff26369ec40c1e5d28f38c087098a4f5f75b', // contract v2 (M1 a, PR #1)
};
const drizzleDir = fileURLToPath(new URL('../drizzle', import.meta.url));

describe('upgrades', () => {
  it.each(Object.entries(RELEASED))('%s is unchanged', (file, sha) => {
    expect(createHash('sha256').update(readFileSync(join(drizzleDir, file))).digest('hex')).toBe(sha);
  });

  it('a v1 database with rows migrates to the latest, keeping them', () => {
    // The migrations folder as it was at v1: only 0000 in the journal.
    const v1Dir = join(mkdtempSync(join(tmpdir(), 'shelf-mig-')), 'drizzle');
    cpSync(drizzleDir, v1Dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(v1Dir, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    writeFileSync(join(v1Dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));

    const client = new Database(':memory:');
    client.pragma('foreign_keys = ON');
    const db = drizzle(client);
    migrate(db, { migrationsFolder: v1Dir });
    const now = '2026-11-01T00:00:00Z';
    client.prepare(`INSERT INTO person (id, external_id, name, role, birth_year) VALUES ('p_alex', 'hl-alex', 'Alex', 'admin', NULL), ('p_kid1', NULL, 'Kid 1', 'kid', 2021)`).run();
    client.prepare(`INSERT INTO book (id, title, authors_json, audience, norm_key, created_at) VALUES ('b_tide', 'The Long Tide of Markets', '["Mira Okafor"]', 'adult', 'long tide|okafor', ?)`).run(now);
    client.prepare(`INSERT INTO reading (person_id, book_id, status, updated_at) VALUES ('p_alex', 'b_tide', 'reading', ?)`).run(now);
    client.prepare(`INSERT INTO share_token (id, person_id, label, token_hash, created_at) VALUES ('st1', 'p_alex', 'Phone', 'h', ?)`).run(now);

    migrate(db, { migrationsFolder: drizzleDir });
    expect(describeDb(client)).toEqual(describeDb(fromSql([contractSql])));
    expect(client.prepare('SELECT id, name, role, handle FROM person ORDER BY id').all()).toEqual([
      { id: 'p_alex', name: 'Alex', role: 'admin', handle: null }, { id: 'p_kid1', name: 'Kid 1', role: 'kid', handle: null },
    ]);
    expect(client.prepare('SELECT person_id, book_id, status FROM reading').all()).toEqual([{ person_id: 'p_alex', book_id: 'b_tide', status: 'reading' }]);
    expect(client.prepare('SELECT id FROM share_token').all()).toEqual([{ id: 'st1' }]);
    expect(client.pragma('foreign_key_check')).toEqual([]);
  });
});
