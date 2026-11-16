// pnpm seed [folder]: imports a seed folder into the database at PHILOBIBLOS_DATA_DIR. Without a folder: seed/ if it
// exists, else seed-sample/. Prints counts only (the seed is the household's private data).
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveEnv } from '@philobiblos/contracts/env';
import { loadConfig } from '../config';
import { openDb } from '../db/open';
import { importSeed } from './import';

function repoRoot(from: string): string {
  let d = from;
  while (!existsSync(join(d, 'pnpm-workspace.yaml'))) {
    const up = dirname(d);
    if (up === d) return from;
    d = up;
  }
  return d;
}

const cwd = process.env.INIT_CWD ?? process.cwd();
const root = repoRoot(cwd);
const arg = process.argv[2];
const dir = arg ? resolve(cwd, arg) : existsSync(join(root, 'seed')) ? join(root, 'seed') : join(root, 'seed-sample');
if (!existsSync(dir)) {
  console.error(`seed folder not found: ${dir}`);
  process.exit(1);
}
const env = resolveEnv();
const cfg = loadConfig({ ...env, PHILOBIBLOS_DATA_DIR: env.PHILOBIBLOS_DATA_DIR || join(root, 'data') });
const db = openDb(cfg.dbFile);
const counts = importSeed(db, dir);
console.log(JSON.stringify({ folder: dir.startsWith(root) ? dir.slice(root.length + 1) : dir, db: cfg.dbFile, ...counts }, null, 2));
db.$client.close();
