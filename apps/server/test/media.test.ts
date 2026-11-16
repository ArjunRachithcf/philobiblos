// The server's side of the media worker (ADR 0009): it hands files over and reads back plain data, checking what comes
// back (the worker read hostile input). A fake worker stands in here: the real one has its own tests (apps/worker), and
// the server's tests must not load sharp or pdfjs-dist. An architecture test keeps those out of the server for good.
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dirs, paths, writeAtomic } from '@shelf/contracts/media';
import { MediaUnavailable, runMediaJob } from '../src/media/client';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

/** A stand-in worker: answers every job it finds with `answer(id)` (and an output file, if given). */
function fakeWorker(root: string, answer: (id: string) => { result: object | string; output?: Buffer } | null) {
  const d = dirs(root);
  writeFileSync(d.alive, '');
  const timer = setInterval(() => {
    utimesSync(d.alive, new Date(), new Date());
    for (const f of readdirSync(d.in).filter((x) => x.endsWith('.json'))) {
      const id = f.slice(0, -5);
      const a = answer(id);
      if (!a) continue;
      if (a.output) writeFileSync(paths(root, id).output, a.output);
      writeAtomic(root, paths(root, id).result, typeof a.result === 'string' ? a.result : JSON.stringify(a.result));
    }
  }, 20);
  return () => clearInterval(timer);
}

const tmp = () => mkdtempSync(join(tmpdir(), 'shelf-media-'));

describe('the media client', () => {
  it('without a worker (no folder, or no heartbeat): unavailable, never processed here', async () => {
    await expect(runMediaJob(null, 'image.reencode', JPEG)).rejects.toThrow(MediaUnavailable);
    const root = tmp();
    await expect(runMediaJob(root, 'image.reencode', JPEG)).rejects.toThrow(MediaUnavailable);
    writeFileSync(dirs(root).alive, '');
    utimesSync(dirs(root).alive, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await expect(runMediaJob(root, 'image.reencode', JPEG)).rejects.toThrow(MediaUnavailable);
  });

  it('hands the job over and takes the image back; nothing of the job stays', async () => {
    const root = tmp();
    const stop = fakeWorker(root, (id) => ({ result: { id, ok: true, kind: 'image.reencode', width: 2, height: 1, format: 'jpeg', bytes: JPEG.length }, output: JPEG }));
    try {
      const r = await runMediaJob(root, 'image.reencode', Buffer.from('input'), { pollMs: 10 });
      expect(r).toMatchObject({ ok: true, width: 2, height: 1 });
      expect(r.image).toEqual(JPEG);
      const d = dirs(root);
      expect([...readdirSync(d.in), ...readdirSync(d.out), ...readdirSync(d.run)]).toEqual([]);
    } finally { stop(); }
  });

  it.each([
    ['an image that is not a JPEG', (id: string) => ({ result: { id, ok: true, kind: 'image.reencode', width: 2, height: 1, format: 'jpeg', bytes: 5 }, output: Buffer.from('<svg>') })],
    ['an image of another size than reported', (id: string) => ({ result: { id, ok: true, kind: 'image.reencode', width: 2, height: 1, format: 'jpeg', bytes: 999 }, output: JPEG })],
    ['no image at all', (id: string) => ({ result: { id, ok: true, kind: 'image.reencode', width: 2, height: 1, format: 'jpeg', bytes: 8 } })],
    ['a result for another job', () => ({ result: { id: '01JZZZZZZZZZZZZZZZZZZZZZZZ', ok: true } })],
    ['not JSON', () => ({ result: '{"id": ' })],
  ])('%s: failed', async (_n, answer) => {
    const root = tmp();
    const stop = fakeWorker(root, answer);
    try { expect(await runMediaJob(root, 'image.reencode', Buffer.from('x'), { pollMs: 10 })).toMatchObject({ ok: false, error: 'failed' }); } finally { stop(); }
  });

  it('no answer in time: a timeout, and the job is taken back', async () => {
    const root = tmp();
    const stop = fakeWorker(root, () => null);
    try {
      expect(await runMediaJob(root, 'pdf.text', Buffer.from('%PDF-'), { pollMs: 10, waitMs: 200 })).toMatchObject({ ok: false, error: 'timeout' });
      expect(readdirSync(dirs(root).in)).toEqual([]);
    } finally { stop(); }
  });

  it('too large never reaches the folder', async () => {
    const root = tmp();
    const stop = fakeWorker(root, () => null);
    try {
      expect(await runMediaJob(root, 'pdf.text', Buffer.alloc(10 * 1024 * 1024 + 1))).toMatchObject({ ok: false, error: 'too_large' });
      expect(readdirSync(dirs(root).in)).toEqual([]);
    } finally { stop(); }
  });

  it('files in the folder are only readable by Shelf\'s user', async () => {
    const root = tmp();
    const stop = fakeWorker(root, () => null);
    try {
      void runMediaJob(root, 'pdf.text', Buffer.from('%PDF-'), { pollMs: 10, waitMs: 300 });
      await new Promise((r) => setTimeout(r, 50));
      for (const f of readdirSync(dirs(root).in)) expect(statSync(join(dirs(root).in, f)).mode & 0o077).toBe(0);
    } finally { stop(); }
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
