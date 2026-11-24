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
  it('each migration is dated after the one before it: drizzle applies only those newer than the last applied (philobiblos#45)', () => {
    const journal = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: { tag: string; when: number }[] };
    for (const [i, e] of journal.entries.entries()) if (i) expect(e.when, e.tag).toBeGreaterThan(journal.entries[i - 1]!.when);
  });

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

  it('the migrations build the contract\'s triggers (Drizzle has none; they are hand-written in 0005, 0011 and 0021)', () => {
    const triggers = (db: Database.Database) => (db.prepare(`SELECT name, tbl_name AS tbl, sql FROM sqlite_master WHERE type='trigger' ORDER BY name`).all() as { name: string; tbl: string; sql: string }[])
      .map((t) => ({ ...t, sql: t.sql.replace(/\s+/g, ' ').trim() }));
    const contract = triggers(fromSql([contractSql]));
    expect(contract.map((t) => t.name)).toHaveLength(16);
    expect(triggers(openDb(':memory:').$client)).toEqual(contract);
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
  '0002_ai_runs_know_takeaways.sql': '9b9e3c78fdf2d18c82eb6ddf2cf3bb13f7340995338ea3513f9d905325ca3375', // contract v3 (M1 b, PR #2)
  '0003_backlog.sql': '9932624f9add595389393ecd98268a6e19bc46bfa89beb4887895b5c8535697c', // contract v4 (M1 c, PR #4)
  '0004_reviews.sql': '8c03643bd767eba82d96db42f8c827f53f8899ba63270ab9f524721cfae5c418', // contract v5 (M2 a, PR #5)
  '0005_private_to_follows_the_run.sql': '25e5212cb395e646fa44442d184bbb36d48635ddadad28e5b41213dffed72922', // contract v6 (M2 b, PR #6)
};
const drizzleDir = fileURLToPath(new URL('../drizzle', import.meta.url));

describe('upgrades', () => {
  it.each(Object.entries(RELEASED))('%s is unchanged', (file, sha) => {
    expect(createHash('sha256').update(readFileSync(join(drizzleDir, file))).digest('hex')).toBe(sha);
  });

  it('a v1 database with rows migrates to the latest, keeping them', () => {
    // The migrations folder as it was at v1: only 0000 in the journal.
    const v1Dir = join(mkdtempSync(join(tmpdir(), 'philobiblos-mig-')), 'drizzle');
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
    // M0's token shape can never sign in again: 0008 revokes it (it is neither live nor counted).
    expect(client.prepare('SELECT id, revoked_at IS NOT NULL AS revoked FROM share_token').all()).toEqual([{ id: 'st1', revoked: 1 }]);
    expect(client.pragma('foreign_key_check')).toEqual([]);
  });

  it('a household from before M4 keeps its amounts\' meaning: its settings say the currency they were in (philobiblos#27)', () => {
    // The migrations folder as it was before 0016: a household with its settings row, a budget and its time zone.
    const dir = join(mkdtempSync(join(tmpdir(), 'philobiblos-mig-')), 'drizzle');
    cpSync(drizzleDir, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    const before = journal.entries.findIndex((e) => e.tag === '0016_household_money');
    expect(before).toBeGreaterThan(0);
    writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, before) }));
    const client = new Database(':memory:');
    client.pragma('foreign_keys = ON');
    const db = drizzle(client);
    migrate(db, { migrationsFolder: dir });
    client.prepare(`INSERT INTO household_settings (id, budget_min_c, budget_max_c, timezone, ai_provider) VALUES (1, 12000, 18000, 'America/New_York', 'none')`).run();
    migrate(db, { migrationsFolder: drizzleDir });
    expect(client.prepare('SELECT budget_min_c, budget_max_c, timezone, ai_provider, currency, unknown_price_c FROM household_settings').all()).toEqual([
      { budget_min_c: 12000, budget_max_c: 18000, timezone: 'America/New_York', ai_provider: 'none', currency: 'CHF', unknown_price_c: 2500 },
    ]);
    // The database's own rules hold the currency to a code's shape and the unknown price to any amount's range.
    for (const bad of [`currency = 'chf'`, `currency = 'EURO'`, `currency = ''`, 'unknown_price_c = -1', 'unknown_price_c = 1000000000001']) {
      expect(() => client.prepare(`UPDATE household_settings SET ${bad}`).run(), bad).toThrow(/CHECK/);
    }
    // A database made new has no settings row until the first start, which gives it its currency (or none).
    expect(openDb(':memory:').$client.prepare('SELECT count(*) AS n FROM household_settings').get()).toEqual({ n: 0 });
  });
  it('a household from before its own price limits scores as it did: 40 and 60 of its currency, followed or its own (philobiblos#40)', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'philobiblos-mig-')), 'drizzle');
    cpSync(drizzleDir, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    const before = journal.entries.findIndex((e) => e.tag === '0022_household_price_limits');
    expect(before).toBeGreaterThan(0);
    writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, before) }));
    const run = (unknown: number) => {
      const client = new Database(':memory:');
      client.pragma('foreign_keys = ON');
      const db = drizzle(client);
      migrate(db, { migrationsFolder: dir });
      client.prepare(`INSERT INTO household_settings (id, currency, unknown_price_c) VALUES (1, 'EUR', ?)`).run(unknown);
      migrate(db, { migrationsFolder: drizzleDir });
      return client.prepare('SELECT unknown_price_c, price_high_c, price_max_c FROM household_settings').get();
    };
    // At 25 the limits that follow it are 40 and 60: it follows, as a new household does.
    expect(run(2500)).toEqual({ unknown_price_c: 2500, price_high_c: null, price_max_c: null });
    // At any other, its limits of 40 and 60 become its own.
    expect(run(3000)).toEqual({ unknown_price_c: 3000, price_high_c: 4000, price_max_c: 6000 });
    expect(run(0)).toEqual({ unknown_price_c: 0, price_high_c: 4000, price_max_c: 6000 });
  });
  it('prices learnt before philobiblos#53 are repaired: each invoice row is the latest invoice\'s price and day, a free row goes (philobiblos#53)', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'philobiblos-mig-')), 'drizzle');
    cpSync(drizzleDir, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    const before = journal.entries.findIndex((e) => e.tag === '0019_invoice_price_day');
    expect(before).toBeGreaterThan(0);
    writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, before) }));
    const client = new Database(':memory:');
    client.pragma('foreign_keys = ON');
    const db = drizzle(client);
    migrate(db, { migrationsFolder: dir });
    const book = client.prepare(`INSERT INTO book (id, title, authors_json, audience, norm_key, created_at) VALUES (?, ?, '[]', 'adult', ?, '2026-01-01T00:00:00.000Z')`);
    for (const id of ['free', 'older', 'ahead', 'none', 'order', 'tap', 'tie', 'quoted']) book.run(id, id, id);
    const copy = client.prepare('INSERT INTO copy (id, book_id, source, price_c, acquired_at) VALUES (?, ?, ?, ?, ?)');
    const offer = client.prepare('INSERT INTO book_offer (book_id, source, price_c, seen_at) VALUES (?, ?, ?, ?)');
    // A free line (0) read after the real price overwrote it.
    copy.run('c1', 'free', 'invoice', 1990, '2026-11-01T08:00:00.000Z');
    copy.run('c2', 'free', 'invoice', 0, '2026-11-12T08:00:00.000Z');
    offer.run('free', 'invoice', 0, '2026-11-12T09:00:00.000Z');
    // An old invoice's line decided in the Inbox after a newer typed invoice: its price overwrote the newer one.
    copy.run('c3', 'older', 'manual', 1500, '2026-11-12T00:00:00.000Z');
    copy.run('c4', 'older', 'invoice', 1400, '2026-10-01T08:00:00.000Z');
    offer.run('older', 'invoice', 1400, '2026-11-20T14:00:00.000Z');
    // A mail misdated ahead: its day is never later than when it was read.
    copy.run('c5', 'ahead', 'invoice', 1600, '2027-06-01T00:00:00.000Z');
    offer.run('ahead', 'invoice', 1600, '2026-11-16T10:00:00.000Z');
    // Only free copies: no price learnt.
    copy.run('c6', 'none', 'invoice', 0, '2026-11-03T08:00:00.000Z');
    offer.run('none', 'invoice', 0, '2026-11-03T09:00:00.000Z');
    // A copy of another source (an order's, the seed's) is no invoice.
    copy.run('c7', 'order', 'invoice', 1200, '2026-11-01T08:00:00.000Z');
    copy.run('c8', 'order', 'order', 2500, '2026-11-20T08:00:00.000Z');
    copy.run('c9', 'order', 'seed', 2600, '2026-11-21T08:00:00.000Z');
    offer.run('order', 'invoice', 1200, '2026-11-01T09:00:00.000Z');
    // A tap's copy (priced as quoted) is no invoice either, while the tap holds it.
    client.prepare(`INSERT INTO person (id, name, role) VALUES ('p', 'P', 'adult')`).run();
    client.prepare(`INSERT INTO "order" (id, month, status, created_at) VALUES ('o', '2026-11', 'quoted', '2026-11-01T00:00:00.000Z')`).run();
    copy.run('c10', 'tap', 'invoice', 1100, '2026-11-02T08:00:00.000Z');
    copy.run('c11', 'tap', 'manual', 1300, '2026-11-22T08:00:00.000Z');
    client.prepare(`INSERT INTO order_line (order_id, book_id, for_person, state, quoted_c, copy_id, tapped_from) VALUES ('o', 'tap', 'p', 'delivered', 1300, 'c11', 'quoted')`).run();
    offer.run('tap', 'invoice', 1100, '2026-11-02T09:00:00.000Z');
    // Two copies of the same day: the one written last (an invoice's copies are written in its order).
    copy.run('c12', 'tie', 'invoice', 1700, '2026-11-05T08:00:00.000Z');
    copy.run('c13', 'tie', 'manual', 1750, '2026-11-05T08:00:00.000Z');
    offer.run('tie', 'invoice', 1700, '2026-11-05T09:00:00.000Z');
    // Quotes: a free one goes, a priced one stays as it was.
    offer.run('quoted', 'quote', 0, '2026-11-14T10:00:00.000Z');
    offer.run('older', 'quote', 1450, '2026-11-14T10:00:00.000Z');
    migrate(db, { migrationsFolder: drizzleDir });
    expect(client.prepare('SELECT book_id, source, price_c, seen_at FROM book_offer ORDER BY book_id, source').all()).toEqual([
      { book_id: 'ahead', source: 'invoice', price_c: 1600, seen_at: '2026-11-16T00:00:00.000Z' },
      { book_id: 'free', source: 'invoice', price_c: 1990, seen_at: '2026-11-01T00:00:00.000Z' },
      { book_id: 'older', source: 'invoice', price_c: 1500, seen_at: '2026-11-12T00:00:00.000Z' },
      { book_id: 'older', source: 'quote', price_c: 1450, seen_at: '2026-11-14T10:00:00.000Z' },
      { book_id: 'order', source: 'invoice', price_c: 1200, seen_at: '2026-11-01T00:00:00.000Z' },
      { book_id: 'tap', source: 'invoice', price_c: 1100, seen_at: '2026-11-02T00:00:00.000Z' },
      { book_id: 'tie', source: 'invoice', price_c: 1750, seen_at: '2026-11-05T00:00:00.000Z' },
    ]);
  });

  it('a book\'s isbn13 is 13 digits beginning 978 or 979, or none: a stored one of any other shape is dropped, the book kept (philobiblos#59)', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'philobiblos-mig-')), 'drizzle');
    cpSync(drizzleDir, dir, { recursive: true });
    const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
    const before = journal.entries.findIndex((e) => e.tag === '0021_book_isbn13_shape');
    expect(before).toBeGreaterThan(0);
    writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, before) }));
    const client = new Database(':memory:');
    client.pragma('foreign_keys = ON');
    const db = drizzle(client);
    migrate(db, { migrationsFolder: dir });
    const book = client.prepare(`INSERT INTO book (id, title, authors_json, isbn13, audience, norm_key, created_at) VALUES (?, ?, '[]', ?, 'adult', ?, '2026-01-01T00:00:00.000Z')`);
    const stored: [string, string | null][] = [['ok', '9780000000002'], ['ok979', '9791234567896'], ['query', '9780000000019&x=1'], ['short', '12345'], ['spaced', ' 9780000000026'], ['none', null]];
    for (const [id, isbn] of stored) book.run(id, id, isbn, id);
    client.prepare(`INSERT INTO book_offer (book_id, source, price_c, seen_at) VALUES ('query', 'seed', 1990, '2026-11-01T00:00:00.000Z')`).run();
    migrate(db, { migrationsFolder: drizzleDir });
    expect(client.prepare('SELECT id, isbn13 FROM book ORDER BY id').all()).toEqual([
      { id: 'none', isbn13: null }, { id: 'ok', isbn13: '9780000000002' }, { id: 'ok979', isbn13: '9791234567896' },
      { id: 'query', isbn13: null }, { id: 'short', isbn13: null }, { id: 'spaced', isbn13: null },
    ]);
    // Rows that point at a book are kept through the table's rebuild.
    expect(client.prepare('SELECT count(*) AS n FROM book_offer').get()).toEqual({ n: 1 });
    expect(client.pragma('foreign_key_check')).toEqual([]);
    for (const bad of ['9780000000002&x=1', '978000000000', '97800000000020', '1234567890123', '978000000000X']) {
      expect(() => book.run(`b-${bad}`, 'x', bad, 'x')).toThrow(/CHECK book\.isbn13/);
      expect(() => client.prepare('UPDATE book SET isbn13 = ? WHERE id = ?').run(bad, 'ok')).toThrow(/CHECK book\.isbn13/);
    }
  });
});
