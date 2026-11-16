// The server's side of the media worker (ADR 0009): hand a file to the worker and wait for plain data back. The
// server never decodes an image, a PDF or a video itself (an architecture test keeps sharp, pdfjs-dist and ffmpeg out
// of the server), and it reads what comes back as untrusted, as if the worker had been taken over by the file it read:
// every file through `readUntrusted` (no links, no FIFOs, a size cap), the result checked against the job's id and
// kind (`readResult`), and a returned image, or each of a video's frames, walked marker by marker (`cleanJpeg`) without
// decoding it.
//
// One job is in flight at a time, so in/ never holds anyone else's file for a compromised decoder to read; a few more
// may wait, and beyond that the answer is 'busy'.
import { rmSync } from 'node:fs';
import { ulid } from 'ulid';
import { MEDIA_LIMITS, serverWaitMs, checkDirs, paths, prepareDirs, readResult, readUntrusted, workerAlive, writeAtomic, type MediaKind, type MediaResult } from '@shelf/contracts/media';

export class MediaUnavailable extends Error {
  constructor() { super('media processing is unavailable: the media worker is not running'); }
}

/** A result, with the re-encoded image (image.reencode) or the frames, in order (video.frames). */
export type MediaOutcome = MediaResult & { image?: Buffer; images?: Buffer[] };

/** Jobs that may wait behind the one in flight. */
export const MAX_WAITING = 4;
let chain: Promise<unknown> = Promise.resolve();
/** The job in flight and those waiting behind it. */
let pending = 0;

const SEGMENTS = new Set([0xdb, 0xc0, 0xc2, 0xc4, 0xdd, 0xda]); // DQT, SOF0, SOF2, DHT, DRI, SOS

/**
 * A baseline or progressive JPEG with nothing but image data: SOI, then only DQT, SOF0/SOF2, DHT, DRI and SOS (with
 * its entropy-coded data) up to EOI, and nothing after it. No APPn (EXIF, XMP, ICC), no COM. The frame's size must be
 * the one reported. A compromised worker could otherwise hand back the original file, GPS and all.
 */
export function cleanJpeg(b: Buffer, width: number, height: number): boolean {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return false;
  let i = 2;
  let frame = false;
  while (i + 2 <= b.length) {
    if (b[i] !== 0xff) return false;
    const m = b[i + 1]!;
    if (m === 0xd9) return frame && i + 2 === b.length;
    if (!SEGMENTS.has(m) || i + 4 > b.length) return false;
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return false;
    if (m === 0xc0 || m === 0xc2) {
      if (frame || len < 8 || b.readUInt16BE(i + 5) !== height || b.readUInt16BE(i + 7) !== width) return false;
      frame = true;
    }
    i += 2 + len;
    if (m === 0xda) {
      if (!frame) return false;
      // Entropy-coded data, up to the next marker that is neither a stuffed byte (FF00) nor a restart (FFD0–FFD7).
      while (i + 1 < b.length && !(b[i] === 0xff && b[i + 1] !== 0x00 && !(b[i + 1]! >= 0xd0 && b[i + 1]! <= 0xd7))) i++;
    }
  }
  return false;
}

/**
 * Runs one job. `root` is SHELF_WORK_DIR (null: no worker here, e.g. HomersLab before it runs one: MediaUnavailable).
 * Waits a little longer than the worker's own time limit; a result that never comes is a timeout.
 */
export async function runMediaJob(root: string | null, kind: MediaKind, input: Uint8Array, o: { pollMs?: number; waitMs?: number } = {}): Promise<MediaOutcome> {
  if (!root || !workerAlive(root)) throw new MediaUnavailable();
  if (input.length > MEDIA_LIMITS.maxInput[kind]) return { id: '', ok: false, error: 'too_large' };
  if (pending > MAX_WAITING) return { id: '', ok: false, error: 'busy' };
  pending++;
  const run = chain.then(() => runOne(root, kind, input, o)).finally(() => { pending--; });
  chain = run.catch(() => undefined);
  return run;
}

async function runOne(root: string, kind: MediaKind, input: Uint8Array, o: { pollMs?: number; waitMs?: number }): Promise<MediaOutcome> {
  prepareDirs(root);
  const id = ulid();
  const p = paths(root, id);
  const until = Date.now() + Math.min(o.waitMs ?? serverWaitMs(kind), serverWaitMs(kind));
  try {
    writeAtomic(p.input, input);
    writeAtomic(p.job, JSON.stringify({ id, kind, createdAt: new Date().toISOString() }));
    for (;;) {
      // Every round: the worker must not have swapped a folder for a link.
      checkDirs(root);
      const r = readResult(root, id, kind);
      if (r) {
        if (!r.ok || r.kind === 'pdf.text') return r;
        if (r.kind === 'video.frames') {
          // The frames back to back, exactly the bytes the result names, each one a clean JPEG of its reported size.
          const all = readUntrusted(p.output, MEDIA_LIMITS.framesMax * MEDIA_LIMITS.frameMaxBytes);
          if (!Buffer.isBuffer(all) || all.length !== r.frames.reduce((k, f) => k + f.bytes, 0)) return { id, ok: false, error: 'failed' };
          const images: Buffer[] = [];
          let off = 0;
          for (const f of r.frames) {
            const b = all.subarray(off, (off += f.bytes));
            if (!cleanJpeg(b, f.width, f.height)) return { id, ok: false, error: 'failed' };
            images.push(Buffer.from(b));
          }
          return { ...r, images };
        }
        const image = readUntrusted(p.output, MEDIA_LIMITS.maxOutput);
        if (!Buffer.isBuffer(image) || image.length !== r.bytes || !cleanJpeg(image, r.width, r.height)) return { id, ok: false, error: 'failed' };
        return { ...r, image };
      }
      if (Date.now() > until) return { id, ok: false, error: 'timeout' };
      await new Promise((res) => setTimeout(res, o.pollMs ?? 100));
    }
  } finally {
    // Whatever happened, nothing of this job stays in the shared folder (rm removes a link, never what it points at;
    // something that is not a file is left for the worker's own clean-up).
    for (const f of [p.input, p.job, p.claim, p.result, p.output]) { try { rmSync(f, { force: true }); } catch { /* not a file */ } }
  }
}
