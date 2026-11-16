// Video frames in the media worker (ADR 0009, apps/worker/src/video.ts) against hostile files. Every video here is
// made by the test from ffmpeg's own test sources (nothing real, nothing committed), with a full ffmpeg as the maker
// (SHELF_FIXTURE_FFMPEG, default `ffmpeg` on PATH); what reads them is the worker's own build in apps/worker/bin
// (scripts/video-test.sh builds it and runs this file; CI's `video` job too). Without the build these tests are
// skipped, unless SHELF_VIDEO_TESTS=required, which makes a missing build a failure.
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { MEDIA_LIMITS, clampLimits, paths, prepareDirs, readResult, serverWaitMs, videoContainer, writeAtomic } from '@shelf/contracts/media';
import { cleanJpeg } from '../../server/src/media/client';
import { runChild, runPending, type WorkerOptions } from '../src/main';
import { BIN, CODECS, PpmFrames, RLIMITS, checkDecode, checkProbe, decode, toJpegs, decodeArgs, inputArgs, openVideo, plan, probe, rlimitArgs } from '../src/video';

const built = existsSync(join(BIN, 'ffmpeg')) && existsSync(join(BIN, 'ffprobe'));
if (!built && process.env.SHELF_VIDEO_TESTS === 'required') throw new Error(`no ffmpeg build in ${BIN}: run scripts/video-test.sh`);
const MAKER = process.env.SHELF_FIXTURE_FFMPEG ?? 'ffmpeg';

const child = { path: fileURLToPath(new URL('../src/child.ts', import.meta.url)), execArgv: ['--import', import.meta.resolve('tsx')] };
let dir: string;
let o: WorkerOptions;
const fx: Record<string, string> = {};

/** A video from ffmpeg's test sources: `args` are the maker's, between its inputs and the output file. */
function make(name: string, inputs: string[], args: string[]): string {
  const out = join(dir, name);
  execFileSync(MAKER, ['-v', 'error', '-y', ...inputs, ...args, out], { stdio: ['ignore', 'ignore', 'pipe'] }); // its messages only in the error
  return out;
}
const src = (s: string, rate: number, seconds: number) => ['-f', 'lavfi', '-i', `testsrc2=s=${s}:r=${rate}:d=${seconds}`];
const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];

let n = 0;
const ID = () => `01V${String(++n).padStart(23, '0')}`;
async function job(input: string, extra: Partial<WorkerOptions> = {}) {
  const id = ID();
  const outPath = join(dir, `${id}.out`);
  const r = await runChild({ ...o, ...extra }, 'video.frames', input, outPath, id);
  return { r, out: r.ok ? readFileSync(outPath) : null };
}
const at = (r: Awaited<ReturnType<typeof job>>['r']) => (r.ok && r.kind === 'video.frames' ? r.frames.map((f) => f.at) : []);

/** The MP4's boxes on the way to `path` (e.g. moov/trak/mdia/minf/dinf/dref), each as [offset, size]. */
function boxPath(b: Buffer, path: string[]): [number, number][] {
  const out: [number, number][] = [];
  let off = 0, end = b.length;
  for (const want of path) {
    let found = false;
    while (off + 8 <= end) {
      const size = b.readUInt32BE(off), type = b.toString('latin1', off + 4, off + 8);
      if (type === want) { out.push([off, size]); end = off + size; off += want === 'dref' ? 16 : 8; found = true; break; }
      off += size;
    }
    if (!found) throw new Error(`no ${want}`);
  }
  return out;
}

/**
 * An MP4 whose track's samples live in another file, through a QuickTime alias (an external data reference, "dref"):
 * its own media data is zeroed, and its dref names `other` next to it. Only a reader that follows the reference sees
 * frames. The moov comes after the media data (ffmpeg's default), so growing it moves no sample offset.
 */
