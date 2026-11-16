// Phone shares (ADR 0006, contracts/connectors.md "Phone share"): what a phone sends to the Inbox, a post's images with
// its link and caption, and their way through the media worker (ADR 0009).
//
// The server never decodes a shared file. It reads the bytes only to know their type (by magic number, never by name
// or the MIME type the phone claims), stages them in its own folder (data/incoming/<share>, 0700), and hands each to
// the media worker, which re-encodes an image to a fresh JPEG without metadata and turns a video into at most 30 such
// JPEGs, a frame every ~2 s. Only those JPEGs are kept (data/shares/<share>: NN.jpg, or NN-MM.jpg for a video's frames);
// the staged original is deleted as soon as the worker has answered, whatever it answered. A file the worker refuses
// counts as refused; a share whose files were all refused failed. Without a worker here (SHELF_WORK_DIR unset, as under
// HomersLab until it runs one) a share with files is refused (503) and nothing is staged; with one that is down for a
// while, the share waits, and gives up after a day.
//
// A share is its sharer's: only they see it (GET /shares/{id}, the Inbox); for anyone else it does not exist.
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { FastifyRequest } from 'fastify';
import type { components } from '@shelf/contracts/openapi';
import { videoContainer, writeAtomic } from '@shelf/contracts/media';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { MediaUnavailable, runMediaJob } from '../media/client';
import type { Outcome } from '../jobs/books';

type S = components['schemas'];
export type ShareRow = typeof t.share.$inferSelect;

/** Field limits, characters (contracts/openapi.yaml createShare). */
export const SHARE_FIELDS = { url: 2000, text: 5000, title: 300, note: 2000 } as const;
/** Shares a person may send in a window (the phone's Shortcut, a share sheet), then 429. */
export const SHARE_RATE = { max: 30, windowMs: 10 * 60_000 };
/** A share waits this long for a media worker that is down, then fails. */
export const SHARE_PATIENCE_MS = 24 * 3600_000;
/** A file's size by its type, and a whole share's, bytes (the multipart limit is the largest, SHARE_LIMITS in app.ts). */
export const SHARE_BYTES = { image: 20 * 1024 * 1024, video: 64 * 1024 * 1024, total: 100 * 1024 * 1024 } as const;
/** Staged files that belong to no waiting share are deleted after this. */
export const STAGED_MAX_AGE_MS = 3600_000;

export class ShareError extends Error {
  constructor(readonly status: 400 | 413 | 415 | 503, message: string) { super(message); }
}

/** The image type of a file, from its first bytes; null for anything else (a video, a HEIC, a PDF, a script). */
export function imageType(b: Uint8Array): 'jpeg' | 'png' | 'webp' | 'gif' | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif';
  return null;
}

/** What a shared file is, from its first bytes: an image or a video Shelf takes (videoContainer), or null. */
export function shareFileType(b: Uint8Array): 'image' | 'video' | null {
  return imageType(b) ? 'image' : videoContainer(b) ? 'video' : null;
}

/** Text as it may be kept: NFC, control characters gone (line breaks kept), trimmed, at most `max`; else 400. */
function cleanText(v: string, name: string, max: number): string | null {
  // eslint-disable-next-line no-control-regex
  const s = v.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '').trim();
  if (s.length > max) throw new ShareError(400, `${name}: up to ${max} characters`);
  return s || null;
}

/** A link is kept as text, never fetched (ADR 0006); only http(s), without credentials. */
function cleanUrl(v: string | null): string | null {
  if (!v) return null;
  let u: URL;
  try { u = new URL(v); } catch { throw new ShareError(400, 'url: a web address'); }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) throw new ShareError(400, 'url: an http(s) address without a user name');
  return u.href;
}

const staging = (dataDir: string, id: string) => join(dataDir, 'incoming', id);
const kept = (dataDir: string, id: string) => join(dataDir, 'shares', id);

/**
 * Reads a multipart share (fields url, text, title, note; files `media`) within the upload limits, stages its files
 * and records the share. Every part is read to its end, so a refusal never leaves a request half read; on any refusal
 * nothing is kept.
 */
