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
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const windows: { url: string; focus: () => Promise<void>; navigate: (u: string) => Promise<void> }[] = [];
  const self = {
    location: { origin: 'https://philobiblos.test' }, addEventListener: (n: string, f: (e: unknown) => void) => { listeners[n] = f; }, skipWaiting() {},
    clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async (u: string) => { opened.push(u); } },
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); } },
  };
  runInNewContext(readFileSync(join(__dirname, '../public/sw.js'), 'utf8'), {
    // A worker's Response.redirect resolves a path against its own origin; Node's has none.
    self, caches: { open: async () => cache }, Response: class extends Response { static redirect(to: string, status: number) { return new Response(null, { status, headers: { location: to } }); } }, FormData, File, Headers, crypto, URL, Uint8Array, Object, Date, String,
  });
  const wait = async (f: (e: { waitUntil: (p: Promise<unknown>) => void }) => void) => { let p: Promise<unknown> = Promise.resolve(); f({ waitUntil: (x) => { p = x; } }); await p; };
  return {
    shown, opened, windows,
    /** A push whose data is `data` (null: none; a string that is not JSON). */
    push: (data: unknown) => wait((w) => listeners.push!({ ...w, data: data === null ? null : { json: () => (typeof data === 'string' ? JSON.parse(data) : data) } })),
    click: (data: unknown) => wait((w) => listeners.notificationclick!({ ...w, notification: { close() {}, data } })),
    async share(form: FormData) {
      let answer: Promise<Response> | undefined;
      const e: Fetch = { request: new Request('https://philobiblos.test/share-target', { method: 'POST', body: form }), respondWith: (r) => { answer = r; } };
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

describe('notifications in the service worker', () => {
  it('shows its own words for the kind, never the message\'s', async () => {
    const sw = serviceWorker();
    await sw.push({ kind: 'plan', title: 'Your bank needs you', body: 'Sam reads <b>Secrets</b>', url: 'https://evil.example' });
    await sw.push({ kind: 'test' });
    for (const odd of [{ kind: 'constructor' }, { kind: '__proto__' }, { kind: ['plan'] }, 'not json', null, { body: 'hello' }]) await sw.push(odd);
    expect(sw.shown.map((n) => n.options.body)).toEqual(['This month’s plan is ready.', 'Notifications from Philobiblos work on this device.', ...Array(6).fill('Philobiblos has something new.')]);
    expect(new Set(sw.shown.map((n) => n.title))).toEqual(new Set(['Philobiblos']));
    await sw.push({ kind: 'other' });
    expect(sw.shown.at(-1)!.options.body).toBe('Philobiblos has something new.');
    expect(JSON.stringify(sw.shown)).not.toMatch(/evil|bank|Sam|Secrets/);
  });
  it('a tap opens This month on Philobiblos\'s own origin, whatever the message says', async () => {
    const sw = serviceWorker();
    await sw.click({ url: 'https://evil.example/' });
    expect(sw.opened).toEqual(['https://philobiblos.test/month']);
    const went: string[] = [];
    sw.windows.push({ url: 'https://other.example/', focus: async () => { went.push('other'); }, navigate: async () => {} }, { url: 'https://philobiblos.test/library', focus: async () => { went.push('focus'); }, navigate: async (u) => { went.push(u); } });
    await sw.click(null);
    expect(went).toEqual(['focus', 'https://philobiblos.test/month']);
    expect(sw.opened).toHaveLength(1);
  });
});
