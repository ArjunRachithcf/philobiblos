// The server's side of the media worker (ADR 0009): it hands files over and reads back plain data, checking what comes
// back as if the worker had been taken over by the file it read. A stand-in worker plays that compromised worker here:
// the real one has its own tests (apps/worker), and the server's tests must not load sharp or pdfjs-dist. An
// architecture test keeps those out of the server for good.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MEDIA_LIMITS, dirs, paths, prepareDirs, readResult, readUntrusted, writeAtomic } from '@shelf/contracts/media';
import { MAX_WAITING, MediaUnavailable, cleanJpeg, runMediaJob } from '../src/media/client';

/** A JPEG of only the segments a fresh encode has (the payloads are filler: the check walks markers, never decodes). */
function jpeg(o: { width?: number; height?: number; app1?: boolean; com?: boolean; trailer?: Buffer } = {}): Buffer {
  const seg = (m: number, body: Buffer) => { const h = Buffer.alloc(4); h[0] = 0xff; h[1] = m; h.writeUInt16BE(body.length + 2, 2); return Buffer.concat([h, body]); };
  const sof = Buffer.alloc(15); sof[0] = 8; sof.writeUInt16BE(o.height ?? 1, 1); sof.writeUInt16BE(o.width ?? 2, 3); sof[5] = 3;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...(o.app1 ? [seg(0xe1, Buffer.from('Exif\0\0GPS 47.37N 8.54E'))] : []),
    ...(o.com ? [seg(0xfe, Buffer.from('a comment'))] : []),
    seg(0xdb, Buffer.alloc(65)), seg(0xc0, sof), seg(0xc4, Buffer.alloc(30)), seg(0xda, Buffer.alloc(10)),
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]), // entropy data with a stuffed byte and a restart marker
    Buffer.from([0xff, 0xd9]), o.trailer ?? Buffer.alloc(0),
  ]);
}
const JPEG = jpeg();
const imageResult = (id: string, bytes = JPEG.length) => ({ id, ok: true, kind: 'image.reencode', width: 2, height: 1, format: 'jpeg', bytes });

/**
 * A stand-in for a compromised worker: for every job it finds, `answer` may plant anything in out/ (it gets the job's
 * paths); a plain answer is written as the result, with an output file if given.
 */
function fakeWorker(root: string, answer: (id: string, p: ReturnType<typeof paths>) => { result?: object | string; output?: Buffer } | null | void) {
  const d = prepareDirs(root);
  writeFileSync(d.alive, '');
  const seen = new Set<string>();
  const timer = setInterval(() => {
    utimesSync(d.alive, new Date(), new Date());
    for (const f of readdirSync(d.in).filter((x) => x.endsWith('.json'))) {
      const id = f.slice(0, -5);
      if (seen.has(id)) continue;
      seen.add(id);
      const p = paths(root, id);
      const a = answer(id, p);
      if (!a) continue;
      if (a.output) writeFileSync(p.output, a.output);
      if (a.result) writeAtomic(p.result, typeof a.result === 'string' ? a.result : JSON.stringify(a.result));
    }
  }, 10);
  return () => clearInterval(timer);
}

const tmp = () => mkdtempSync(join(tmpdir(), 'shelf-media-'));
async function withWorker<T>(answer: Parameters<typeof fakeWorker>[1], f: (root: string) => Promise<T>): Promise<T> {
  const root = tmp();
  const stop = fakeWorker(root, answer);
  try { return await f(root); } finally { stop(); }
}