function externalRef(from: string, other: string): Buffer {
  const b = Buffer.from(readFileSync(from));
  const [[mdat, mdatSize]] = boxPath(b, ['mdat']) as [[number, number]];
  b.fill(0, mdat + 8, mdat + mdatSize);
  const chain = boxPath(b, ['moov', 'trak', 'mdia', 'minf', 'dinf', 'dref']);
  const [drefOff, drefSize] = chain.at(-1)!;
  // The alias record as FFmpeg's mov demuxer reads it: 150 bytes of volume and file names and levels, then the
  // absolute path (type 2) and the end (type -1).
  const rec = Buffer.alloc(150);
  rec.writeUInt8(other.length, 10 + 1 + 27 + 12);
  rec.write(other, 10 + 1 + 27 + 12 + 1, 'latin1');
  rec.writeUInt16BE(1, 10 + 1 + 27 + 12 + 1 + 63 + 16); // nlvl_from
  rec.writeUInt16BE(1, 10 + 1 + 27 + 12 + 1 + 63 + 16 + 2); // nlvl_to
  const p = Buffer.from(`/videos/${other}`, 'latin1');
  const tlv = Buffer.concat([Buffer.from([0, 2, p.length >> 8, p.length & 255]), p, Buffer.alloc(p.length & 1), Buffer.from([0xff, 0xff, 0, 0])]);
  const entry = Buffer.concat([Buffer.alloc(12), rec, tlv]);
  entry.writeUInt32BE(entry.length, 0);
  entry.write('alis', 4, 'latin1'); // flags 0: not in this file
  const dref = Buffer.concat([Buffer.alloc(16), entry]);
  dref.writeUInt32BE(dref.length, 0); dref.write('dref', 4, 'latin1'); dref.writeUInt32BE(1, 12);
  const grow = dref.length - drefSize;
  for (const [off, size] of chain.slice(0, -1)) b.writeUInt32BE(size + grow, off);
  return Buffer.concat([b.subarray(0, drefOff), dref, b.subarray(drefOff + drefSize)]);
}

/** The MP4 with every duration in its headers (movie, track, media) cut to a twelfth: it says 5 s and holds 60. */
function lyingDuration(from: string): Buffer {
  const b = Buffer.from(readFileSync(from));
  const walk = (off: number, end: number) => {
    while (off + 8 <= end) {
      const size = b.readUInt32BE(off), type = b.toString('latin1', off + 4, off + 8);
      if (['moov', 'trak', 'mdia'].includes(type)) walk(off + 8, off + size);
      if (type === 'mvhd' || type === 'mdhd') b.writeUInt32BE(Math.floor(b.readUInt32BE(off + 24) / 12), off + 24);
      if (type === 'tkhd') b.writeUInt32BE(Math.floor(b.readUInt32BE(off + 28) / 12), off + 28);
      off += size;
    }
  };
  walk(0, b.length);
  return b;
}

