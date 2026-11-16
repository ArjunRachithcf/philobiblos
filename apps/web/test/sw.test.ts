// The service worker's share target (public/sw.js), run in a sandbox with Node's own FormData, File and Response: what
// it keeps of a share and what it counts as left out for the share screen's notice.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type Fetch = { request: Request; respondWith: (r: Promise<Response>) => void };

function serviceWorker() {
  const listeners: Record<string, (e: unknown) => void> = {};
  const cached = new Map<string, Response>();
  const cache = { keys: async () => [...cached.keys()], delete: async (k: string) => cached.delete(k), put: async (k: string, r: Response) => { cached.set(k, r); } };
  const self = { location: { origin: 'https://shelf.test' }, addEventListener: (n: string, f: (e: unknown) => void) => { listeners[n] = f; }, skipWaiting() {}, clients: { claim: async () => {} } };
  runInNewContext(readFileSync(join(__dirname, '../public/sw.js'), 'utf8'), {
    // A worker's Response.redirect resolves a path against its own origin; Node's has none.
    self, caches: { open: async () => cache }, Response: class extends Response { static redirect(to: string, status: number) { return new Response(null, { status, headers: { location: to } }); } }, FormData, File, Headers, crypto, URL, Uint8Array, Object, Date, String,
  });
  return {
    async share(form: FormData) {
      let answer: Promise<Response> | undefined;
      const e: Fetch = { request: new Request('https://shelf.test/share-target', { method: 'POST', body: form }), respondWith: (r) => { answer = r; } };
      listeners.fetch!(e);
      await answer;
      const [kept] = [...cached.values()];
      return { dropped: Number(kept!.headers.get('x-shelf-dropped')), files: (await kept!.formData()).getAll('media').length };
    },
  };
}

const jpeg = (bytes: number) => { const b = new Uint8Array(bytes); b.set([0xff, 0xd8, 0xff, 0xe0, 0, 16]); return new File([b], 'a.jpg', { type: 'image/jpeg' }); };

describe('the share target in the service worker', () => {
  it('keeps at most 30 files; every file past them counts as left out (PR #21 review)', async () => {
    const f = new FormData();
    for (let i = 0; i < 33; i++) f.append('media', jpeg(16));
    expect(await serviceWorker().share(f)).toEqual({ files: 30, dropped: 3 });
  });

  it('a file over its type\'s limit is left out by itself and counted with those past 30', async () => {
    const f = new FormData();
    f.append('media', jpeg(21 * 1024 * 1024));
    for (let i = 0; i < 31; i++) f.append('media', jpeg(16));
    expect(await serviceWorker().share(f)).toEqual({ files: 30, dropped: 2 });
  });
});