describe('the media client', () => {
  it('without a worker (no folder, or no heartbeat, or a heartbeat that is a link): unavailable, never processed here', async () => {
    await expect(runMediaJob(null, 'image.reencode', JPEG)).rejects.toThrow(MediaUnavailable);
    const root = tmp();
    await expect(runMediaJob(root, 'image.reencode', JPEG)).rejects.toThrow(MediaUnavailable);
    const d = prepareDirs(root);
    writeFileSync(d.alive, '');
    utimesSync(d.alive, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await expect(runMediaJob(root, 'image.reencode', JPEG)).rejects.toThrow(MediaUnavailable);
    const elsewhere = join(tmp(), 'fresh'); writeFileSync(elsewhere, '');
    renameSync(d.alive, join(root, 'old')); symlinkSync(elsewhere, d.alive);
    await expect(runMediaJob(root, 'image.reencode', JPEG)).rejects.toThrow(MediaUnavailable);
  });

  it('hands the job over and takes the image back; nothing of the job stays', async () => {
    await withWorker((id, p) => { writeFileSync(p.claim, ''); return { result: imageResult(id), output: JPEG }; }, async (root) => {
      const r = await runMediaJob(root, 'image.reencode', Buffer.from('input'), { pollMs: 10 });
      expect(r).toMatchObject({ ok: true, width: 2, height: 1 });
      expect(r.image).toEqual(JPEG);
      const d = dirs(root);
      expect([...readdirSync(d.in), ...readdirSync(d.out).filter((f) => f !== 'alive')]).toEqual([]);
    });
  });

  it.each([
    ['an image that is not a JPEG', (id: string) => ({ result: imageResult(id, 5), output: Buffer.from('<svg>') })],
    ['an image of another length than reported', (id: string) => ({ result: imageResult(id, 999), output: JPEG })],
    ['no image at all', (id: string) => ({ result: imageResult(id) })],
    ['a complete, valid result for another job', () => ({ result: imageResult('01JZZZZZZZZZZZZZZZZZZZZZZZ'), output: JPEG })],
    ['a valid result of the other kind (PDF text for an image job)', (id: string) => ({ result: { id, ok: true, kind: 'pdf.text', pages: 1, rows: [['x']], truncated: false } })],
    ['the original back, EXIF and GPS included', (id: string) => { const b = jpeg({ app1: true }); return { result: imageResult(id, b.length), output: b }; }],
    ['a comment segment', (id: string) => { const b = jpeg({ com: true }); return { result: imageResult(id, b.length), output: b }; }],
    ['something after the end of the image', (id: string) => { const b = jpeg({ trailer: Buffer.from('<html><script>x()</script>') }); return { result: imageResult(id, b.length), output: b }; }],
    ['a frame of another size than reported', (id: string) => { const b = jpeg({ width: 3 }); return { result: imageResult(id, b.length), output: b }; }],
    ['not JSON', () => ({ result: '{"id": ' })],
  ])('%s: failed', async (_n, answer) => {
    await withWorker(answer, async (root) => expect(await runMediaJob(root, 'image.reencode', Buffer.from('x'), { pollMs: 10 })).toMatchObject({ ok: false, error: 'failed' }));
  });

  // A video's frames: JPEGs back to back in one output file, their sizes and offsets in the result.
  const frame = (w: number) => jpeg({ width: w });
  const videoResult = (id: string, fs: Buffer[], over: (f: object, k: number) => object = (f) => f) =>
    ({ id, ok: true, kind: 'video.frames', frames: fs.map((b, k) => over({ width: b.readUInt16BE(b.indexOf(Buffer.from([0xff, 0xc0])) + 7), height: 1, bytes: b.length, at: k * 2 }, k)) });

  it('a video: its frames come back one by one, each walked as an image is', async () => {
    const fs = [frame(2), frame(3), frame(4)];
    await withWorker((id) => ({ result: videoResult(id, fs), output: Buffer.concat(fs) }), async (root) => {
      const r = await runMediaJob(root, 'video.frames', Buffer.from('video'), { pollMs: 10 });
      expect(r).toMatchObject({ ok: true, kind: 'video.frames', frames: [{ at: 0, width: 2 }, { at: 2, width: 3 }, { at: 4, width: 4 }] });
      expect(r.images).toEqual(fs);
    });
  });

  it.each([
    ['one frame with EXIF in it', (id: string) => { const fs = [frame(2), jpeg({ app1: true })]; return { result: videoResult(id, fs), output: Buffer.concat(fs) }; }],
    ['frames of other lengths than reported', (id: string) => { const fs = [frame(2), frame(3)]; return { result: videoResult(id, fs, (f, k) => ({ ...f, bytes: (f as { bytes: number }).bytes + (k ? -1 : 1) })), output: Buffer.concat(fs) }; }],
    ['more bytes than the frames', (id: string) => { const fs = [frame(2)]; return { result: videoResult(id, fs), output: Buffer.concat([...fs, Buffer.from('the original video')]) }; }],
    ['a frame of another size than reported', (id: string) => { const fs = [frame(2)]; return { result: videoResult(id, fs, (f) => ({ ...f, width: 9 })), output: Buffer.concat(fs) }; }],
    ['offsets out of order', (id: string) => { const fs = [frame(2), frame(2)]; return { result: videoResult(id, fs, (f) => ({ ...f, at: 0 })), output: Buffer.concat(fs) }; }],
    ['an offset past the longest video', (id: string) => { const fs = [frame(2)]; return { result: videoResult(id, fs, (f) => ({ ...f, at: 181 })), output: Buffer.concat(fs) }; }],
    ['31 frames', (id: string) => { const fs = Array.from({ length: 31 }, () => frame(2)); return { result: videoResult(id, fs), output: Buffer.concat(fs) }; }],
    ['no frames', (id: string) => ({ result: { id, ok: true, kind: 'video.frames', frames: [] }, output: Buffer.alloc(0) })],
    ['a frame over 1280 pixels', (id: string) => { const fs = [frame(1281)]; return { result: videoResult(id, fs), output: Buffer.concat(fs) }; }],
    ['a frame over 2 MB (clean otherwise)', (id: string) => { const j = frame(2); const fs = [Buffer.concat([j.subarray(0, -2), Buffer.alloc(2 * 1024 * 1024, 0x11), j.subarray(-2)])]; return { result: videoResult(id, fs), output: Buffer.concat(fs) }; }],
    ['an image result for a video job', (id: string) => ({ result: imageResult(id), output: JPEG })],
  ])('a video: %s: failed', async (_n, answer) => {
    await withWorker(answer, async (root) => expect(await runMediaJob(root, 'video.frames', Buffer.from('x'), { pollMs: 10 })).toMatchObject({ ok: false, error: 'failed' }));
  });

  it('a video\'s own errors pass through: too long, too many pixels, not this type', async () => {
    for (const error of ['too_long', 'too_many_pixels', 'not_this_type'] as const) {
      await withWorker((id) => ({ result: { id, ok: false, error } }), async (root) => expect(await runMediaJob(root, 'video.frames', Buffer.from('x'), { pollMs: 10 })).toEqual(expect.objectContaining({ ok: false, error })));
    }
  });

  it('a clean JPEG passes the marker check; progressive frames and restarts too', () => {
    expect(cleanJpeg(JPEG, 2, 1)).toBe(true);
    expect(cleanJpeg(JPEG, 1, 2)).toBe(false);
    expect(cleanJpeg(JPEG.subarray(0, -2), 2, 1)).toBe(false);
  });

  it('no answer in time: a timeout, and the job is taken back', async () => {
    await withWorker(() => null, async (root) => {
      expect(await runMediaJob(root, 'pdf.text', Buffer.from('%PDF-'), { pollMs: 10, waitMs: 200 })).toMatchObject({ ok: false, error: 'timeout' });
      expect(readdirSync(dirs(root).in)).toEqual([]);
    });
  });

  it('too large never reaches the folder', async () => {
    await withWorker(() => null, async (root) => {
      expect(await runMediaJob(root, 'pdf.text', Buffer.alloc(10 * 1024 * 1024 + 1))).toMatchObject({ ok: false, error: 'too_large' });
      expect(readdirSync(dirs(root).in)).toEqual([]);
    });
  });

  it('the job\'s files are for Shelf\'s user and group only (the worker reads them as a member of the group)', async () => {
    await withWorker((_id, p) => {
      for (const f of [p.input, p.job]) expect(statSync(f).mode & 0o027).toBe(0);
      return null;
    }, async (root) => { await runMediaJob(root, 'pdf.text', Buffer.from('%PDF-'), { pollMs: 10, waitMs: 100 }); });
  });

  it('one job in flight; a few wait; more are busy', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let seen = 0;
    await withWorker((id, p) => { seen++; void gate.then(() => writeAtomic(p.result, JSON.stringify({ id, ok: false, error: 'unreadable' }))); return null; }, async (root) => {
      const runs = Array.from({ length: MAX_WAITING + 1 }, () => runMediaJob(root, 'pdf.text', Buffer.from('%PDF-'), { pollMs: 10 }));
      expect(await runMediaJob(root, 'pdf.text', Buffer.from('%PDF-'))).toMatchObject({ ok: false, error: 'busy' });
      await new Promise((r) => setTimeout(r, 100));
      expect(readdirSync(dirs(root).in).filter((f) => f.endsWith('.json'))).toHaveLength(1);
      release();
      expect((await Promise.all(runs)).map((r) => r.ok || r.error)).toEqual(Array(MAX_WAITING + 1).fill('unreadable'));
      expect(seen).toBe(MAX_WAITING + 1);
    });
  });
});