export async function receiveShare(req: FastifyRequest, db: Db, o: { dataDir: string; workDir: string | null; personId: string; now?: Date }): Promise<ShareRow> {
  if (!req.isMultipart()) throw new ShareError(400, 'a share is multipart/form-data');
  const id = ulid();
  const dir = staging(o.dataDir, id);
  const fields: Partial<Record<keyof typeof SHARE_FIELDS, string>> = {};
  let files = 0, total = 0, problem: ShareError | null = null;
  try {
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        const name = part.fieldname as keyof typeof SHARE_FIELDS;
        if (name in SHARE_FIELDS && typeof part.value === 'string') fields[name] = part.value;
        continue;
      }
      if (part.fieldname !== 'media') { for await (const _ of part.file) { /* drain */ } problem ??= new ShareError(400, 'files go in the field "media"'); continue; }
      const n = files++;
      // Without a worker nothing is staged: the files are read to their end and the share refused.
      if (!o.workDir) { for await (const _ of part.file) { /* drain */ } problem ??= new ShareError(503, 'media processing is unavailable here: share the link and the caption without files'); continue; }
      // A share's files together within its limit: past it, the rest is read and dropped, never kept in memory.
      const chunks: Buffer[] = [];
      for await (const c of part.file) {
        total += (c as Buffer).length;
        if (total <= SHARE_BYTES.total && !problem) chunks.push(c as Buffer);
      }
      if (total > SHARE_BYTES.total) { problem ??= new ShareError(413, `a share's files: up to ${SHARE_BYTES.total / 1024 / 1024} MB together`); continue; }
      if (problem) continue;
      const bytes = Buffer.concat(chunks);
      const type = shareFileType(bytes);
      if (!type) { problem ??= new ShareError(415, 'only images (JPEG, PNG, WebP or GIF) and videos (MP4, MOV or WebM) are taken; convert a photo to JPEG first'); continue; }
      if (bytes.length > SHARE_BYTES[type]) { problem ??= new ShareError(413, `${type === 'image' ? 'an image' : 'a video'}: up to ${SHARE_BYTES[type] / 1024 / 1024} MB`); continue; }
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeAtomic(join(dir, `${String(n).padStart(2, '0')}.bin`), bytes, 0o600);
    }
    if (problem) throw problem;
    const url = cleanUrl(fields.url ? cleanText(fields.url, 'url', SHARE_FIELDS.url) : null);
    const caption = fields.text ? cleanText(fields.text, 'text', SHARE_FIELDS.text) : null;
    const title = fields.title ? cleanText(fields.title, 'title', SHARE_FIELDS.title) : null;
    const note = fields.note ? cleanText(fields.note, 'note', SHARE_FIELDS.note) : null;
    if (!url && !caption && !title && !note && !files) throw new ShareError(400, 'nothing to share: a link, a caption or images');
    const row: ShareRow = {
      id, personId: o.personId, url, note, title, caption, mediaJson: '[]', mediaTotal: files, mediaRefused: 0,
      // A share is done once its images are re-encoded and its videos' frames taken; the AI reads it then (ai/jobs.ts).
      status: files ? 'received' : 'done', foundJson: null, error: null, createdAt: (o.now ?? new Date()).toISOString(),
    };
    db.insert(t.share).values(row).run();
    return row;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** A kept JPEG: an image, or one of a video's frames (`at`: its offset in the video, seconds). */
interface Kept { path: string; width: number; height: number; at?: number }

/** How many of a share's files have something kept (a video's frames count as its one file). */
export function keptFiles(mediaJson: string): number {
  return new Set((JSON.parse(mediaJson) as Kept[]).map((k) => k.path.split('/').pop()!.slice(0, 2))).size;
}

/**
 * Hands staged files to the media worker, one share and one file at a time, until nothing waits. One runs at a time;
 * a kick while it runs makes it look again before it stops. When the worker is down it tries again a minute later.
 */
