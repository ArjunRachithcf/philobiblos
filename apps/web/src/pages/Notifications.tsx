// Settings → Notifications (Web Push): this browser told when the month's plan is ready. The message says only that;
// the service worker (public/sw.js) shows its own words and opens This month. Each adult's devices are their own.
import { useEffect, useId, useState } from 'react';
import { api, message } from '../api';
import { Notice } from '../ui';

type Device = { id: string; service: string; createdAt: string; lastSentAt: string | null };

const SERVICE: Record<string, string> = { 'fcm.googleapis.com': 'Chrome or Android', 'updates.push.services.mozilla.com': 'Firefox', 'web.push.apple.com': 'Safari' };
const serviceName = (host: string) => SERVICE[host] ?? (host.endsWith('.notify.windows.com') ? 'Edge' : host);
const bytes = (b64u: string) => Uint8Array.from(atob(b64u.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export function Notifications() {
  const id = useId();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState('');
  const load = () => api<Device[]>('/push/subscriptions').then(setDevices, (e) => setError(message(e)));
  useEffect(() => { void load(); }, []);

  const turnOn = async () => {
    setError(null); setOk(''); setBusy(true);
    try {
      if ((await Notification.requestPermission()) !== 'granted') { setError('Notifications are blocked for Shelf in this browser’s settings.'); return; }
      const { publicKey } = await api<{ publicKey: string }>('/push/key');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(publicKey) });
      await api('/push/subscriptions', { method: 'POST', body: sub.toJSON() });
      setOk('This device will be told when the month’s plan is ready.');
      await load();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const remove = async (d: Device) => {
    setError(null); setOk('');
    try { await api(`/push/subscriptions/${encodeURIComponent(d.id)}`, { method: 'DELETE' }); await load(); } catch (e) { setError(message(e)); }
  };
  const test = async () => {
    setError(null); setOk('');
    try { const r = await api<{ detail?: string }>('/push/test', { method: 'POST' }); setOk(`Sent: ${r.detail ?? ''}.`); } catch (e) { setError(message(e)); }
  };

  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <div>
        <h2 className="card-title" id={`${id}-h`}>Notifications</h2>
        <p className="footnote">Once a month, when the plan is ready. The message says only that, nothing about who reads what. It travels through your browser’s push service, encrypted for this device.</p>
      </div>
      {devices === null ? (error ? <Notice kind="error">{error}</Notice> : <p className="sr-only" role="status">Loading</p>) : (
        <>
          {devices.length ? (
            <ul className="group" role="list" aria-label="Your devices">
              {devices.map((d) => (
                <li className="row" key={d.id}>
                  <span className="row-main">
                    <span className="row-title">{serviceName(d.service)}</span>
                    <span className="row-sub">Since {new Date(d.createdAt).toLocaleDateString()}{d.lastSentAt ? ` · last told ${new Date(d.lastSentAt).toLocaleDateString()}` : ''}</span>
                  </span>
                  <span className="row-trail"><button type="button" className="btn btn-sm" aria-label={`Remove ${serviceName(d.service)}`} onClick={() => void remove(d)}>Remove</button></span>
                </li>
              ))}
            </ul>
          ) : <p className="footnote">No device gets notifications yet.</p>}
          {!supported() && <Notice kind="warn">This browser cannot get notifications. On an iPhone, add Shelf to the home screen first.</Notice>}
          {error && <Notice kind="error">{error}</Notice>}
          {ok && <Notice kind="ok">{ok}</Notice>}
          <div className="btn-row">
            {supported() && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void turnOn()}>Notify this device</button>}
            {devices.length > 0 && <button type="button" className="btn" onClick={() => void test()}>Send a test</button>}
          </div>
        </>
      )}
    </section>
  );
}