describe('a compromised worker', () => {
  const outsideFile = (content: Buffer | string) => { const f = join(tmp(), 'secret'); writeFileSync(f, content); return f; };

  it('a result or an image that is a link to a file elsewhere (the database, say) is refused, never read', async () => {
    const secret = outsideFile(JPEG);
    await withWorker((id, p) => { symlinkSync(secret, p.output); return { result: imageResult(id) }; }, async (root) => {
      const r = await runMediaJob(root, 'image.reencode', Buffer.from('x'), { pollMs: 10 });
      expect(r).toMatchObject({ ok: false, error: 'failed' });
      expect(r.image).toBeUndefined();
    });
    const forged = outsideFile(JSON.stringify(imageResult('01JZZZZZZZZZZZZZZZZZZZZZZZ')));
    await withWorker((_id, p) => { symlinkSync(forged, p.result); }, async (root) => {
      expect(await runMediaJob(root, 'image.reencode', Buffer.from('x'), { pollMs: 10 })).toMatchObject({ ok: false, error: 'failed' });
    });
    expect(readFileSync(secret)).toEqual(JPEG);
  });

  it('a FIFO as the result does not block the server', async () => {
    await withWorker((_id, p) => { execFileSync('mkfifo', [p.result]); }, async (root) => {
      let ticks = 0;
      const tick = setInterval(() => ticks++, 5);
      const t = Date.now();
      try {
        expect(await runMediaJob(root, 'pdf.text', Buffer.from('%PDF-'), { pollMs: 10 })).toMatchObject({ ok: false, error: 'failed' });
      } finally { clearInterval(tick); }
      expect(Date.now() - t).toBeLessThan(1000);
      expect(ticks).toBeGreaterThan(0);
    });
  });

  it('readUntrusted itself: a FIFO, a directory and a link are refused (not read as empty), a missing file is null', () => {
    const d = tmp();
    execFileSync('mkfifo', [join(d, 'fifo')]);
    mkdirSync(join(d, 'dir'));
    writeFileSync(join(d, 'file'), 'ok');
    symlinkSync(join(d, 'file'), join(d, 'link'));
    expect(readUntrusted(join(d, 'fifo'), 100)).toBe('refused');
    expect(readUntrusted(join(d, 'dir'), 100)).toBe('refused');
    expect(readUntrusted(join(d, 'link'), 100)).toBe('refused');
    expect(readUntrusted(join(d, 'missing'), 100)).toBeNull();
    expect(readUntrusted(join(d, 'file'), 1)).toBe('refused');
    expect(readUntrusted(join(d, 'file'), 100)).toEqual(Buffer.from('ok'));
  });

  it('a directory as the result is refused', async () => {
    await withWorker((_id, p) => { mkdirSync(p.result); }, async (root) => {
      expect(await runMediaJob(root, 'pdf.text', Buffer.from('%PDF-'), { pollMs: 10 })).toMatchObject({ ok: false, error: 'failed' });
    });
  });

  it.each([
    ['millions of empty rows (beyond the size cap)', () => `{"id":"ID","ok":true,"kind":"pdf.text","pages":1,"truncated":false,"rows":[${'[],'.repeat(4_000_000)}[]]}`],
    ['more rows than the cap', () => JSON.stringify({ id: 'ID', ok: true, kind: 'pdf.text', pages: 1, truncated: false, rows: Array.from({ length: MEDIA_LIMITS.pdfMaxRows + 1 }, () => ['x']) })],
    ['more cells than the cap', () => JSON.stringify({ id: 'ID', ok: true, kind: 'pdf.text', pages: 1, truncated: false, rows: Array.from({ length: 10 }, () => Array(MEDIA_LIMITS.pdfMaxCells / 10 + 1).fill('')) })],
    ['empty rows', () => JSON.stringify({ id: 'ID', ok: true, kind: 'pdf.text', pages: 1, truncated: false, rows: [[], []] })],
  ])('%s: refused, quickly', async (_n, body) => {
    const text = body();
    await withWorker((id, p) => { writeAtomic(p.result, text.replaceAll('"ID"', JSON.stringify(id))); }, async (root) => {
      const t = Date.now();
      expect(await runMediaJob(root, 'pdf.text', Buffer.from('%PDF-'), { pollMs: 10 })).toMatchObject({ ok: false, error: 'failed' });
      expect(Date.now() - t).toBeLessThan(2000);
    });
  });

  it('a result file over the size cap is refused without being read', () => {
    const root = tmp();
    prepareDirs(root);
    const id = '01JAAAAAAAAAAAAAAAAAAAAAAA';
    writeFileSync(paths(root, id).result, Buffer.alloc(MEDIA_LIMITS.maxResult + 1, 0x20));
    expect(readResult(root, id, 'pdf.text')).toEqual({ id, ok: false, error: 'failed' });
  });

  it('a folder swapped for a link: the server writes nothing through it', async () => {
    const root = tmp();
    const stop = fakeWorker(root, () => null);
    const target = tmp();
    try {
      renameSync(dirs(root).in, join(root, 'in.old'));
      symlinkSync(target, dirs(root).in);
      await expect(runMediaJob(root, 'pdf.text', Buffer.from('%PDF-'), { pollMs: 10 })).rejects.toThrow(/not a directory/);
      expect(readdirSync(target)).toEqual([]);
    } finally { stop(); }
  });

  it('a link planted where the server writes is replaced, never written through', () => {
    const root = tmp();
    prepareDirs(root);
    const victim = outsideFile('keep me');
    const p = paths(root, '01JBBBBBBBBBBBBBBBBBBBBBBB');
    symlinkSync(victim, p.job);
    writeAtomic(p.job, '{}');
    expect(readFileSync(victim, 'utf8')).toBe('keep me');
    expect(readFileSync(p.job, 'utf8')).toBe('{}');
  });
});

