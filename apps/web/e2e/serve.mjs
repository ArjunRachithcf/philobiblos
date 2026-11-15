// Starts the built server for the e2e tests on a fresh data folder (apps/web/.e2e-data-<port>, ignored by git).
// `node e2e/serve.mjs <port> [seed folder]`: with a seed folder, it is imported first (the sample seed, invented).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const port = process.argv[2] ?? '4173';
const seed = process.argv[3];
const data = fileURLToPath(new URL(`../.e2e-data-${port}/`, import.meta.url));
rmSync(data, { recursive: true, force: true });
mkdirSync(data, { recursive: true });
const serverDir = fileURLToPath(new URL('../../server/', import.meta.url));
const env = {
  ...process.env,
  SHELF_MODE: 'standalone', SHELF_PORT: port, SHELF_HOST: '127.0.0.1', SHELF_ORIGIN: `http://localhost:${port}`,
  SHELF_DATA_DIR: data, SHELF_WEB_DIR: fileURLToPath(new URL('../dist/', import.meta.url)),
  SHELF_MIGRATIONS_DIR: `${serverDir}drizzle/`,
};
if (seed) {
  const r = spawnSync(`${serverDir}node_modules/.bin/tsx`, ['src/seed/cli.ts', fileURLToPath(new URL(`../../../${seed}`, import.meta.url))], { cwd: serverDir, env, stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const child = spawn(process.execPath, [`${serverDir}dist/main.js`], { stdio: 'inherit', env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
