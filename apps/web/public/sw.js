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
const MAX_FILE_BYTES = 64 * 1024 * 1024; // the server's largest (a video; an image is 20 MB): a larger file is left out here, not cached

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
    let dropped = 0;
    for (const f of form.getAll('media').slice(0, MAX_FILES)) {
      if (!(f instanceof File)) continue;
      if (f.size > MAX_FILE_BYTES) { dropped++; continue; }
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
