// The media worker (ADR 0009) against hostile input: every file here is made by the test (nothing real, no binary
// fixtures). Jobs run as they do in production, each in a child process with its limits; the child is the TypeScript
// source through tsx.
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { MEDIA_LIMITS, SERVER_WAIT_MS, clampLimits, dirs, paths, prepareDirs, readResult, writeAtomic } from '@shelf/contracts/media';
// The server's marker check, run on the worker's real output (the server's tests never load sharp).
import { cleanJpeg } from '../../server/src/media/client';
import { LOADERS, loadSharp } from '../src/jobs';
import { recover, runChild, runPending, type WorkerOptions } from '../src/main';
import { sniff } from '../src/sniff';

// tsx by its full path: the child starts in the repository's root, where tsx is not installed
const child = { path: fileURLToPath(new URL('../src/child.ts', import.meta.url)), execArgv: ['--import', import.meta.resolve('tsx')] };
let root: string;
let o: WorkerOptions;
beforeAll(() => {
  process.env.SHELF_WORKER_TEST = '1';
  root = mkdtempSync(join(tmpdir(), 'shelf-worker-'));
  prepareDirs(root);
  o = { root, child };
});

let n = 0;
const ID = () => `01J${String(++n).padStart(23, '0')}`; // a well-formed ULID-like id
async function job(kind: string, input: Uint8Array, extra: Partial<WorkerOptions> = {}) {
  const id = ID();
  const inPath = join(root, `${id}.in`), outPath = join(root, `${id}.out`);
  writeFileSync(inPath, input);
  const r = await runChild({ ...o, ...extra }, kind, inPath, outPath, id);
  return { r, out: r.ok && r.kind === 'image.reencode' ? readFileSync(outPath) : null };
}

/** A PNG whose header claims width × height; the pixel data is a token (the header alone must refuse it). */
function pngHeader(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(64))), chunk('IEND', Buffer.alloc(0))]);
}

