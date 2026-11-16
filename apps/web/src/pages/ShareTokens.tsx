// Settings, "Phone share": your share tokens for an iOS Shortcut (contracts/connectors.md "Phone share"). A new token
// is shown once, as text and as a QR code drawn here from the token (no request leaves the page); after "Done" it is
// gone from the page, and the server never shows it again (it keeps only its hash). A token posts shares and does
// nothing else; revoke one when a phone is lost.
import { useEffect, useId, useState } from 'react';
import qrcode from 'qrcode-generator';
import { api, message, type ShareToken } from '../api';
import { Notice } from '../ui';

/** A QR code as SVG squares: built from the module grid, never from markup. */
export function Qr({ text, label }: { text: string; label: string }) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const cells: [number, number][] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) cells.push([r, c]);
  return (
    <svg className="qr" role="img" aria-label={label} viewBox={`-2 -2 ${n + 4} ${n + 4}`} shapeRendering="crispEdges">
      {cells.map(([r, c]) => <rect key={`${r}.${c}`} x={c} y={r} width={1} height={1} />)}
    </svg>
  );
}

const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null);

export function ShareTokens() {
  const id = useId();
  const [tokens, setTokens] = useState<ShareToken[] | null>(null);
  const [label, setLabel] = useState('iPhone Shortcut');
  const [fresh, setFresh] = useState<{ label: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const load = () => api<ShareToken[]>('/share-tokens').then(setTokens, (e) => setError(message(e)));
  useEffect(() => { void load(); }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<ShareToken & { token: string }>('/share-tokens', { method: 'POST', body: { label: label.trim() || 'Phone' } });
      setFresh({ label: r.label, token: r.token });
      await load();
    } catch (err) { setError(message(err)); }
  };
  const revoke = async (t: ShareToken) => {
    setError(null);
    try { await api(`/share-tokens/${encodeURIComponent(t.id)}`, { method: 'DELETE' }); setStatus(`${t.label}: revoked.`); await load(); } catch (err) { setError(message(err)); }
  };
  const live = (tokens ?? []).filter((t) => !t.revoked);

  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <div>
        <h2 className="card-title" id={`${id}-h`}>Phone share</h2>
        <p className="footnote">On Android, install Shelf from the browser’s menu and share to it. On an iPhone, a Shortcut sends shares with a token of yours: it can post to your Inbox and nothing else.</p>
      </div>
      <p className="sr-only" role="status">{status}</p>
      {fresh ? (
        <div className="stack" role="group" aria-labelledby={`${id}-f`}>
          <h3 className="subhead" id={`${id}-f`}>Your new token for {fresh.label}</h3>
          <Notice kind="warn" title="Shown once.">Put it in the Shortcut now: after Done, Shelf cannot show it again (it keeps only a hash).</Notice>
          <div className="cluster">
            <Qr text={`Bearer ${fresh.token}`} label="QR code of the Shortcut’s Authorization value" />
            <div className="stack">
              <div className="field">
                <label className="field-label" htmlFor={`${id}-t`}>Authorization (the QR code holds the same)</label>
                <input className="input input-secret" id={`${id}-t`} readOnly value={`Bearer ${fresh.token}`} onFocus={(e) => e.currentTarget.select()} />
              </div>
              <p className="footnote">Address: <span className="mono">{location.origin}/api/shares</span></p>
              <ol className="footnote">
                <li>Shortcuts: a new shortcut “Send to Shelf”, shown in the Share Sheet, for images and URLs.</li>
                <li>Add “Convert Image” to JPEG, then “Get Contents of URL”: the address above, method POST, request body Form.</li>
                <li>Header Authorization: scan the QR code with the Camera and paste the text.</li>
                <li>Form fields: “url” the Shortcut Input’s URL, “text” its text, “media” the converted images (one field per image).</li>
              </ol>
            </div>
          </div>
          <div className="btn-row"><button type="button" className="btn btn-primary" onClick={() => { setFresh(null); setStatus('The token is no longer on the page.'); }}>Done</button></div>
        </div>
      ) : (
        <form className="stack" onSubmit={create} noValidate>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-l`}>Name of the phone or Shortcut</label>
            <input className="input" id={`${id}-l`} maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="btn-row"><button type="submit" className="btn">Make a share token</button></div>
        </form>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {tokens && (
        live.length ? (
          <ul className="group" role="list" aria-label="Your share tokens">
            {live.map((t) => (
              <li className="row" key={t.id}>
                <span className="row-main">
                  <span className="row-title">{t.label}</span>
                  <span className="row-sub">Made {day(t.createdAt)} · {t.lastUsedAt ? `last used ${day(t.lastUsedAt)}` : 'not used yet'}</span>
                </span>
                <span className="row-trail"><button type="button" className="btn btn-sm" aria-label={`Revoke ${t.label}`} onClick={() => void revoke(t)}>Revoke</button></span>
              </li>
            ))}
          </ul>
        ) : <p className="footnote">No share tokens yet.</p>
      )}
    </section>
  );
}