describe('the media boundary (architecture)', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'node_modules' || f === 'dist' ? [] : files(p);
    return /\.(ts|tsx|mjs|js)$/.test(f) ? [p] : [];
  });
  const outside = [join(root, 'apps/server/src'), join(root, 'apps/web/src'), ...readdirSync(join(root, 'packages')).map((d) => join(root, 'packages', d, 'src'))].filter(existsSync).flatMap(files);

  it('no decoder is loaded outside the worker: sharp, pdfjs-dist, ffmpeg', () => {
    expect(outside.length).toBeGreaterThan(30);
    const re = /from\s+['"](sharp|pdfjs-dist[^'"]*|fluent-ffmpeg|ffmpeg[^'"]*|canvas|@napi-rs\/canvas)['"]|import\(\s*['"](sharp|pdfjs-dist|ffmpeg)|\bffmpeg\b.*spawn|spawn\(\s*['"]ffmpeg/;
    expect(outside.map((f) => relative(root, f)).filter((f) => re.test(readFileSync(join(root, f), 'utf8')))).toEqual([]);
  });

  it('the server\'s package has none of them as a dependency', () => {
    for (const pkg of ['apps/server/package.json', ...readdirSync(join(root, 'packages')).map((d) => `packages/${d}/package.json`)]) {
      const deps = Object.keys(JSON.parse(readFileSync(join(root, pkg), 'utf8')).dependencies ?? {});
      expect(deps.filter((d) => /^(sharp|pdfjs-dist|fluent-ffmpeg|canvas|@napi-rs\/canvas)$/.test(d)), pkg).toEqual([]);
    }
  });
});