/** A small, valid PDF with these lines of text; `extra` adds objects to the catalog (e.g. a JavaScript action). */
function pdf(lines: string[], extra = ''): Buffer {
  const text = lines.map((l, i) => `BT /F1 12 Tf 50 ${750 - i * 20} Td (${l.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`).join('\n');
  const objs = [
    `<< /Type /Catalog /Pages 2 0 R ${extra} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((b, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${b}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((x) => `${String(x).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('what a file is: its bytes, never its name', () => {
  it.each([
    [[0xff, 0xd8, 0xff, 0xe0], 'jpeg'], [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'png'], [[...Buffer.from('GIF89a')], 'gif'],
    [[...Buffer.from('RIFF\0\0\0\0WEBP')], 'webp'], [[...Buffer.from('%PDF-1.7')], 'pdf'], [[...Buffer.from('<svg>')], 'unknown'], [[], 'unknown'],
  ])('%j → %s', (bytes, want) => expect(sniff(Uint8Array.from(bytes))).toBe(want));
});

describe('images: decoded within limits, metadata gone, a fresh JPEG', () => {
  it('re-encodes, scales the long side to 2048, and keeps no EXIF, ICC or XMP', async () => {
    const src = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#2a6' } })
      .withExif({ IFD0: { Copyright: 'someone', ImageDescription: 'a secret place' } }).withIccProfile('p3').png().toBuffer();
    expect((await sharp(src).metadata()).exif).toBeDefined();
    const { r, out } = await job('image.reencode', src);
    expect(r).toMatchObject({ ok: true, width: 2048, height: 1024, format: 'jpeg' });
    const meta = await sharp(out!).metadata();
    expect([meta.format, meta.exif, meta.icc, meta.xmp]).toEqual(['jpeg', undefined, undefined, undefined]);
    expect(out!.includes(Buffer.from('a secret place'))).toBe(false);
  });

  it('a decompression bomb is refused from its header', async () => {
    expect((await job('image.reencode', pngHeader(50_000, 50_000))).r).toMatchObject({ ok: false, error: 'too_many_pixels' });
  });

  it.each([
    ['text called .jpg', Buffer.from('not an image at all')],
    ['an SVG (scripts, external references)', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>')],
    ['a PDF', pdf(['hello'])],
  ])('%s: not this type', async (_n, input) => {
    expect((await job('image.reencode', input)).r).toMatchObject({ ok: false, error: 'not_this_type' });
  });

  it('libvips itself refuses every format but the four, even past the sniffing', async () => {
    expect(LOADERS).toHaveLength(4);
    const s = await loadSharp();
    const tiff = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123' } }).tiff().toBuffer();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
    for (const b of [tiff, svg]) await expect(s(b).jpeg().toBuffer()).rejects.toThrow(/unsupported/);
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123' } }).png().toBuffer();
    await expect(s(png).jpeg().toBuffer()).resolves.toBeInstanceOf(Buffer);
  });

  it('a truncated JPEG is unreadable, not a crash', async () => {
    const good = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#a33' } }).jpeg().toBuffer();
    expect((await job('image.reencode', good.subarray(0, good.length >> 1))).r).toMatchObject({ ok: false, error: 'unreadable' });
  });

  it('too large is refused before decoding', async () => {
    const big = Buffer.alloc(MEDIA_LIMITS.maxInput['image.reencode'] + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect((await job('image.reencode', big)).r).toMatchObject({ ok: false, error: 'too_large' });
  });
});

describe('PDFs: text rows only, nothing runs', () => {
  it('gives back rows of text', async () => {
    const { r } = await job('pdf.text', pdf(['9780000000001  A Made-up Title  1 ST  19.90', 'Total CHF 19.90']));
    expect(r).toMatchObject({ ok: true, pages: 1, truncated: false });
    expect(r.ok && r.kind === 'pdf.text' && r.rows.map((x) => x.join(' '))).toEqual(['9780000000001 A Made-up Title 1 ST 19.90', 'Total CHF 19.90']);
  });

  it('a JavaScript action is never run; the text still comes back', async () => {
    const js = '/OpenAction << /S /JavaScript /JS (app.alert\\(1\\); this.submitForm\\("https://example.invalid/"\\);) >>';
    const { r } = await job('pdf.text', pdf(['Invoice line'], js));
    expect(r).toMatchObject({ ok: true });
  });

  it.each([
    ['malformed', Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 9 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF')],
    ['truncated', pdf(['cut short']).subarray(0, 120)],
  ])('%s: unreadable, not a crash', async (_n, input) => {
    expect((await job('pdf.text', input)).r).toMatchObject({ ok: false, error: 'unreadable' });
  });

  it('a JPEG sent as a PDF: not this type', async () => {
    expect((await job('pdf.text', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).r).toMatchObject({ ok: false, error: 'not_this_type' });
  });
});

describe('limits', () => {
  it('a job that never ends is killed at its time limit', async () => {
    const t = Date.now();
    expect((await job('test.spin', Buffer.from('x'), { timeoutMs: 1500 })).r).toMatchObject({ ok: false, error: 'timeout' });
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('a job that eats its heap dies of it, and says so', async () => {
    expect((await job('test.alloc', Buffer.from('x'), { heapMb: 64 })).r).toMatchObject({ ok: false, error: 'out_of_memory' });
  }, 30_000);

  it('the server cannot raise the limits: asked for more, it gets MEDIA_LIMITS', () => {
    expect(clampLimits({ timeoutMs: 60_000, heapMb: 4096 })).toEqual({ timeoutMs: MEDIA_LIMITS.timeoutMs, heapMb: MEDIA_LIMITS.heapMb });
    expect(clampLimits({ timeoutMs: Number.NaN, heapMb: -1 })).toEqual({ timeoutMs: MEDIA_LIMITS.timeoutMs, heapMb: MEDIA_LIMITS.heapMb });
    expect(clampLimits({ timeoutMs: 1000 })).toMatchObject({ timeoutMs: 1000 });
  });

  it('a job asked to run for 60 s is still killed at 20 s', async () => {
    const t = Date.now();
    expect((await job('test.spin', Buffer.from('x'), { timeoutMs: 60_000 })).r).toMatchObject({ ok: false, error: 'timeout' });
    expect(Date.now() - t).toBeLessThan(MEDIA_LIMITS.timeoutMs + 1500);
  }, 30_000);

  it('a child that answers and keeps running is killed with everything it started', async () => {
    const id = ID();
    const out = join(root, `${id}.out`);
    writeFileSync(join(root, `${id}.in`), 'x');
    await runChild(o, 'test.linger', join(root, `${id}.in`), out, id);
    const pids = readFileSync(out, 'utf8').split(' ').map(Number);
    expect(pids).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 300));
    for (const pid of pids) expect(running(pid), `pid ${pid}`).toBe(false);
  });
});

/** True while a process runs (a zombie waiting for its parent to reap it has stopped running). */
function running(pid: number): boolean {
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
}

describe('the job folder', () => {
  const drop = (id: string, input: Uint8Array, job: object) => {
    const p = paths(root, id);
    writeAtomic(p.input, input);
    writeAtomic(p.job, JSON.stringify(job));
    return p;
  };

  it('a job dropped as the server does comes back as a result; in/ is left as it was (the worker only reads it)', async () => {
    const id = ID();
    const p = drop(id, await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).png().toBuffer(), { id, kind: 'image.reencode', createdAt: new Date().toISOString() });
    const before = readdirSync(dirs(root).in).sort();
    expect(await runPending(o)).toBe(1);
    const r = readResult(root, id, 'image.reencode');
    expect(r).toMatchObject({ id, ok: true, width: 10, height: 10 });
    expect(readdirSync(dirs(root).in).sort()).toEqual(before);
    // The server's own marker check passes the worker's real output.
    expect(r?.ok && r.kind === 'image.reencode' && cleanJpeg(readFileSync(p.output), r.width, r.height)).toBe(true);
    // Claimed: it never runs twice.
    expect(await runPending(o)).toBe(0);
  });

  it('a job older than the server waits is not run', async () => {
    const id = ID();
    drop(id, Buffer.from('x'), { id, kind: 'image.reencode', createdAt: new Date(Date.now() - SERVER_WAIT_MS - 1000).toISOString() });
    await runPending(o);
    expect(readResult(root, id, 'image.reencode')).toEqual({ id, ok: false, error: 'timeout' });
  });

  it('an unknown kind, or a name the server would never make, runs nothing', async () => {
    const id = ID();
    drop(id, Buffer.from('x'), { id, kind: 'shell.exec', createdAt: new Date().toISOString() });
    writeFileSync(join(dirs(root).in, '..%2fescape.json'), '{}');
    await runPending(o);
    expect(readResult(root, id, 'image.reencode')).toMatchObject({ ok: false, error: 'not_this_type' });
    expect(readdirSync(dirs(root).out).some((f) => f.includes('escape'))).toBe(false);
  });

  it('after a restart, a job claimed but never finished fails rather than runs twice', () => {
    const id = ID();
    writeFileSync(paths(root, id).claim, '');
    recover(root);
    expect(readResult(root, id, 'pdf.text')).toEqual({ id, ok: false, error: 'failed' });
  });

  it('a result is read field by field: a forged or odd one counts as failed', () => {
    const id = ID();
    const put = (r: object) => writeAtomic(paths(root, id).result, JSON.stringify(r));
    put({ id, ok: true, kind: 'image.reencode', width: 99999, height: 1, format: 'jpeg', bytes: 1 });
    expect(readResult(root, id, 'image.reencode')).toEqual({ id, ok: false, error: 'failed' });
    put({ id, ok: false, error: 'rm -rf /' });
    expect(readResult(root, id, 'image.reencode')).toEqual({ id, ok: false, error: 'failed' });
    // A complete, valid result, but for another job.
    put({ id: ID(), ok: true, kind: 'image.reencode', width: 1, height: 1, format: 'jpeg', bytes: 1 });
    expect(readResult(root, id, 'image.reencode')).toEqual({ id, ok: false, error: 'failed' });
    // A complete, valid result of the other kind.
    put({ id, ok: true, kind: 'pdf.text', pages: 1, rows: [['x']], truncated: false });
    expect(readResult(root, id, 'image.reencode')).toEqual({ id, ok: false, error: 'failed' });
    expect(readResult(root, id, 'pdf.text')).toMatchObject({ ok: true, kind: 'pdf.text' });
  });
});
