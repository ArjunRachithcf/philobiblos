// The media worker's protocol (ADR 0009): the server and the worker share nothing but a folder (SHELF_WORK_DIR), and
// the folder is the boundary. A decoder exploit owns the worker, so nothing the worker writes is trusted:
//
// - in/ is the server's: it drops a job there (its input, then its description, each written to a fresh name and
//   renamed, so the worker never sees half a file). The worker only reads it: in docker-compose.yml it is mounted
//   read-only into the worker, which runs as another user.
// - out/ is the worker's: a claim, a result and an output file per job, and its heartbeat. The worker cannot replace
//   out/ itself (its parent is not the worker's), and the server opens every file in it without following links or
//   blocking (O_NOFOLLOW | O_NONBLOCK), takes regular files only and reads no more than a cap; the result is then
//   checked field by field against the job's id and kind.
//
// No code, no paths from outside and no network cross the folder: kinds are a fixed list, and names are the job id
// the server made. Pure: node:fs and node:path only, so both sides import it.
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const MEDIA_KINDS = ['image.reencode', 'pdf.text'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Limits every job runs under; the server cannot raise them (the worker clamps, `clampLimits`). */
export const MEDIA_LIMITS = {
  /** Input size, bytes: 20 MB a share file (contracts/connectors.md), 10 MB a PDF. */
  maxInput: { 'image.reencode': 20 * 1024 * 1024, 'pdf.text': 10 * 1024 * 1024 } as Record<MediaKind, number>,
  /** A re-encoded image, bytes: a 2048-pixel JPEG at quality 85 is far below this. */
  maxOutput: 8 * 1024 * 1024,
  /** A result file, bytes (a PDF's text with its JSON escapes fits). */
  maxResult: 8 * 1024 * 1024,
  /** Decoded pixels at most (a decompression bomb is refused from its header). */
  maxPixels: 40_000_000,
  /** The longest side of a re-encoded image. */
  maxSide: 2048,
  pdfMaxPages: 50,
  /** Text a PDF may give back: characters, rows and cells. */
  pdfMaxText: 1_000_000,
  pdfMaxRows: 20_000,
  pdfMaxCells: 100_000,
  /** Wall clock per job, ms; the child and its process group are killed after it. */
  timeoutMs: 20_000,
  /** The child's JavaScript heap, MB. Not ArrayBuffers or libvips' memory: the container's memory limit bounds those. */
  heapMb: 256,
} as const;

/** How long the server waits for a result; the worker skips a job older than this (nobody waits for it any more). */
export const SERVER_WAIT_MS = MEDIA_LIMITS.timeoutMs + 10_000;

/** The limits a caller asks for, never above MEDIA_LIMITS. */
export function clampLimits(o: { timeoutMs?: number; heapMb?: number }): { timeoutMs: number; heapMb: number } {
  const clamp = (v: number | undefined, max: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, max) : max);
  return { timeoutMs: clamp(o.timeoutMs, MEDIA_LIMITS.timeoutMs), heapMb: clamp(o.heapMb, MEDIA_LIMITS.heapMb) };
}

export interface MediaJob { id: string; kind: MediaKind; createdAt: string }
export type MediaResult =
  | { id: string; ok: true; kind: 'image.reencode'; width: number; height: number; format: 'jpeg'; bytes: number }
  | { id: string; ok: true; kind: 'pdf.text'; pages: number; rows: string[][]; truncated: boolean }
  | { id: string; ok: false; error: MediaError };
/** Errors are a fixed vocabulary: nothing from the input is echoed back. 'busy' is the server's own (too many waiting). */
export type MediaError = 'too_large' | 'not_this_type' | 'too_many_pixels' | 'unreadable' | 'timeout' | 'out_of_memory' | 'failed' | 'busy';
const WORKER_ERRORS: readonly MediaError[] = ['too_large', 'not_this_type', 'too_many_pixels', 'unreadable', 'timeout', 'out_of_memory', 'failed'];

export const JOB_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/; // a ULID made by the server

/** The folder layout. Only the server creates it (`prepareDirs`); the worker finds it made. */
export function dirs(root: string) {
  return { root, in: join(root, 'in'), out: join(root, 'out'), alive: join(root, 'out', 'alive') };
}

/**
 * The server's side: in/ for Shelf's user (the worker shares its group, never its user, and reads in/ through a
 * read-only mount), out/ writable by the group so the worker can write its results there and the server can remove
 * them. Throws if any of the three is not a real directory (a link planted in its place, say).
 */