beforeAll(() => {
  if (!built) return;
  process.env.SHELF_WORKER_TEST = '1';
  dir = mkdtempSync(join(tmpdir(), 'shelf-video-'));
  prepareDirs(join(dir, 'work'));
  o = { root: join(dir, 'work'), child };
  fx.h264 = make('ok.mp4', [...src('320x240', 10, 9), '-f', 'lavfi', '-i', 'sine=d=9'], [...x264, '-c:a', 'aac', '-shortest']);
  fx.hevc = make('hevc.mov', src('320x240', 10, 3), ['-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-x265-params', 'log-level=none']);
  fx.vp9 = make('vp9.webm', src('320x240', 10, 3), ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8']);
  fx.vp8 = make('vp8.webm', src('320x240', 10, 3), ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8']);
  fx.portrait = make('tall.mp4', src('1080x1920', 2, 3), x264);
  fx.ninety = make('ninety.mp4', src('64x64', 2, 90), x264);
  fx.hour = make('hour.mp4', ['-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=1:d=3600'], x264);
  fx.wide = make('wide.mp4', src('4112x16', 1, 1), x264);
  fx.huge = make('huge.mp4', src('3000x3000', 1, 1), x264);
  fx.mpeg4 = make('mpeg4.mp4', src('64x64', 2, 2), ['-c:v', 'mpeg4']);
  fx.nine = make('nine.mkv', ['-i', fx.h264], [...Array.from({ length: 9 }, () => ['-map', '0:v']).flat(), '-c', 'copy']);
  fx.tiny = make('tiny.mp4', src('32x32', 1, 1), x264);
  fx.thousand = make('thousand.mp4', ['-i', fx.tiny], [...Array.from({ length: 1000 }, () => ['-map', '0:v']).flat(), '-c', 'copy']);
  fx.long60 = make('long60.mp4', src('64x64', 2, 60), x264);
  fx.busy = make('busy.mp4', src('1280x720', 30, 60), x264);
  // A browser's recording: WebM written as a stream, so no duration in it; half a second long.
  fx.short = join(dir, 'short.webm');
  writeFileSync(fx.short, execFileSync(MAKER, ['-v', 'error', ...src('64x64', 30, 0.5), '-c:v', 'libvpx', '-deadline', 'realtime', '-f', 'webm', '-'], { maxBuffer: 1 << 24 }));
  fx.faststart = make('fast.mp4', src('320x240', 10, 9), [...x264, '-g', '10', '-movflags', '+faststart']);
});

describe.skipIf(!built)('the build: only what a phone\'s video needs', () => {
  const list = (what: string) => execFileSync(join(BIN, 'ffmpeg'), ['-hide_banner', `-${what}`], { encoding: 'utf8' });
  const names = (what: string, re: RegExp) => [...list(what).matchAll(re)].map((m) => m[1]).filter((x) => x !== '=').sort();
  it('two demuxers, four decoders, one encoder and one muxer for the frames, the `fd` protocol and nothing else', () => {
    expect(names('demuxers', /^ D\S* +(\S+)/gm)).toEqual(['matroska,webm', 'mov,mp4,m4a,3gp,3g2,mj2']);
    expect(names('decoders', /^ V\S* (\S+)/gm)).toEqual([...CODECS].sort());
    expect(names('decoders', /^ [AS]\S* (\S+)/gm)).toEqual([]);
    expect(names('encoders', /^ V\S* (\S+)/gm)).toEqual(['ppm']);
    expect(names('muxers', /^ +E\S* +(\S+)/gm)).toEqual(['image2pipe']);
    const protocols = list('protocols');
    expect(protocols.replace(/\s+/g, ' ').trim()).toBe('Supported file protocols: Input: fd Output: fd');
  });
});

describe('what a video is: its bytes', () => {
  const ftyp = (brand: string, size = 24) => { const b = Buffer.alloc(32); b.writeUInt32BE(size); b.write('ftyp', 4); b.write(brand, 8); return b; };
  const ebml = (doc: string) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x80 | doc.length]), Buffer.from(doc), Buffer.alloc(16)]);
  it.each([
    [ftyp('isom'), 'mp4'], [ftyp('qt  '), 'mp4'], [ftyp('mp42'), 'mp4'], [ebml('webm'), 'webm'], [ebml('matroska'), 'webm'],
    [ftyp('heic'), null], [ftyp('avif'), null], [ftyp('isom', 8), null], [ftyp('isom', 1 << 20), null], [ebml('mkvfake'), null],
    [Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\nfile:///etc/passwd\n'), null], [Buffer.from('ffconcat version 1.0\nfile /etc/passwd\n'), null],
    [Buffer.from('GIF89a\0\0\0\0ftypisom\0\0\0\0'), null], [Buffer.alloc(0), null],
  ])('%#: %s', (b, want) => expect(videoContainer(b)).toBe(want));
});

