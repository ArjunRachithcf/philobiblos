// The phone share screen (spec §4 "Phone share", contracts/connectors.md). A share from the phone's share sheet lands
// in the service worker (public/sw.js), which keeps it for a moment and opens this screen; this screen posts it to
// /api/shares as Shelf's own page (with Shelf's Origin and the session) and then shows how the media worker gets on.
// Without a pending share it is a form: a link, a note and images, by hand.
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
      else reject(new Error(body.error ?? (x.status === 413 ? 'Too many files, or one over 20 MB.' : x.status === 429 ? 'Too many shares; wait a few minutes.' : 'Shelf did not take the share.')));
    };
    x.onerror = () => reject(new Error('Shelf did not answer.'));
    x.send(form);
  });
}

async function takePending(id: string): Promise<FormData | null> {
  if (!PENDING.test(id) || !('caches' in window)) return null;
  const cache = await caches.open(CACHE);
  const key = `/share-pending/${id}`;
  const r = await cache.match(key);
  if (!r) return null;
  const form = await r.formData();
  await cache.delete(key);
  return form;
}

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

  const send = async (form: FormData) => {
    setError(null);
    setSent({ sent: 0, total: 1 });
    try {
      const r = await upload(form, (s, t) => setSent({ sent: s, total: t }));
      history.replaceState(null, '', `/share?id=${r.id}`);
      setShareId(r.id);
    } catch (e) { setError(message(e)); setSent(null); }
  };

  // A share from the phone's share sheet: sent at once, then forgotten by the browser.
  useEffect(() => {
    const p = params.get('pending');
    if (!p || started.current) return;
    started.current = true;
    takePending(p).then((form) => {
      if (form) void send(form);
      else { history.replaceState(null, '', '/share'); setError('That share was sent already, or it is gone. Share it again from your phone.'); }
    }, () => setError('The phone’s share could not be read.'));
  }, []);

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
    : view.status === 'reading' ? `Re-encoding the images: ${done} of ${total}` : view.status === 'done' ? 'Done' : 'It could not be read';

  return (
    <>
      <PageHead title="Share to Shelf" sub="A post’s images, its link and its caption go to your Inbox. Shelf never logs in to Instagram." />
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
            {view?.status === 'done' && <Notice kind="ok" title="In your Inbox.">{total ? `${total - (view.refused ?? 0)} of ${total} image${total === 1 ? '' : 's'} kept${view.refused ? `; ${view.refused} could not be read` : ''}.` : 'The link and the note are kept.'}</Notice>}
            {view?.status === 'failed' && <Notice kind="error" title="Nothing was kept.">{view.error ?? 'The images could not be read.'}</Notice>}
            {view && (view.status === 'done' || view.status === 'failed') && (
              <div className="btn-row">
                <a className="btn btn-primary" href="/inbox" onClick={(e) => { e.preventDefault(); go('/inbox'); }}>Open the Inbox</a>
                <a className="btn" href="/share" onClick={(e) => { e.preventDefault(); history.replaceState(null, '', '/share'); setShareId(null); setView(null); setSent(null); }}>Share something else</a>
              </div>
            )}
          </section>
        )}
        {!sent && !shareId && (
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
              <label className="field-label" htmlFor={`${id}-f`}>Images (JPEG, PNG, WebP or GIF; up to 30)</label>
              <input className="input" id={`${id}-f`} type="file" ref={files} multiple accept="image/jpeg,image/png,image/webp,image/gif" />
            </div>
            <div className="btn-row"><button type="submit" className="btn btn-primary">Send to the Inbox</button></div>
          </form>
        )}
      </div>
    </>
  );
}
