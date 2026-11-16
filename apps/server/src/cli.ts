// `shelf recover <admin handle>` (ADR 0010): when an admin has lost every passkey, the person who runs Shelf's
// container writes a one-time link (24 hours) for that admin to enrol a new one. The link goes into
// SHELF_DATA_DIR/setup-link.txt (0600), never to the terminal or a log.
// `shelf media-check [jobs]`: hands the media worker a tiny made-up image (that many times) and says whether it came
// back re-encoded (ADR 0009).
import { createRecoveryLink } from './auth/invites';
import { loadConfig } from './config';
import { openDb } from './db/open';
import { MediaUnavailable, runMediaJob } from './media/client';

// A 1×1 PNG, made for this check.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC', 'base64');

const [cmd, handle, ...rest] = process.argv.slice(2);
if (cmd === 'media-check' && (!handle || /^\d{1,3}$/.test(handle)) && !rest.length) {
  // `shelf media-check 50`: that many jobs in a row, each must come back (the smoke test's check that clean jobs
  // never make the worker restart).
  const times = Number(handle ?? 1);
  (async () => {
    for (let i = 0; i < times; i++) {
      const r = await runMediaJob(loadConfig().workDir, 'image.reencode', PNG);
      if (!r.ok) { console.log(`media worker: ${r.error} (job ${i + 1} of ${times})`); process.exit(1); }
    }
    console.log(`media worker: ok (image.reencode${times > 1 ? `, ${times} jobs` : ''})`);
    process.exit(0);
  })().catch((e) => { console.error(e instanceof MediaUnavailable ? e.message : 'media worker: failed'); process.exit(1); });
} else if (cmd !== 'recover' || !handle || rest.length) {
  console.error('usage: shelf recover <admin handle> | shelf media-check [jobs]');
  process.exit(2);
} else try {
  const cfg = loadConfig();
  const file = createRecoveryLink(openDb(cfg.dbFile), cfg, handle);
  console.log(`A one-time link for ${handle} (24 hours) is in ${file}. Open it on the new device; it is removed once used.`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
