// The media worker's protocol (ADR 0009): the server and the worker share nothing but a folder (SHELF_WORK_DIR).
// The server drops a job (its input file, then its description, each written to a temporary name and renamed, so the
// worker never sees half a file); the worker claims it by renaming, runs it in a child process with limits, and writes
// a result the same way. No code, no paths from outside and no network cross the folder: kinds are a fixed list,
// names are the job id the server made, and every result is checked again by the server (worker output came from
// hostile input). Pure: node:fs and node:path only, so both sides import it.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MEDIA_KINDS = ['image.reencode', 'pdf.text'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Limits every job runs under; the server cannot raise them (the worker clamps). */
export const MEDIA_LIMITS = {
  /** Input size, bytes: 20 MB a share file (contracts/connectors.md), 10 MB a PDF. */
  maxInput: { 'image.reencode': 20 * 1024 * 1024, 'pdf.text': 10 * 1024 * 1024 } as Record<MediaKind, number>,
  /** Decoded pixels at most (a decompression bomb is refused from its header). */
  maxPixels: 40_000_000,
  /** The longest side of a re-encoded image. */
  maxSide: 2048,
  pdfMaxPages: 50,
  /** Text a PDF may give back, characters. */
  pdfMaxText: 1_000_000,
  /** Wall clock per job, ms; the child is killed after it. */
  timeoutMs: 20_000,
  /** The child's JavaScript heap, MB (native memory is the container's limit). */
  heapMb: 256,
} as const;

export interface MediaJob { id: string; kind: MediaKind; createdAt: string }
export type MediaResult =
  | { id: string; ok: true; kind: 'image.reencode'; width: number; height: number; format: 'jpeg'; bytes: number }
  | { id: string; ok: true; kind: 'pdf.text'; pages: number; rows: string[][]; truncated: boolean }
  | { id: string; ok: false; error: MediaError };
/** Errors are a fixed vocabulary: nothing from the input is echoed back. */
export type MediaError = 'too_large' | 'not_this_type' | 'too_many_pixels' | 'unreadable' | 'timeout' | 'out_of_memory' | 'failed';

export const JOB_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/; // a ULID made by the server

/** The folder layout: in/ (new), run/ (claimed), out/ (results), tmp/ (being written). */
export function dirs(root: string) {
  const d = { in: join(root, 'in'), run: join(root, 'run'), out: join(root, 'out'), tmp: join(root, 'tmp'), alive: join(root, 'worker.alive') };
  for (const p of [d.in, d.run, d.out, d.tmp]) mkdirSync(p, { recursive: true });
  return d;
}

/** Writes a file so that a reader never sees it half written: a temporary name, then a rename. */
export function writeAtomic(root: string, path: string, data: string | Uint8Array): void {
  const tmp = join(dirs(root).tmp, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export const paths = (root: string, id: string) => {
  const d = dirs(root);
  return {
    input: join(d.in, `${id}.bin`), job: join(d.in, `${id}.json`),
    claimedInput: join(d.run, `${id}.bin`), claimedJob: join(d.run, `${id}.json`),
    result: join(d.out, `${id}.json`), output: join(d.out, `${id}.out`),
  };
};

/** The worker is alive when it touched its heartbeat in the last 10 s. */
export function workerAlive(root: string, now = Date.now()): boolean {
  const p = dirs(root).alive;
  return existsSync(p) && now - statSync(p).mtimeMs < 10_000;
}

/** A result as the worker wrote it, checked field by field; anything else counts as 'failed'. */
export function readResult(root: string, id: string): MediaResult | null {
  const p = paths(root, id);
  if (!existsSync(p.result)) return null;
  let r: unknown;
  try { r = JSON.parse(readFileSync(p.result, 'utf8')); } catch { return { id, ok: false, error: 'failed' }; }
  rmSync(p.result, { force: true });
  const o = r as Record<string, unknown>;
  const int = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
  if (o?.id !== id) return { id, ok: false, error: 'failed' };
  if (o.ok === false) {
    const errors: MediaError[] = ['too_large', 'not_this_type', 'too_many_pixels', 'unreadable', 'timeout', 'out_of_memory', 'failed'];
    return { id, ok: false, error: errors.includes(o.error as MediaError) ? (o.error as MediaError) : 'failed' };
  }
  if (o.kind === 'image.reencode' && o.format === 'jpeg' && int(o.width, MEDIA_LIMITS.maxSide) && int(o.height, MEDIA_LIMITS.maxSide) && int(o.bytes, 50 * 1024 * 1024)) {
    return { id, ok: true, kind: 'image.reencode', width: o.width as number, height: o.height as number, format: 'jpeg', bytes: o.bytes as number };
  }
  if (o.kind === 'pdf.text' && int(o.pages, MEDIA_LIMITS.pdfMaxPages) && Array.isArray(o.rows) && typeof o.truncated === 'boolean') {
    const rows = o.rows as unknown[];
    let n = 0;
    const ok = rows.every((row) => Array.isArray(row) && row.every((c) => typeof c === 'string' && (n += c.length) <= MEDIA_LIMITS.pdfMaxText));
    if (ok) return { id, ok: true, kind: 'pdf.text', pages: o.pages as number, rows: rows as string[][], truncated: o.truncated as boolean };
  }
  return { id, ok: false, error: 'failed' };
}
