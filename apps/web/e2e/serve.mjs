// Starts the built server for the e2e tests on a fresh data folder (apps/web/.e2e-data-<port>, ignored by git).
// `node e2e/serve.mjs <port> [seed folder]`: with a seed folder, it is imported first (the sample seed, invented).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const port = process.argv[2] ?? '4173';
const seed = process.argv[3];
const data = fileURLToPath(new URL(`../.e2e-data-${port}/`, import.meta.url));
const keys = fileURLToPath(new URL(`../.e2e-data-${port}-keys/`, import.meta.url)); // apart from the data, as in a real install
for (const d of [data, keys]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); }
const serverDir = fileURLToPath(new URL('../../server/', import.meta.url));
const env = {
  ...process.env,
  PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_PORT: port, PHILOBIBLOS_HOST: '127.0.0.1', PHILOBIBLOS_ORIGIN: `http://localhost:${port}`,
  PHILOBIBLOS_DATA_DIR: data, PHILOBIBLOS_KEYS_DIR: keys, PHILOBIBLOS_WEB_DIR: fileURLToPath(new URL('../dist/', import.meta.url)),
  PHILOBIBLOS_MIGRATIONS_DIR: `${serverDir}drizzle/`,
};
// The seeded Philobiblos's mailbox signs in with XOAUTH2 (an invented client on .invalid names, which never resolve):
// its Settings card, the provider's return and the token endpoint's absence are tested; nothing reaches a provider.
if (seed) Object.assign(env, {
  PHILOBIBLOS_IMAP_HOST: 'imap.invalid', PHILOBIBLOS_IMAP_USER: 'shelf@example.org', PHILOBIBLOS_IMAP_AUTH: 'xoauth2',
  PHILOBIBLOS_IMAP_OAUTH_CLIENT_ID: 'e2e-client', PHILOBIBLOS_IMAP_OAUTH_AUTHORIZE_URL: 'https://auth.invalid/authorize',
  PHILOBIBLOS_IMAP_OAUTH_TOKEN_URL: 'https://auth.invalid/token', PHILOBIBLOS_IMAP_OAUTH_SCOPE: 'mail.read offline_access',
});
if (seed) {
  const r = spawnSync(`${serverDir}node_modules/.bin/tsx`, ['src/seed/cli.ts', fileURLToPath(new URL(`../../../${seed}`, import.meta.url))], { cwd: serverDir, env, stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const child = spawn(process.execPath, [`${serverDir}dist/main.js`], { stdio: 'inherit', env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
