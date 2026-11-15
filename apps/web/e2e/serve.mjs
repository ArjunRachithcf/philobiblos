// Starts the built server for the e2e tests on a fresh data folder (apps/web/.e2e-data, ignored by git).
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const data = fileURLToPath(new URL('../.e2e-data/', import.meta.url));
rmSync(data, { recursive: true, force: true });
mkdirSync(data, { recursive: true });
const server = fileURLToPath(new URL('../../server/dist/main.js', import.meta.url));
const child = spawn(process.execPath, [server], {
  stdio: 'inherit',
  env: {
    ...process.env,
    SHELF_MODE: 'standalone', SHELF_PORT: '4173', SHELF_HOST: '127.0.0.1', SHELF_ORIGIN: 'http://localhost:4173',
    SHELF_DATA_DIR: data, SHELF_WEB_DIR: fileURLToPath(new URL('../dist/', import.meta.url)),
    SHELF_MIGRATIONS_DIR: fileURLToPath(new URL('../../server/drizzle/', import.meta.url)),
  },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
