import { buildApp } from './app';
import { ensureSetupLink } from './auth/invites';
import { loadConfig } from './config';
import { openDb } from './db/open';

const cfg = loadConfig();
const db = openDb(cfg.dbFile); // creates and migrates the database
const { app } = await buildApp(cfg, db, { logger: true });
const setupFile = ensureSetupLink(db, cfg);
if (setupFile) app.log.warn(`Shelf needs its first admin: open the link in ${setupFile} (valid 24 hours, once)`);
await app.listen({ host: cfg.host, port: cfg.port });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
