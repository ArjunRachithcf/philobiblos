/* global self, caches, Response, FormData, File, Headers, crypto */
// Shelf's service worker does one thing: the phone's share target (contracts/connectors.md "Phone share"). The
// operating system POSTs a share to /share-target; that request never reaches the server. The parts are kept in the
// browser's cache for a moment and the share screen opens, which reads them and posts them to /api/shares itself,
// as Shelf's own page: with Shelf's Origin and the session, like every other change (ADR 0010). Nothing else is
// intercepted or cached. Any website can make a browser POST here, and the worker cannot tell the share sheet from
// another site, so nothing is sent until the person taps "Send to the Inbox" on the share screen.
const CACHE = 'shelf-share';
const FIELDS = { title: 300, text: 5000, url: 2000 };
const MAX_FILES = 30;
// The server's limits (src/shares/shares.ts SHARE_BYTES): a file over its type's is left out here, not cached, so one
// large photo never fails the whole share. The type is told from the first bytes, as the server does.
const MAX_BYTES = { image: 20 * 1024 * 1024, video: 64 * 1024 * 1024, total: 100 * 1024 * 1024 };
async function isImage(f) {
  const b = new Uint8Array(await f.slice(0, 12).arrayBuffer());
  const at = (i, ...v) => v.every((x, k) => b[i + k] === x);
  return at(0, 0xff, 0xd8, 0xff) || at(0, 0x89, 0x50, 0x4e, 0x47) || (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) || at(0, 0x47, 0x49, 0x46, 0x38);
}

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'POST' || url.origin !== self.location.origin || url.pathname !== '/share-target') return;
  e.respondWith((async () => {
    let form;
    try { form = await e.request.formData(); } catch { return Response.redirect('/share?error=unreadable', 303); }
    const out = new FormData();
    for (const [k, max] of Object.entries(FIELDS)) {
      const v = form.get(k);
      if (typeof v === 'string' && v.trim()) out.append(k, v.slice(0, max));
    }
    let dropped = 0, total = 0;
    for (const f of form.getAll('media').slice(0, MAX_FILES)) {
      if (!(f instanceof File)) continue;
      if (f.size > ((await isImage(f)) ? MAX_BYTES.image : MAX_BYTES.video) || total + f.size > MAX_BYTES.total) { dropped++; continue; }
      total += f.size;
      out.append('media', f, 'shared');
    }
    const id = crypto.randomUUID();
    const cache = await caches.open(CACHE);
    // One share waits at a time: an older one that was never sent is dropped.
    for (const k of await cache.keys()) await cache.delete(k);
    const r = new Response(out);
    const headers = new Headers(r.headers);
    headers.set('x-shelf-at', String(Date.now()));
    headers.set('x-shelf-dropped', String(dropped));
    await cache.put(`/share-pending/${id}`, new Response(await r.blob(), { headers }));
    return Response.redirect(`/share?pending=${id}`, 303);
  })());
});
