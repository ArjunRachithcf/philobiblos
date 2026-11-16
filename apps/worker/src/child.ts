// One job, in its own process (main.ts starts it with a heap limit and kills it after the time limit): reads the claimed
// input, writes the output next to the result, and tells the parent the result over IPC. Nothing else.
import { readFileSync, writeFileSync } from 'node:fs';
import type { MediaKind, MediaResult } from '@shelf/contracts/media';
import { JobError, pdfText, reencodeImage } from './jobs';

const [kind, inputPath, outputPath, id] = process.argv.slice(2) as [MediaKind | 'test.spin' | 'test.alloc' | 'test.linger', string, string, string];

async function run(): Promise<MediaResult> {
  const input = readFileSync(inputPath);
  if (kind === 'image.reencode') {
    const r = await reencodeImage(input);
    writeFileSync(outputPath, r.data, { mode: 0o640 }); // the server reads it as a member of the group
    return { id, ok: true, kind, width: r.width, height: r.height, format: 'jpeg', bytes: r.data.length };
  }
  if (kind === 'pdf.text') return { id, ok: true, kind, ...(await pdfText(input)) };
  // Only for the worker's own tests (SHELF_WORKER_TEST=1): a job that never ends, and one that eats its heap.
  if (process.env.SHELF_WORKER_TEST === '1' && kind === 'test.spin') for (;;) { /* until killed */ }
  // …and one that answers, then keeps running with a process of its own (both must be killed with the answer).
  if (process.env.SHELF_WORKER_TEST === '1' && kind === 'test.linger') {
    const { spawn } = await import('node:child_process');
    const sub = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(outputPath, `${process.pid} ${sub.pid}`);
    process.send!({ id, ok: false, error: 'failed' } satisfies MediaResult);
    for (;;) await new Promise((r) => setTimeout(r, 1000));
  }
  if (process.env.SHELF_WORKER_TEST === '1' && kind === 'test.alloc') { const keep: string[] = []; for (;;) keep.push('x'.repeat(1 << 20) + keep.length); }
  return { id, ok: false, error: 'failed' };
}

run().then(
  (r) => process.send!(r, () => process.exit(0)),
  (e) => process.send!({ id, ok: false, error: e instanceof JobError ? e.code : 'failed' } satisfies MediaResult, () => process.exit(0)),
);
