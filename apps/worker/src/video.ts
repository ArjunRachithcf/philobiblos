// Video frames (ADR 0009), run only inside the child process (child.ts): a shared video becomes at most 30 JPEGs, a
// frame every ~2 s, and nothing else of it is kept (no audio, no video, no metadata). ffmpeg and ffprobe are our own
// build (apps/worker/ffmpeg/build.sh: two demuxers, four decoders, one protocol) and run under this file's rules:
//
// - The container comes from the bytes (`videoContainer`): MP4/MOV or WebM, and ffmpeg is told which demuxer to use
//   (`-f`), so it never probes a file into something else (a playlist, a concat list, an image sequence).
// - The input is the one file descriptor opened here (O_NOFOLLOW, a regular file, within the size limit), read through
//   the `fd` protocol only: ffmpeg cannot open a path, so an external reference in the file has nothing to open.
// - The probe must name the expected container, few streams, an allowed codec, a size and a duration within the
//   limits; then the decode reads no further than that duration (`-t`), its decoder refuses larger frames
//   (`-max_pixels`), and it stops at 30 frames, each scaled to at most 1280 pixels a side.
// - Each process runs under rlimits (`prlimit`): CPU seconds, address space, no file it may write, a few descriptors,
//   no core dump; one thread; an empty environment; no stdin. The child's own wall clock (main.ts) kills them with it.
// - What ffmpeg writes is parsed as untrusted (PPM frames of the expected sizes, no more than 30) and each frame is
//   re-encoded by sharp to a fresh JPEG, as a shared image is.
import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEDIA_LIMITS } from '@shelf/contracts/media';
import { JobError, loadSharp } from './jobs';
import { sniff } from './sniff';

/** Where the build's ffmpeg and ffprobe are: /app/worker/bin in the image (apps/worker/bin, untracked, in a checkout). */
export const BIN = fileURLToPath(new URL('../bin/', import.meta.url));
export const PRLIMIT = '/usr/bin/prlimit';

type Container = 'mp4' | 'webm';
/** The one demuxer for each container, and the name ffprobe must report for it. */
export const DEMUXER: Record<Container, string> = { mp4: 'mov', webm: 'matroska' };
export const FORMAT_NAME: Record<Container, string> = { mp4: 'mov,mp4,m4a,3gp,3g2,mj2', webm: 'matroska,webm' };
/** The video codecs taken (FFmpeg's own decoders, all four built in). */
export const CODECS = ['h264', 'hevc', 'vp8', 'vp9'];

/** Each ffmpeg or ffprobe process: CPU seconds, address space (bytes), file size (none: it writes only to a pipe), descriptors, core size. */
export const RLIMITS = { cpu: 50, as: 512 * 1024 * 1024, fsize: 0, nofile: 16, core: 0 };
export type Rlimits = typeof RLIMITS;

/** The rlimits a caller asks for (the tests ask for less), never above RLIMITS. */
export function rlimitArgs(o: Partial<Rlimits> = {}): string[] {
  const l = Object.fromEntries(Object.entries(RLIMITS).map(([k, max]) => {
    const v = o[k as keyof Rlimits];
    return [k, typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : max];
  })) as Rlimits;
  return [`--cpu=${l.cpu}`, `--as=${l.as}`, `--fsize=${l.fsize}`, `--nofile=${l.nofile}`, `--core=${l.core}`, '--'];
}

/** How both read the input: descriptor 3 through the `fd` protocol only, with the container's own demuxer. */
export function inputArgs(c: Container): string[] {
  return ['-protocol_whitelist', 'fd', '-fd', '3', '-f', DEMUXER[c], '-max_streams', String(MEDIA_LIMITS.videoMaxStreams + 1)];
}

export interface Probe { codec: string; width: number; height: number; streams: number; duration: number | null }
export interface Plan { every: number; read: number }

/**
 * Opens the input: no link, a regular file, within the size limit, a container we take; `same`: the very file opened
 * before (each process gets a descriptor of its own: they would share the file offset). The caller closes it.
 */
export function openVideo(path: string, same?: { dev: number; ino: number }): { fd: number; container: Container; dev: number; ino: number } {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { throw new JobError('unreadable'); }
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || (same && (s.dev !== same.dev || s.ino !== same.ino))) throw new JobError('unreadable');
    if (s.size > MEDIA_LIMITS.maxInput['video.frames']) throw new JobError('too_large');
    const head = Buffer.alloc(64);
    const t = sniff(head.subarray(0, readSync(fd, head, 0, head.length, 0)));
    if (t !== 'mp4' && t !== 'webm') throw new JobError('not_this_type');
    return { fd, container: t, dev: s.dev, ino: s.ino };
  } catch (e) { closeSync(fd); throw e; }
}