describe('the rules, one by one (pure)', () => {
  const good = (over: { format?: object; streams?: object[] } = {}) => ({
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '9.000000', nb_streams: 2, ...over.format },
    streams: over.streams ?? [{ codec_type: 'video', codec_name: 'h264', width: 320, height: 240 }, { codec_type: 'audio', codec_name: 'aac' }],
  });
  const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return (e as { code?: string }).code; } };
  it('the probe must name the container the bytes said, few streams, an allowed codec, a size and a duration within the limits', () => {
    expect(checkProbe(good(), 'mp4')).toEqual({ codec: 'h264', width: 320, height: 240, streams: 2, duration: 9 });
    expect(code(() => checkProbe(good(), 'webm'))).toBe('not_this_type');
    expect(code(() => checkProbe(good({ format: { format_name: 'hls' } }), 'mp4'))).toBe('not_this_type');
    const many = Array.from({ length: MEDIA_LIMITS.videoMaxStreams + 1 }, () => ({ codec_type: 'video', codec_name: 'h264', width: 2, height: 2 }));
    expect(code(() => checkProbe(good({ format: { nb_streams: many.length }, streams: many }), 'mp4'))).toBe('unreadable');
    expect(code(() => checkProbe(good({ format: { nb_streams: 3 } }), 'mp4'))).toBe('unreadable');
    expect(code(() => checkProbe(good({ format: { nb_streams: 1 }, streams: [{ codec_type: 'video', codec_name: 'av1', width: 2, height: 2 }] }), 'mp4'))).toBe('not_this_type');
    expect(code(() => checkProbe(good({ format: { nb_streams: 1 }, streams: [{ codec_type: 'audio', codec_name: 'aac' }] }), 'mp4'))).toBe('not_this_type');
    const size = (width: number, height: number) => code(() => checkProbe(good({ format: { nb_streams: 1 }, streams: [{ codec_type: 'video', codec_name: 'hevc', width, height }] }), 'mp4'));
    expect([size(3840, 2160), size(2160, 3840), size(4097, 16), size(16, 4097), size(3000, 3000), size(0, 10)]).toEqual(['ok', 'ok', 'too_many_pixels', 'too_many_pixels', 'too_many_pixels', 'unreadable']);
    expect(code(() => checkProbe(good({ format: { duration: '180.000000' } }), 'mp4'))).toBe('ok');
    expect(code(() => checkProbe(good({ format: { duration: '180.5' } }), 'mp4'))).toBe('too_long');
    expect(checkProbe(good({ format: { duration: 'N/A' } }), 'mp4').duration).toBeNull();
  });

  it('a frame every 2 s, further apart past a minute so that 30 span it; read a second past the duration said', () => {
    expect(plan({ duration: 9 })).toEqual({ every: 2, read: 10 });
    expect(plan({ duration: 90 })).toEqual({ every: 3, read: 91 });
    expect(plan({ duration: 180 })).toEqual({ every: 6, read: 180 });
    expect(plan({ duration: null })).toEqual({ every: 6, read: 180 });
  });

  it('ffmpeg is told how to read and what to give back: one descriptor, one demuxer, the first video stream, 30 PPM frames', () => {
    expect(inputArgs('mp4')).toEqual(['-protocol_whitelist', 'fd', '-fd', '3', '-f', 'mov', '-max_streams', '9']);
    expect(inputArgs('webm')).toContain('matroska');
    const a = decodeArgs('mp4', { every: 2, read: 10 });
    const after = (k: string) => a[a.indexOf(k) + 1];
    expect(a.slice(0, 7)).toEqual(['-nostdin', '-v', 'error', '-threads', '1', '-filter_threads', '1']);
    expect([after('-max_pixels'), after('-t'), after('-map'), after('-frames:v'), after('-c:v'), after('-f')]).toEqual([String(3840 * 2160), '10', '0:v:0', '30', 'ppm', 'mov']);
    expect(a.indexOf('-t')).toBeLessThan(a.indexOf('-i')); // an input option: it stops the reading
    expect(['-an', '-sn', '-dn'].every((k) => a.includes(k))).toBe(true);
    expect(after('-vf')).toBe('fps=1/2:round=up:eof_action=pass,scale=w=min(iw\\,1280):h=min(ih\\,1280):force_original_aspect_ratio=decrease,format=rgb24');
  });

  it('each process under rlimits: CPU, address space, no file it can write, few descriptors, no core; a caller only lowers them', () => {
    expect(RLIMITS).toEqual({ cpu: 50, as: 512 * 1024 * 1024, fsize: 0, nofile: 16, core: 0 });
    expect(rlimitArgs()).toEqual(['--cpu=50', `--as=${512 * 1024 * 1024}`, '--fsize=0', '--nofile=16', '--core=0', '--']);
    expect(rlimitArgs({ cpu: 1, as: 2 ** 40, fsize: 2 ** 30 })).toEqual(['--cpu=1', `--as=${512 * 1024 * 1024}`, '--fsize=0', '--nofile=16', '--core=0', '--']);
  });

  it('how ffmpeg ended: out of CPU is a timeout; killed for what it wrote, half a frame, or nothing at all is unreadable', () => {
    const code = (frames: number, clean: boolean, signal: NodeJS.Signals | null, outOfCpu = false) => {
      try { checkDecode({ frames: Array.from({ length: frames }, () => ({ width: 1, height: 1, pixels: Buffer.alloc(3) })), clean }, { signal, outOfCpu }); return 'ok'; } catch (e) { return (e as { code?: string }).code; }
    };
    expect([code(3, true, null), code(3, true, 'SIGXCPU'), code(3, true, 'SIGKILL', true)]).toEqual(['ok', 'timeout', 'timeout']);
    expect([code(3, true, 'SIGKILL'), code(3, false, null), code(0, true, null)]).toEqual(['unreadable', 'unreadable', 'unreadable']);
  });

  it('each frame becomes a fresh JPEG of at most 2 MB (a frame over it fails the video), with its offset', async () => {
    const frames = [{ width: 4, height: 2, pixels: Buffer.alloc(24, 200) }, { width: 4, height: 2, pixels: Buffer.alloc(24, 9) }];
    const out = await toJpegs(frames, 2.5);
    expect(out.map((f) => [f.width, f.height, f.at])).toEqual([[4, 2, 0], [4, 2, 2.5]]);
    expect(out.every((f) => cleanJpeg(f.data, f.width, f.height))).toBe(true);
    await expect(toJpegs(frames, 2, 100)).rejects.toMatchObject({ code: 'failed' });
  });

  it('a video gets 60 s of wall clock, the rest 20 s; the server waits 10 s longer', () => {
    expect(clampLimits({}, 'video.frames').timeoutMs).toBe(60_000);
    expect(clampLimits({ timeoutMs: 600_000 }, 'video.frames').timeoutMs).toBe(60_000);
    expect(clampLimits({ timeoutMs: 600_000 }, 'image.reencode').timeoutMs).toBe(20_000);
    expect([serverWaitMs('video.frames'), serverWaitMs('pdf.text')]).toEqual([70_000, 30_000]);
  });

  it('ffmpeg\'s output is read as untrusted: PPM frames of the size allowed, at most 30, nothing half', () => {
    const frame = (w: number, h: number) => Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), Buffer.alloc(w * h * 3, 7)]);
    const p = new PpmFrames();
    const two = Buffer.concat([frame(4, 3), frame(2, 2)]);
    for (let i = 0; i < two.length; i += 5) p.push(two.subarray(i, i + 5)); // in pieces, as a pipe gives it
    expect(p.frames.map((f) => [f.width, f.height, f.pixels.length])).toEqual([[4, 3], [2, 2]].map(([w, h]) => [w, h, w! * h! * 3]));
    expect(p.clean).toBe(true);
    expect(() => new PpmFrames().push(frame(1281, 2))).toThrow(/too large/);
    expect(() => new PpmFrames().push(Buffer.from('P5\n2 2\n255\n....'))).toThrow(/not a PPM/);
    expect(() => new PpmFrames().push(Buffer.from('<html> not a frame at all, longer than a header'))).toThrow(/not a PPM/);
    const many = new PpmFrames();
    expect(() => { for (let i = 0; i <= MEDIA_LIMITS.framesMax; i++) many.push(frame(1, 1)); }).toThrow(/too many/);
    const half = new PpmFrames();
    half.push(frame(4, 4).subarray(0, 20));
    expect(half.clean).toBe(false);
  });
});

