// The media worker (ADR 0009): its own container, as its own user, with no network, a read-only root, no capabilities
// and memory and process limits (docker-compose.yml). It sees only the job folder, reads in/ (mounted read-only) and
// writes only out/. It takes jobs one at a time; each runs in a child process, the leader of its own process group,
// with a heap limit and a wall-clock limit, and the whole group is killed once the result is in (or the time is up).
// Anything that goes wrong becomes a fixed error code.
import { fork } from 'node:child_process';
import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JOB_ID, MEDIA_KINDS, SERVER_WAIT_MS, clampLimits, dirs, paths, writeAtomic, type MediaKind, type MediaResult } from '@shelf/contracts/media';

export interface WorkerOptions {
  root: string;
  /** The child's script and Node flags (tests run the TypeScript through tsx). */
  child?: { path: string; execArgv?: string[] };
  timeoutMs?: number;
  heapMb?: number;
  kinds?: readonly string[];
  now?: () => number;
}

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));

/** Kills a child's whole process group (it is the group's leader), whatever it started. */
function killGroup(pid: number | undefined) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* gone already */ }
}

/** Runs one job in a child process and returns its result; never throws. The child never outlives this. */
export function runChild(o: WorkerOptions, kind: string, input: string, output: string, id: string): Promise<MediaResult> {
  const { timeoutMs, heapMb } = clampLimits(o);
  return new Promise((resolve) => {
    let done = false;
    const child = fork(o.child?.path ?? here('./child.js'), [kind, input, output, id], {
      execArgv: [...(o.child?.execArgv ?? []), `--max-old-space-size=${heapMb}`],
      // The child gets no environment of the worker's beyond what it needs, and no stdin.
      env: { NODE_ENV: 'production', ...(process.env.SHELF_WORKER_TEST === '1' ? { SHELF_WORKER_TEST: '1' } : {}) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json',
      detached: true,
    });
    const finish = (r: MediaResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killGroup(child.pid);
      resolve(r);
    };
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
    const timer = setTimeout(() => finish({ id, ok: false, error: 'timeout' }), timeoutMs);
    child.on('message', (m) => finish(m as MediaResult));
    child.on('error', () => finish({ id, ok: false, error: 'failed' }));
    child.on('exit', () => finish({ id, ok: false, error: /heap out of memory|allocation failed/i.test(stderr) ? 'out_of_memory' : 'failed' }));
  });
}

/** Creates the claim; false if it exists already (the job ran, or is running). Never through a link. */
function claim(path: string): boolean {
  try { closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640)); return true; } catch { return false; }
}

/** Runs the jobs waiting in in/, oldest first, that have no claim yet. Returns how many it took. */
export async function runPending(o: WorkerOptions): Promise<number> {
  const d = dirs(o.root);
  const kinds = o.kinds ?? MEDIA_KINDS;
  const now = o.now ?? Date.now;
  let ran = 0;
  for (const name of readdirSync(d.in).filter((f) => f.endsWith('.json')).sort()) {
    const id = name.slice(0, -5);
    // Only names the server makes; anything else is never read (in/ is the server's: the worker cannot remove it).
    if (!JOB_ID.test(id)) continue;
    const p = paths(o.root, id);
    if (!claim(p.claim)) continue;
    ran++;
    let job: { kind?: unknown; createdAt?: unknown } = {};
    try { job = JSON.parse(readFileSync(p.job, 'utf8')) as typeof job; } catch { /* not JSON, or gone */ }
    const kind = kinds.includes(job.kind as string) ? (job.kind as MediaKind) : null;
    const created = typeof job.createdAt === 'string' ? Date.parse(job.createdAt) : NaN;
    let r: MediaResult;
    // A job nobody waits for any more (the server gave up) is not run: its input stays unread.
    if (!(now() - created <= SERVER_WAIT_MS)) r = { id, ok: false, error: 'timeout' };
    else if (!kind) r = { id, ok: false, error: 'not_this_type' };
    else r = await runChild(o, kind, p.input, p.output, id);
    if (!r.ok) rmSync(p.output, { force: true });
    writeAtomic(p.result, JSON.stringify(r));
  }
  return ran;
}

/** Marks the worker alive for the server (workerAlive). */
export function heartbeat(root: string): void {
  const f = dirs(root).alive;
  if (!existsSync(f)) writeAtomic(f, '');
  const t = new Date();
  utimesSync(f, t, t);
}

/** After a restart: a claim without a result was a job that never finished; it fails rather than runs twice. */
export function recover(root: string): void {
  const d = dirs(root);
  for (const f of readdirSync(d.out)) {
    const id = f.slice(0, -'.claim'.length);
    if (f.endsWith('.claim') && JOB_ID.test(id) && !existsSync(paths(root, id).result)) writeAtomic(paths(root, id).result, JSON.stringify({ id, ok: false, error: 'failed' }));
    if (f.startsWith('.w-')) rmSync(`${d.out}/${f}`, { force: true });
  }
}

async function loop(root: string) {
  // The folder's owner is the server; the same user here would let a decoder exploit write in/ and replace out/.
  if (process.getuid?.() === lstatSync(dirs(root).in).uid) { console.error('the media worker must run as its own user, not the server\'s (SHELF_WORKER_UID)'); process.exit(1); }
  recover(root);
  const d = dirs(root);
  for (let n = 0; ; n++) {
    heartbeat(root);
    // What nobody collected (the server gave up waiting, or stopped): gone after 10 minutes.
    if (n % 240 === 0) {
      for (const f of readdirSync(d.out)) {
        if (f === 'alive') continue;
        const p = `${d.out}/${f}`;
        try { if (Date.now() - lstatSync(p).mtimeMs > 600_000) rmSync(p, { force: true, recursive: true }); } catch { /* raced */ }
      }
    }
    if (!(await runPending({ root }))) await new Promise((r) => setTimeout(r, 250));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.env.SHELF_WORK_DIR;
  if (!root) { console.error('SHELF_WORK_DIR must be set'); process.exit(1); }
  void loop(root);
}