/** How a process ended; `outOfCpu`: killed by the kernel past its CPU seconds (SIGXCPU at the soft limit, SIGKILL at the hard one). */
interface Ran { code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; outOfCpu: boolean }

/** One process under the rlimits, with descriptor 3 as its input, nothing in its environment but one malloc arena. */
function run(bin: string, args: string[], fd: number, limits: Partial<Rlimits>, onData?: (b: Buffer) => void, cap = 256 * 1024): Promise<Ran> {
  return new Promise((resolve) => {
    const p = spawn(PRLIMIT, [...rlimitArgs(limits), join(BIN, bin), ...args], { env: { MALLOC_ARENA_MAX: '1' }, stdio: ['ignore', 'pipe', 'ignore', fd] });
    const out: Buffer[] = [];
    let size = 0, killed = false;
    const kill = () => { killed = true; p.kill('SIGKILL'); };
    p.stdout!.on('data', (b: Buffer) => {
      if (onData) { try { onData(b); } catch { kill(); } return; }
      size += b.length;
      if (size > cap) kill(); else out.push(b);
    });
    p.on('error', () => resolve({ code: null, signal: 'SIGKILL', stdout: Buffer.alloc(0), outOfCpu: false }));
    p.on('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out), outOfCpu: signal === 'SIGXCPU' || (signal === 'SIGKILL' && !killed) }));
  });
}

/** What ffprobe says of the input, checked against the limits (`checkProbe`). */
export async function probe(fd: number, c: Container, limits: Partial<Rlimits> = {}): Promise<Probe> {
  const r = await run('ffprobe', ['-v', 'error', ...inputArgs(c), '-show_entries', 'format=format_name,duration,nb_streams:stream=codec_type,codec_name,width,height', '-of', 'json', 'fd:'], fd, limits);
  if (r.signal === 'SIGXCPU' || r.outOfCpu) throw new JobError('timeout');
  if (r.code !== 0) throw new JobError('unreadable');
  let o: unknown;
  try { o = JSON.parse(r.stdout.toString('utf8')); } catch { throw new JobError('unreadable'); }
  return checkProbe(o, c);
}

/** The probe's answer, as untrusted: the expected container, few streams, an allowed codec, a size and a duration within the limits. */
export function checkProbe(o: unknown, c: Container): Probe {
  const x = (o ?? {}) as { format?: Record<string, unknown>; streams?: Record<string, unknown>[] };
  const f = x.format ?? {};
  if (f.format_name !== FORMAT_NAME[c]) throw new JobError('not_this_type');
  const streams = Array.isArray(x.streams) ? x.streams : [];
  if (!Number.isInteger(f.nb_streams) || (f.nb_streams as number) > MEDIA_LIMITS.videoMaxStreams || streams.length !== f.nb_streams) throw new JobError('unreadable');
  const v = streams.find((s) => s && s.codec_type === 'video');
  if (!v || !CODECS.includes(v.codec_name as string)) throw new JobError('not_this_type');
  const { width: w, height: h } = v as { width: number; height: number };
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new JobError('unreadable');
  if (w > MEDIA_LIMITS.videoMaxSide || h > MEDIA_LIMITS.videoMaxSide || w * h > MEDIA_LIMITS.videoMaxPixels) throw new JobError('too_many_pixels');
  // No duration (a browser's recording often has none): read up to the longest taken, a frame every 2 s.
  const d = typeof f.duration === 'string' ? Number(f.duration) : NaN;
  if (Number.isFinite(d) && d > MEDIA_LIMITS.videoMaxSeconds) throw new JobError('too_long');
  return { codec: v.codec_name as string, width: w, height: h, streams: streams.length, duration: Number.isFinite(d) && d > 0 ? d : null };
}

/** A frame every 2 s, further apart so that 30 span the video; read no further than the duration said (plus a second). */
export function plan(p: Pick<Probe, 'duration'>): Plan {
  const seconds = p.duration ?? MEDIA_LIMITS.videoMaxSeconds;
  const every = Math.ceil(Math.max(MEDIA_LIMITS.frameEverySeconds, seconds / MEDIA_LIMITS.framesMax) * 1000) / 1000;
  return { every, read: Math.min(MEDIA_LIMITS.videoMaxSeconds, Math.ceil(seconds) + 1) };
}

/** ffmpeg's arguments: the first video stream only, no audio, subtitles or data, one thread, PPM frames to stdout. */
export function decodeArgs(c: Container, p: Plan): string[] {
  const side = MEDIA_LIMITS.frameMaxSide;
  return [
    '-nostdin', '-v', 'error', '-threads', '1', '-filter_threads', '1',
    ...inputArgs(c), '-max_pixels', String(MEDIA_LIMITS.videoMaxPixels), '-t', String(p.read), '-i', 'fd:',
    '-map', '0:v:0', '-an', '-sn', '-dn',
    // Scaled down to fit `side`, never up. Rounded up and passed at the end: the first frame is always kept, even of a
    // video shorter than `every` (a browser's WebM has no duration, so `every` is 6 s).
    '-vf', `fps=1/${p.every}:round=up:eof_action=pass,scale=w=min(iw\\,${side}):h=min(ih\\,${side}):force_original_aspect_ratio=decrease,format=rgb24`,
    '-frames:v', String(MEDIA_LIMITS.framesMax), '-c:v', 'ppm', '-f', 'image2pipe', 'fd:',
  ];
}

/**
 * Reads ffmpeg's PPM stream as untrusted: each frame a binary PPM header with a size within the limit and exactly its
 * pixels, at most 30 frames. Throws on anything else (the caller kills ffmpeg).
 */
export class PpmFrames {
  readonly frames: { width: number; height: number; pixels: Buffer }[] = [];
  private chunks: Buffer[] = [];
  private size = 0;
  push(b: Buffer): void {
    this.chunks.push(b);
    this.size += b.length;
    for (;;) {
      // The header from the first bytes; the frame is joined once all its bytes are here (never on every chunk).
      const head = Buffer.concat(this.chunks, Math.min(this.size, 24)).toString('latin1');
      const m = /^P6\n(\d{1,5}) (\d{1,5})\n255\n/.exec(head);
      if (!m) { if (this.size >= 24 || !'P6\n'.startsWith(head.slice(0, 3))) throw new Error('not a PPM frame'); return; }
      const width = Number(m[1]), height = Number(m[2]);
      if (width < 1 || height < 1 || width > MEDIA_LIMITS.frameMaxSide || height > MEDIA_LIMITS.frameMaxSide) throw new Error('frame too large');
      const start = m[0].length, end = start + width * height * 3;
      if (this.size < end) return;
      if (this.frames.length >= MEDIA_LIMITS.framesMax) throw new Error('too many frames');
      const all = Buffer.concat(this.chunks, this.size);
      this.frames.push({ width, height, pixels: Buffer.from(all.subarray(start, end)) });
      this.chunks = this.size > end ? [all.subarray(end)] : [];
      this.size -= end;
      if (!this.size) return;
    }
  }
  /** At the end: nothing half a frame left over. */
  get clean(): boolean { return this.size === 0; }
}

/** Decodes the frames (`decodeArgs`), re-encoding each through sharp to a fresh JPEG. */
export async function decode(fd: number, c: Container, p: Plan, limits: Partial<Rlimits> = {}): Promise<Frame[]> {
  const ppm = new PpmFrames();
  const r = await run('ffmpeg', decodeArgs(c, p), fd, limits, (b) => ppm.push(b));
  checkDecode(ppm, r);
  return toJpegs(ppm.frames, p.every);
}

/**
 * How ffmpeg ended: out of CPU seconds is a timeout; killed for what it wrote, half a frame left, or no frame at all is
 * unreadable. A truncated file still gives the frames before the cut.
 */
export function checkDecode(ppm: Pick<PpmFrames, 'frames' | 'clean'>, r: Pick<Ran, 'signal' | 'outOfCpu'>): void {
  if (r.signal === 'SIGXCPU' || r.outOfCpu) throw new JobError('timeout');
  if (!ppm.frames.length || !ppm.clean || r.signal === 'SIGKILL') throw new JobError('unreadable');
}

export interface Frame { data: Buffer; width: number; height: number; at: number }

/** Each frame through sharp to a fresh JPEG, at most `maxBytes`; `at` is its offset, a frame every `every` seconds from 0. */
export async function toJpegs(frames: PpmFrames['frames'], every: number, maxBytes: number = MEDIA_LIMITS.frameMaxBytes): Promise<Frame[]> {
  const sharp = await loadSharp();
  const out: Frame[] = [];
  for (const [k, f] of frames.entries()) {
    const data = await sharp(f.pixels, { raw: { width: f.width, height: f.height, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
    if (data.length > Math.min(maxBytes, MEDIA_LIMITS.frameMaxBytes)) throw new JobError('failed');
    out.push({ data, width: f.width, height: f.height, at: Math.round(k * every * 1000) / 1000 });
  }
  return out;
}

/** A video file to its frames: open, probe, plan, then decode from a descriptor of its own of the same file. */
export async function videoFrames(path: string, limits: Partial<Rlimits> = {}) {
  const first = openVideo(path);
  let p: Probe;
  try { p = await probe(first.fd, first.container, limits); } finally { closeSync(first.fd); }
  const again = openVideo(path, first);
  try { return await decode(again.fd, again.container, plan(p), limits); } finally { closeSync(again.fd); }
}
