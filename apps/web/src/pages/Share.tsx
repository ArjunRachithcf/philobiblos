// The phone share screen (spec §4 "Phone share", contracts/connectors.md). A share from the phone's share sheet lands
// in the service worker (public/sw.js), which keeps it for a moment and opens this screen. Any website can make the
// browser POST to the share target, so this screen never sends on its own: it shows what arrived, and only the
// person's tap on "Send to the Inbox" posts it to /api/shares (as Shelf's own page, with Shelf's Origin and the
// session). An untouched share expires after an hour. Then it shows how the media worker gets on.
// Without a pending share it is a form: a link, a note and images or videos, by hand.
import { useEffect, useId, useRef, useState } from 'react';
import { api, message, type Share as ShareView } from '../api';
import { Notice, PageHead } from '../ui';

const CACHE = 'shelf-share';
const PENDING = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHARE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Posts the form with upload progress (fetch has none); same origin, so the browser sends Origin and the cookie. */
function upload(form: FormData, onProgress: (sent: number, total: number) => void): Promise<{ id: string; status: string }> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/shares');
    x.withCredentials = true;
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
    x.onload = () => {
      let body: { id?: string; status?: string; error?: string } = {};
      try { body = JSON.parse(x.responseText) as typeof body; } catch { /* no body */ }
      if (x.status === 202 && typeof body.id === 'string') resolve({ id: body.id, status: body.status ?? 'received' });
      else reject(new Error(body.error ?? (x.status === 413 ? 'Too many files, or too large: an image up to 20 MB, a video up to 64 MB, 100 MB together.' : x.status === 429 ? 'Too many shares; wait a few minutes.' : 'Shelf did not take the share.')));
    };
    x.onerror = () => reject(new Error('Shelf did not answer.'));
    x.send(form);
  });
}

/** A share waits for the person's tap at most this long. */
export const PENDING_MAX_AGE_MS = 3600_000;
/** Send does nothing this soon after the confirmation is shown (opened, or brought back into view). */
const SEND_DELAY_MS = 1000;
interface Pending { id: string; form: FormData; dropped: number }

async function readPending(id: string): Promise<Pending | null> {
  if (!PENDING.test(id) || !('caches' in window)) return null;
  const cache = await caches.open(CACHE);
  const key = `/share-pending/${id}`;
  const r = await cache.match(key);
  if (!r) return null;
  const at = Number(r.headers.get('x-shelf-at'));
  if (!Number.isFinite(at) || Date.now() - at > PENDING_MAX_AGE_MS) { await cache.delete(key); return null; }
  return { id, form: await r.formData(), dropped: Number(r.headers.get('x-shelf-dropped')) || 0 };
}
const forget = async (id: string) => { if ('caches' in window) await (await caches.open(CACHE)).delete(`/share-pending/${id}`); };