export function prepareDirs(root: string) {
  const d = dirs(root);
  mkdirSync(d.in, { recursive: true, mode: 0o750 });
  mkdirSync(d.out, { recursive: true, mode: 0o770 });
  checkDirs(root);
  // The modes exactly (mkdir's are cut by the umask); setgid on out/, so what the worker writes stays in the group.
  chmodSync(d.in, 0o750);
  chmodSync(d.out, 0o2770);
  return d;
}

export function checkDirs(root: string): void {
  const d = dirs(root);
  for (const p of [d.root, d.in, d.out]) {
    const s = lstatSync(p);
    if (!s.isDirectory()) throw new Error(`the media folder ${p} is not a directory`);
  }
}

/**
 * Writes a file so that a reader never sees it half written: a fresh name in the same folder (created, never opened
 * if anything is there, never through a link), then a rename, which replaces a name and never follows one.
 */
export function writeAtomic(path: string, data: string | Uint8Array, mode = 0o640): void {
  const tmp = join(path, '..', `.w-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    const b = typeof data === 'string' ? Buffer.from(data) : data;
    for (let off = 0; off < b.length;) off += writeSync(fd, b, off);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
}

export const paths = (root: string, id: string) => {
  const d = dirs(root);
  return {
    input: join(d.in, `${id}.bin`), job: join(d.in, `${id}.json`),
    claim: join(d.out, `${id}.claim`), result: join(d.out, `${id}.json`), output: join(d.out, `${id}.out`),
  };
};

/**
 * Reads a file the worker wrote, as untrusted: never through a link, never blocking (a FIFO), a regular file only, and
 * at most `max` bytes. null: not there (yet). 'refused': there, but a link, not a regular file, or too large.
 */
export function readUntrusted(path: string, max: number): Buffer | null | 'refused' {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'refused';
  }
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.size > max) return 'refused';
    // One byte more than the size: a file that grows while it is read counts as changed, and is refused.
    const buf = Buffer.alloc(s.size + 1);
    let n = 0;
    for (let k; n < buf.length && (k = readSync(fd, buf, n, buf.length - n, n)) > 0;) n += k;
    return n !== s.size ? 'refused' : buf.subarray(0, n);
  } catch {
    return 'refused';
  } finally { closeSync(fd); }
}

/** The worker is alive when it touched its heartbeat in the last 10 s (a link or anything but a file is not alive). */
export function workerAlive(root: string, now = Date.now()): boolean {
  try {
    const s = lstatSync(dirs(root).alive);
    return s.isFile() && now - s.mtimeMs < 10_000;
  } catch { return false; }
}

/** A result as the worker wrote it, checked field by field against the job's id and kind; anything else is 'failed'. */
export function readResult(root: string, id: string, kind: MediaKind): MediaResult | null {
  const raw = readUntrusted(paths(root, id).result, MEDIA_LIMITS.maxResult);
  if (raw === null) return null;
  const failed: MediaResult = { id, ok: false, error: 'failed' };
  if (raw === 'refused') return failed;
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; } catch { return failed; }
  if (!o || typeof o !== 'object' || o.id !== id) return failed;
  const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
  if (o.ok === false) return { id, ok: false, error: WORKER_ERRORS.includes(o.error as MediaError) ? (o.error as MediaError) : 'failed' };
  if (o.ok !== true || o.kind !== kind) return failed;
  if (kind === 'image.reencode' && o.format === 'jpeg' && int(o.width, 1, MEDIA_LIMITS.maxSide) && int(o.height, 1, MEDIA_LIMITS.maxSide) && int(o.bytes, 1, MEDIA_LIMITS.maxOutput)) {
    return { id, ok: true, kind, width: o.width as number, height: o.height as number, format: 'jpeg', bytes: o.bytes as number };
  }
  if (kind === 'pdf.text' && int(o.pages, 0, MEDIA_LIMITS.pdfMaxPages) && Array.isArray(o.rows) && o.rows.length <= MEDIA_LIMITS.pdfMaxRows && typeof o.truncated === 'boolean') {
    const rows = o.rows as unknown[];
    let chars = 0, cells = 0;
    const ok = rows.every((row) => Array.isArray(row) && row.length > 0 && (cells += row.length) <= MEDIA_LIMITS.pdfMaxCells
      && row.every((c) => typeof c === 'string' && (chars += c.length) <= MEDIA_LIMITS.pdfMaxText));
    if (ok) return { id, ok: true, kind, pages: o.pages as number, rows: rows as string[][], truncated: o.truncated };
  }
  return failed;
}