export class ShareProcessor {
  private running: Promise<Outcome> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly db: Db, private readonly o: { dataDir: string; workDir: string | null; media?: typeof runMediaJob; now?: () => Date; retryMs?: number; after?: () => void }) {}

  /** Starts a run unless one is going (which then looks again); resolves when the run ends. */
  kick(): Promise<Outcome> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      let out: Outcome;
      do { this.again = false; out = await this.runOnce(); } while (this.again);
      // Then the AI reads what the worker is done with (ai/jobs.ts), shares without files too.
      this.o.after?.();
      return out;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  close(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  private async runOnce(): Promise<Outcome> {
    const now = this.o.now ?? (() => new Date());
    const waiting = this.db.select().from(t.share).where(inArray(t.share.status, ['received', 'reading'])).orderBy(t.share.createdAt).all();
    this.sweep(now(), new Set(waiting.map((s) => s.id)));
    let done = 0, waitingNow = 0;
    for (const s of waiting) {
      const r = await this.one(s, now());
      if (r === 'unavailable') { waitingNow = waiting.length - done; break; }
      done++;
    }
    if (waitingNow && !this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.kick(); }, this.o.retryMs ?? 60_000);
      this.timer.unref();
    }
    return waitingNow
      ? { status: 'blocked', detail: `${done} shares read; ${waitingNow} wait for the media worker` }
      : { status: 'done', detail: `${done} shares read` };
  }

  /**
   * Staged files no waiting share owns (the server stopped between staging them and recording the share, say) are
   * deleted once they are an hour old: an upload in progress is younger.
   */
  private sweep(now: Date, waiting: Set<string>) {
    const root = join(this.o.dataDir, 'incoming');
    let names: string[];
    try { names = readdirSync(root); } catch { return; }
    for (const n of names) {
      if (waiting.has(n)) continue;
      try { if (now.getTime() - lstatSync(join(root, n)).mtimeMs > STAGED_MAX_AGE_MS) rmSync(join(root, n), { recursive: true, force: true }); } catch { /* gone already */ }
    }
  }

  private update(id: string, v: Partial<ShareRow>) { this.db.update(t.share).set(v).where(eq(t.share.id, id)).run(); }

  private async one(s: ShareRow, now: Date): Promise<'done' | 'unavailable'> {
    const dir = staging(this.o.dataDir, s.id);
    const media = this.o.media ?? runMediaJob;
    const keep: Kept[] = JSON.parse(s.mediaJson) as Kept[];
    let refused = s.mediaRefused;
    const finish = (error: string | null) => {
      rmSync(dir, { recursive: true, force: true });
      const failed = s.mediaTotal > 0 && keep.length === 0;
      const files = keptFiles(JSON.stringify(keep));
      this.update(s.id, { status: failed ? 'failed' : 'done', mediaJson: JSON.stringify(keep), mediaRefused: s.mediaTotal - files, error: failed ? (error ?? 'none of the images could be read') : null });
      return 'done' as const;
    };
    if (now.getTime() - Date.parse(s.createdAt) > SHARE_PATIENCE_MS) return finish('the media worker did not read it within a day');
    let names: string[];
    try { names = readdirSync(dir).filter((f) => /^\d{2}\.bin$/.test(f)).sort(); } catch { names = []; }
    if (s.status === 'received') this.update(s.id, { status: 'reading' });
    for (const f of names) {
      const path = join(dir, f);
      if (!lstatSync(path).isFile()) { rmSync(path, { force: true }); refused++; continue; }
      let r;
      const bytes = readFileSync(path);
      try { r = await media(this.o.workDir, videoContainer(bytes) ? 'video.frames' : 'image.reencode', bytes); } catch (e) {
        if (e instanceof MediaUnavailable) return 'unavailable';
        throw e;
      }
      // Busy (the queue is full): left staged for the next run.
      if (!r.ok && r.error === 'busy') return 'unavailable';
      const out = kept(this.o.dataDir, s.id);
      if (r.ok && r.kind === 'image.reencode' && r.image) {
        mkdirSync(out, { recursive: true, mode: 0o750 });
        const name = f.replace('.bin', '.jpg');
        writeAtomic(join(out, name), r.image);
        keep.push({ path: `shares/${s.id}/${name}`, width: r.width, height: r.height });
      } else if (r.ok && r.kind === 'video.frames' && r.images?.length === r.frames.length) {
        // A video: only its frames, each a JPEG the worker re-encoded; nothing of the video itself.
        mkdirSync(out, { recursive: true, mode: 0o750 });
        r.frames.forEach((fr, k) => {
          const name = f.replace('.bin', `-${String(k).padStart(2, '0')}.jpg`);
          writeAtomic(join(out, name), r.images![k]!);
          keep.push({ path: `shares/${s.id}/${name}`, width: fr.width, height: fr.height, at: fr.at });
        });
      } else refused++;
      // The original goes as soon as the worker has answered.
      rmSync(path, { force: true });
      this.update(s.id, { mediaJson: JSON.stringify(keep), mediaRefused: refused });
    }
    return finish(keptFiles(JSON.stringify(keep)) + refused < s.mediaTotal ? 'the files were lost before the media worker read them' : null);
  }
}

/** What GET /shares/{id} says of a share. */
export function shareView(r: ShareRow): S['Share'] {
  const keptN = keptFiles(r.mediaJson);
  return { id: r.id, status: r.status, progress: { done: Math.min(r.mediaTotal, keptN + r.mediaRefused), total: r.mediaTotal }, refused: r.mediaRefused, found: foundBooks(r).map(({ title, author }) => ({ title, author })), error: r.error };
}

/** The sharer's own share, or undefined (another adult's is not there for them). */
export function ownShare(db: Db, personId: string, id: string): ShareRow | undefined {
  return db.select().from(t.share).where(and(eq(t.share.id, id), eq(t.share.personId, personId))).get();
}

/** What the AI could read of a share, in Shelf's words for the Inbox; null when it read it all, or has not yet. */
export function shareAiNote(r: Pick<ShareRow, 'foundJson' | 'mediaJson'>): string | null {
  let o: unknown;
  try { o = JSON.parse(r.foundJson ?? 'null'); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  if (typeof x.unread === 'string') return 'The AI could not read this share; add its books by hand.';
  if (x.readFrom === 'caption' && keptFiles(r.mediaJson) > 0) return 'Read from its caption only: no vision model is set up for images.';
  return null;
}

/** The books the AI found in a share (contracts/ai/extract_titles.schema.json), as untrusted data: checked, bounded. */
export function foundBooks(r: Pick<ShareRow, 'foundJson'>): { title: string; author: string | null; offTheme: boolean }[] {
  let o: unknown;
  try { o = JSON.parse(r.foundJson ?? 'null'); } catch { return []; }
  const books = o && typeof o === 'object' && Array.isArray((o as { books?: unknown }).books) ? (o as { books: unknown[] }).books : [];
  return books.slice(0, 50).flatMap((b) => {
    if (!b || typeof b !== 'object') return [];
    const x = b as Record<string, unknown>;
    if (typeof x.title !== 'string' || !x.title.trim()) return [];
    return [{ title: x.title.trim().slice(0, 300), author: typeof x.author === 'string' && x.author.trim() ? x.author.trim().slice(0, 200) : null, offTheme: x.offTheme === true }];
  });
}
