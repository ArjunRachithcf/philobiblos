// contracts/schema.sql is the source of truth: the migrations, applied in order, build exactly that database, and
// the Drizzle schema in src/db/schema.ts describes it too. (0000_init.sql was the contract's v1, verbatim.)
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
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