describe.skipIf(!built)('videos: a frame every ~2 s, at most 30, each a fresh JPEG; nothing else of the video', () => {
  it('an MP4 with sound: a frame every 2 s from 0, each a clean JPEG of its size; the sound is gone', async () => {
    const { r, out } = await job(fx.h264!);
    expect(r).toMatchObject({ ok: true, kind: 'video.frames' });
    expect(at(r)).toEqual([0, 2, 4, 6, 8]);
    if (!r.ok || r.kind !== 'video.frames') return;
    expect(out!.length).toBe(r.frames.reduce((k, f) => k + f.bytes, 0));
    let off = 0;
    for (const f of r.frames) {
      expect([f.width, f.height]).toEqual([320, 240]);
      // The server's own check on the worker's real output: a JPEG with nothing but image data.
      expect(cleanJpeg(out!.subarray(off, (off += f.bytes)), f.width, f.height)).toBe(true);
    }
  });

  it.each([['HEVC in a MOV', 'hevc'], ['VP9 in a WebM', 'vp9'], ['VP8 in a WebM', 'vp8']])('%s', async (_n, k) => {
    expect(at((await job(fx[k]!)).r)).toEqual([0, 2]);
  });

  it('a WebM without a duration, shorter than a frame\'s spacing (6 s then): its first frame is kept', async () => {
    expect(at((await job(fx.short!)).r)).toEqual([0]);
  });

  it('a tall phone video is scaled to 1280 on its long side', async () => {
    const { r } = await job(fx.portrait!);
    expect(r.ok && r.kind === 'video.frames' && r.frames.map((f) => [f.width, f.height])).toEqual([[720, 1280], [720, 1280]]);
  });

  it('a minute and a half: 30 frames, 3 s apart; never more than 30', async () => {
    const { r } = await job(fx.ninety!);
    expect(at(r)).toEqual(Array.from({ length: 30 }, (_, k) => k * 3));
  });

  it('through the job folder as the server drops it: the result reads back, checked field by field', async () => {
    const id = ID();
    const p = paths(o.root, id);
    writeAtomic(p.input, readFileSync(fx.vp9!));
    writeAtomic(p.job, JSON.stringify({ id, kind: 'video.frames', createdAt: new Date().toISOString() }));
    expect(await runPending({ ...o, clean: () => true })).toBe(1);
    expect(readResult(o.root, id, 'video.frames')).toMatchObject({ ok: true, kind: 'video.frames', frames: [{ at: 0, width: 320, height: 240 }, { at: 2 }] });
  });
});

