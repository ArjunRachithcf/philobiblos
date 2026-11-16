// The media worker (ADR 0009): its own container, with no network, a read-only root, no capabilities and memory and
// process limits (docker-compose.yml). It sees only the job folder. It takes jobs one at a time; each runs in a child
// process with a heap limit and a wall-clock limit, and anything that goes wrong becomes a fixed error code.
import { fork } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JOB_ID, MEDIA_KINDS, MEDIA_LIMITS, dirs, paths, writeAtomic, type MediaKind, type MediaResult } from '@shelf/contracts/media';

export interface WorkerOptions {
  root: string;
  /** The child's script and Node flags (tests run the TypeScript through tsx). */
  child?: { path: string; execArgv?: string[] };
  timeoutMs?: number;
  heapMb?: number;
  kinds?: readonly string[];
}

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));

/** Runs one job in a child process and returns its result; never throws. */
export function runChild(o: WorkerOptions, kind: string, input: string, output: string, id: string): Promise<MediaResult> {
  const timeoutMs = Math.min(o.timeoutMs ?? MEDIA_LIMITS.timeoutMs, MEDIA_LIMITS.timeoutMs);
  const heapMb = Math.min(o.heapMb ?? MEDIA_LIMITS.heapMb, MEDIA_LIMITS.heapMb);
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: MediaResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const child = fork(o.child?.path ?? here('./child.js'), [kind, input, output, id], {
      execArgv: [...(o.child?.execArgv ?? []), `--max-old-space-size=${heapMb}`],
      // The child gets no environment of the worker's beyond what it needs, and no stdin.
      env: { NODE_ENV: 'production', ...(process.env.SHELF_WORKER_TEST === '1' ? { SHELF_WORKER_TEST: '1' } : {}) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json',
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ id, ok: false, error: 'timeout' }); }, timeoutMs);
    child.on('message', (m) => finish(m as MediaResult));
    child.on('error', () => finish({ id, ok: false, error: 'failed' }));
    child.on('exit', () => finish({ id, ok: false, error: /heap out of memory|allocation failed/i.test(stderr) ? 'out_of_memory' : 'failed' }));
  });
}

/** Claims and runs the jobs waiting in in/, oldest first. Returns how many ran. */
export async function runPending(o: WorkerOptions): Promise<number> {
  const d = dirs(o.root);
  const kinds = o.kinds ?? MEDIA_KINDS;
  let ran = 0;
  for (const name of readdirSync(d.in).filter((f) => f.endsWith('.json')).sort()) {
    const id = name.slice(0, -5);
    const p = paths(o.root, id);
    // Only names the server makes; anything else is removed unread.
    if (!JOB_ID.test(id)) { rmSync(`${d.in}/${name}`, { force: true }); continue; }
    try { renameSync(p.job, p.claimedJob); renameSync(p.input, p.claimedInput); } catch { continue; } // gone, or half there
    let kind: MediaKind | null = null;
    try { const j = JSON.parse(readFileSync(p.claimedJob, 'utf8')) as { kind?: unknown }; kind = kinds.includes(j.kind as string) ? (j.kind as MediaKind) : null; } catch { /* not JSON */ }
    const r: MediaResult = kind ? await runChild(o, kind, p.claimedInput, p.output, id) : { id, ok: false, error: 'not_this_type' };
    if (!r.ok) rmSync(p.output, { force: true });
    writeAtomic(o.root, p.result, JSON.stringify(r));
    rmSync(p.claimedJob, { force: true });
    rmSync(p.claimedInput, { force: true });
    ran++;
  }
  return ran;
}

/** Marks the worker alive for the server (workerAlive). */
export function heartbeat(root: string): void {
  const f = dirs(root).alive;
  if (!existsSync(f)) writeFileSync(f, '', { mode: 0o600 });
  const now = new Date();
  utimesSync(f, now, now);
}

async function loop(root: string) {
  // Jobs claimed by a worker that stopped mid-job: they never finished, so they fail rather than run twice.
  const d = dirs(root);
  for (const f of readdirSync(d.run).filter((x) => x.endsWith('.json'))) {
    const id = f.slice(0, -5);
    if (JOB_ID.test(id)) writeAtomic(root, paths(root, id).result, JSON.stringify({ id, ok: false, error: 'failed' }));
    rmSync(`${d.run}/${f}`, { force: true });
    rmSync(`${d.run}/${id}.bin`, { force: true });
  }
  for (let n = 0; ; n++) {
    heartbeat(root);
    // Results nobody collected (the server gave up waiting): gone after 10 minutes.
    if (n % 240 === 0) for (const f of readdirSync(d.out)) { const p = `${d.out}/${f}`; try { if (Date.now() - statSync(p).mtimeMs > 600_000) rmSync(p, { force: true }); } catch { /* raced */ } }
    if (!(await runPending({ root }))) await new Promise((r) => setTimeout(r, 250));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.env.SHELF_WORK_DIR;
  if (!root) { console.error('SHELF_WORK_DIR must be set'); process.exit(1); }
  void loop(root);
}