export function Share({ go }: { go: (to: string) => void }) {
  const id = useId();
  const params = new URLSearchParams(location.search);
  const [shareId, setShareId] = useState<string | null>(() => (SHARE_ID.test(params.get('id') ?? '') ? params.get('id') : null));
  const [sent, setSent] = useState<{ sent: number; total: number } | null>(null);
  const [view, setView] = useState<ShareView | null>(null);
  const [error, setError] = useState<string | null>(params.get('error') ? 'The phone’s share could not be read. Try again, or share the link alone.' : params.has('offline') ? 'Open Shelf once in this browser, then share again: the share target needs Shelf to have been opened.' : null);
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const files = useRef<HTMLInputElement>(null);
  const started = useRef(false);
  const [pending, setPending] = useState<Pending | null>(null);

  const send = async (form: FormData) => {
    setError(null);
    setSent({ sent: 0, total: 1 });
    try {
      const r = await upload(form, (s, t) => setSent({ sent: s, total: t }));
      history.replaceState(null, '', `/share?id=${r.id}`);
      setShareId(r.id);
    } catch (e) { setError(message(e)); setSent(null); }
  };

  // A share from the share target: shown, never sent until the person taps Send.
  useEffect(() => {
    const p = params.get('pending');
    if (!p || started.current) return;
    started.current = true;
    readPending(p).then((x) => {
      if (x) setPending(x);
      else { history.replaceState(null, '', '/share'); setError('That share was sent or discarded already, or it is more than an hour old. Share it again from your phone.'); }
    }, () => setError('The phone’s share could not be read.'));
  }, []);
  const sendPending = async () => { if (!pending) return; const p = pending; setPending(null); await forget(p.id); await send(p.form); };
  const discard = async () => { if (!pending) return; await forget(pending.id); setPending(null); history.replaceState(null, '', '/share'); setError(null); };

  // How the media worker gets on: asked every second, then less often.
  useEffect(() => {
    if (!shareId) return;
    let stop = false;
    let n = 0;
    const tick = async () => {
      try {
        const v = await api<ShareView>(`/shares/${shareId}`);
        if (stop) return;
        setView(v);
        if (v.status === 'done' || v.status === 'failed') return;
      } catch (e) { if (!stop) setError(message(e)); return; }
      n++;
      setTimeout(() => { if (!stop) void tick(); }, n < 60 ? 1000 : 5000);
    };
    void tick();
    return () => { stop = true; };
  }, [shareId]);

  const byHand = (e: React.FormEvent) => {
    e.preventDefault();
    const form = new FormData();
    if (url.trim()) form.append('url', url.trim());
    if (note.trim()) form.append('note', note.trim());
    for (const f of files.current?.files ?? []) form.append('media', f, 'shared');
    void send(form);
  };

  const total = view?.progress.total ?? 0;
  const done = view?.progress.done ?? 0;
  const pct = sent && !shareId ? Math.round((sent.sent / Math.max(1, sent.total)) * 100) : total ? Math.round((done / total) * 100) : view ? 100 : 0;
  const what = !shareId ? 'Sending to Shelf' : !view ? 'Sent' : view.status === 'received' ? 'Waiting for the media worker'
    : view.status === 'reading' ? `Reading the images and videos: ${done} of ${total}` : view.status === 'done' ? 'Done' : 'It could not be read';

  return (
    <>
      <PageHead title="Share to Shelf" sub="A post’s images or video, its link and its caption go to your Inbox. Shelf never logs in to Instagram." />
      <div className="stack">
        {error && <Notice kind="error">{error}</Notice>}
        {(sent || shareId) && (
          <section className="card stack" aria-labelledby={`${id}-p`}>
            <h2 className="card-title" id={`${id}-p`}>Your share</h2>
            <div className="progress-row">
              <div className="progress-head"><b>{what}</b><span>{pct}%</span></div>
              <div className="progress" role="progressbar" aria-labelledby={`${id}-p`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={what}>
                <span style={{ '--value': `${pct}%` } as React.CSSProperties} />
              </div>
            </div>
            <p className="sr-only" role="status">{what}</p>
            {view?.status === 'done' && <Notice kind="ok" title="In your Inbox.">{total ? `${total - (view.refused ?? 0)} of ${total} file${total === 1 ? '' : 's'} kept${view.refused ? `; ${view.refused} could not be read` : ''}.` : 'The link and the note are kept.'}</Notice>}
            {view?.status === 'failed' && <Notice kind="error" title="Nothing was kept.">{view.error ?? 'The files could not be read.'}</Notice>}
            {view && (view.status === 'done' || view.status === 'failed') && (
              <div className="btn-row">
                <a className="btn btn-primary" href="/inbox" onClick={(e) => { e.preventDefault(); go('/inbox'); }}>Open the Inbox</a>
                <a className="btn" href="/share" onClick={(e) => { e.preventDefault(); history.replaceState(null, '', '/share'); setShareId(null); setView(null); setSent(null); }}>Share something else</a>
              </div>
            )}
          </section>
        )}
        {pending && !sent && <PendingShare p={pending} onSend={() => void sendPending()} onDiscard={() => void discard()} />}
        {!pending && !sent && !shareId && (
          <form className="card stack" onSubmit={byHand} noValidate aria-labelledby={`${id}-h`}>
            <h2 className="card-title" id={`${id}-h`}>Share by hand</h2>
            <div className="field">
              <label className="field-label" htmlFor={`${id}-u`}>Link</label>
              <input className="input" id={`${id}-u`} type="url" inputMode="url" maxLength={2000} value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${id}-n`}>Note</label>
              <textarea className="input textarea" id={`${id}-n`} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${id}-f`}>Images or videos (JPEG, PNG, WebP, GIF; MP4, MOV, WebM; up to 30)</label>
              <input className="input" id={`${id}-f`} type="file" ref={files} multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm" />
            </div>
            <div className="btn-row"><button type="submit" className="btn btn-primary">Send to the Inbox</button></div>
          </form>
        )}
      </div>
    </>
  );
}

function PendingShare({ p, onSend, onDiscard }: { p: Pending; onSend: () => void; onDiscard: () => void }) {
  const id = useId();
  const field = (k: string) => { const v = p.form.get(k); return typeof v === 'string' ? v : null; };
  const files = p.form.getAll('media').filter((f) => typeof f !== 'string').length;
  // Focus goes to the heading, never to Send: another site can open this screen and time a keypress for it. And for a
  // moment after the screen is shown, Send is disabled (aria-disabled, so it stays in reach), as browsers do with
  // permission prompts. "Shown" counts from when the person can see it: a screen opened in a background tab, or brought
  // back from the browser's page cache, starts the moment again when it comes into view.
  const head = useRef<HTMLHeadingElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restart = () => {
      clearTimeout(timer);
      setReady(false);
      if (document.visibilityState === 'visible') timer = setTimeout(() => setReady(true), SEND_DELAY_MS);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') restart(); else { clearTimeout(timer); setReady(false); } };
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) restart(); };
    head.current?.focus();
    restart();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onShow);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('pageshow', onShow); };
  }, []);
  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <h2 className="card-title" id={`${id}-h`} ref={head} tabIndex={-1}>Send this to your Inbox?</h2>
      <p className="footnote">It arrived through Shelf’s share target. Send it only if you shared it just now: another website can open this screen too.</p>
      <dl className="kv">
        {field('title') && <><dt>Title</dt><dd className="wrap">{field('title')}</dd></>}
        {field('url') && <><dt>Link</dt><dd className="wrap mono">{field('url')}</dd></>}
        {field('text') && <><dt>Text</dt><dd className="wrap">{field('text')}</dd></>}
        <dt>Images and videos</dt><dd>{files}</dd>
      </dl>
      {p.dropped > 0 && <Notice kind="warn">{p.dropped} file{p.dropped === 1 ? ' was' : 's were'} too large and left out (an image up to 20 MB, a video up to 64 MB, 100 MB together).</Notice>}
      <p className="footnote">Only one share waits here: sharing again replaces this one.</p>
      {/* Discard first: the safe choice comes first in the tab order. */}
      <div className="btn-row">
        <button type="button" className="btn" onClick={onDiscard}>Discard</button>
        <button type="button" className="btn btn-primary" aria-disabled={!ready} onClick={() => { if (ready) onSend(); }}>Send to the Inbox</button>
      </div>
    </section>
  );
}