describe.skipIf(!built)('hostile videos', () => {
  const err = async (input: string) => { const { r } = await job(input); return r.ok ? 'ok' : r.error; };
  const file = (name: string, b: Buffer | string) => { const p = join(dir, name); writeFileSync(p, b); return p; };

  it('an hour declared, and held: too long, from the probe', async () => {
    expect(await err(fx.hour!)).toBe('too_long');
  });

  it('a video that says 5 s and holds 60 is read for 6 s only: the decoder stops where the duration said', async () => {
    const lie = file('lie.mp4', lyingDuration(fx.long60!));
    expect(at((await job(lie)).r)).toEqual([0, 2, 4]);
  });

  it('too wide, or too many pixels: refused from the probe', async () => {
    expect(await err(fx.wide!)).toBe('too_many_pixels');
    expect(await err(fx.huge!)).toBe('too_many_pixels');
  });

  it('…and the decoder itself refuses frames over the pixel limit, even past the probe', async () => {
    const { fd, container } = openVideo(fx.huge!);
    try { await expect(decode(fd, container, { every: 2, read: 2 })).rejects.toMatchObject({ code: 'unreadable' }); } finally { closeSync(fd); }
  });

  it('a codec not on the list (MPEG-4 part 2): not this type', async () => {
    expect(await err(fx.mpeg4!)).toBe('not_this_type');
  });

  it('nine streams: unreadable; a thousand: the demuxer stops at ten, before it builds them', async () => {
    expect(await err(fx.nine!)).toBe('unreadable');
    expect(await err(fx.thousand!)).toBe('unreadable');
  });

  it('truncated: without its index, unreadable; with the index first, the frames before the cut', async () => {
    const h = readFileSync(fx.h264!);
    expect(await err(file('cut.mp4', h.subarray(0, h.length >> 1)))).toBe('unreadable');
    const f = readFileSync(fx.faststart!);
    const frames = at((await job(file('cutfast.mp4', f.subarray(0, Math.floor(f.length * 0.6))))).r);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThan(5);
  });

  it.each([
    ['zero bytes', ''],
    ['an HLS playlist', '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n'],
    ['a concat list', 'ffconcat version 1.0\nfile /etc/passwd\n'],
    ['a GIF with an MP4 behind it', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10)])],
    ['a HEIC photo', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(32)])],
  ])('%s: not this type', async (name, b) => {
    expect(await err(file(`${name.replace(/\W/g, '')}.bin`, b))).toBe('not_this_type');
  });

  it('a polyglot (an MP4 header over a playlist) is read only as an MP4, and is unreadable', async () => {
    const box = Buffer.alloc(24); box.writeUInt32BE(24); box.write('ftypisom', 4);
    const poly = file('poly.mp4', Buffer.concat([box, Buffer.from('#EXTM3U\n#EXTINF:10,\nfile:///etc/passwd\n')]));
    expect(await err(poly)).toBe('unreadable');
  });

  it('an external reference (a QuickTime alias to a file next to it) is never followed: no frames, unreadable', async () => {
    const sub = join(dir, 'videos');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'other.mp4'), readFileSync(fx.h264!));
    const main = join(sub, 'main.mp4');
    writeFileSync(main, externalRef(fx.h264!, 'other.mp4'));
    // The fixture is real: a full ffmpeg told to follow references reads the other file's frames through it.
    const count = (extra: string[]) => execFileSync(MAKER.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', ...extra, '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', main], { encoding: 'utf8' }).trim();
    expect(Number(count(['-enable_drefs', '1']))).toBeGreaterThan(0);
    expect(await err(main)).toBe('unreadable');
  });

  it('a link in place of the input, a directory, or a file over the size limit: never read', async () => {
    const link = join(dir, 'link.mp4');
    symlinkSync(fx.h264!, link);
    expect(await err(link)).toBe('unreadable');
    expect(await err(dir)).toBe('unreadable');
    // …and a file that is not the one opened first (each process opens it again) is not read either.
    expect(() => openVideo(fx.h264!, { dev: 0, ino: 0 })).toThrow(/unreadable/);
    const big = file('big.mp4', readFileSync(fx.h264!));
    truncateSync(big, MEDIA_LIMITS.maxInput['video.frames'] + 1);
    expect(await err(big)).toBe('too_large');
  });

  it('out of CPU seconds: ffmpeg dies of it, and the job says timeout', async () => {
    const { fd, container } = openVideo(fx.busy!);
    try { await expect(decode(fd, container, { every: 2, read: 61 }, { cpu: 1 })).rejects.toMatchObject({ code: 'timeout' }); } finally { closeSync(fd); }
  }, 30_000);

  it('out of address space: ffmpeg cannot allocate, and nothing comes back', async () => {
    for (const f of [(fd: number) => decode(fd, 'mp4', { every: 2, read: 10 }, { as: 24 * 1024 * 1024 }), (fd: number) => probe(fd, 'mp4', { as: 4 * 1024 * 1024 })]) {
      const { fd } = openVideo(fx.h264!);
      try { await expect(f(fd)).rejects.toMatchObject({ code: 'unreadable' }); } finally { closeSync(fd); }
    }
  });

  it('a job that runs past its wall clock is killed with its ffmpeg', async () => {
    const t = Date.now();
    expect((await job(fx.busy!, { timeoutMs: 800 })).r).toMatchObject({ ok: false, error: 'timeout' });
    expect(Date.now() - t).toBeLessThan(5000);
    await new Promise((r) => setTimeout(r, 300));
    const ffmpegs = readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => { try { return readFileSync(`/proc/${d}/cmdline`, 'latin1').includes(join(BIN, 'ffmpeg')); } catch { return false; } });
    expect(ffmpegs).toEqual([]);
  });
});
