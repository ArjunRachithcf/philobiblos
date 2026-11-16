// The server's side of the media worker (ADR 0009): hand a file to the worker and wait for plain data back. The
// server never decodes an image, a PDF or a video itself (an architecture test keeps sharp, pdfjs-dist and ffmpeg out
// of the server), and it reads what comes back as untrusted: the result is checked field by field
// (@shelf/contracts/media readResult) and the re-encoded image is checked to be a JPEG of the size reported.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { ulid } from 'ulid';
import { MEDIA_LIMITS, paths, readResult, workerAlive, writeAtomic, type MediaKind, type MediaResult } from '@shelf/contracts/media';

export class MediaUnavailable extends Error {
  constructor() { super('media processing is unavailable: the media worker is not running'); }
}

export type MediaOutcome = MediaResult & { image?: Buffer };

const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/**
 * Runs one job. `root` is SHELF_WORK_DIR (null: no worker here, e.g. HomersLab before it runs one: MediaUnavailable).
 * Waits a little longer than the worker's own time limit; a result that never comes is a timeout.
 */
export async function runMediaJob(root: string | null, kind: MediaKind, input: Uint8Array, o: { pollMs?: number; waitMs?: number } = {}): Promise<MediaOutcome> {
  if (!root || !workerAlive(root)) throw new MediaUnavailable();
  if (input.length > MEDIA_LIMITS.maxInput[kind]) return { id: '', ok: false, error: 'too_large' };
  const id = ulid();
  const p = paths(root, id);
  writeAtomic(root, p.input, input);
  writeAtomic(root, p.job, JSON.stringify({ id, kind, createdAt: new Date().toISOString() }));
  const until = Date.now() + (o.waitMs ?? MEDIA_LIMITS.timeoutMs + 10_000);
  try {
    for (;;) {
      const r = readResult(root, id);
      if (r) {
        if (!r.ok || r.kind !== 'image.reencode') return r;
        const image = existsSync(p.output) ? readFileSync(p.output) : null;
        if (!image || image.length !== r.bytes || !isJpeg(image)) return { id, ok: false, error: 'failed' };
        return { ...r, image };
      }
      if (Date.now() > until) return { id, ok: false, error: 'timeout' };
      await new Promise((res) => setTimeout(res, o.pollMs ?? 100));
    }
  } finally {
    // Whatever happened, nothing of this job stays in the shared folder.
    for (const f of [p.input, p.job, p.output]) rmSync(f, { force: true });
  }
}
