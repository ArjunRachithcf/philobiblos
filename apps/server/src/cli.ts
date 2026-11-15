// `shelf recover <admin handle>` (ADR 0010): when an admin has lost every passkey, the person who runs Shelf's
// container writes a one-time link (24 hours) for that admin to enrol a new one. The link goes into
// SHELF_DATA_DIR/setup-link.txt (0600), never to the terminal or a log.
import { createRecoveryLink } from './auth/invites';
import { loadConfig } from './config';
import { openDb } from './db/open';

const [cmd, handle, ...rest] = process.argv.slice(2);
if (cmd !== 'recover' || !handle || rest.length) {
  console.error('usage: shelf recover <admin handle>');
  process.exit(2);
}
try {
  const cfg = loadConfig();
  const file = createRecoveryLink(openDb(cfg.dbFile), cfg, handle);
  console.log(`A one-time link for ${handle} (24 hours) is in ${file}. Open it on the new device; it is removed once used.`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
