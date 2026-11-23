// Settings, "Mailbox" (philobiblos#27, docs/mail-providers.md): the Philobiblos-only mailbox as the server's environment
// sets it up. With an app password there is nothing to do here. With XOAUTH2 (the household's own OAuth client) an
// admin reads what connecting allows and connects, with a sign-in of the last few minutes: the browser goes to the
// provider, which sends it back to /settings/mail-oauth with a code and a state. That address is read once, when this
// module loads (before the app reads its route), and taken out of the address bar and the history at once; the code goes
// to the server once, which exchanges it and keeps the tokens sealed. No token ever reaches this page.
import { useEffect, useId, useState } from 'react';
import { api, message, type MailSettings, type Settings } from '../api';
import { Notice } from '../ui';

export const OAUTH_RETURN = '/settings/mail-oauth';
export interface OAuthReturn { state: string; code?: string; error?: string }

/** What the provider sent back, if this is its return: read once, and gone from the address bar at once. */
export function takeOAuthReturn(): OAuthReturn | null {
  if (location.pathname.replace(/\/+$/, '') !== OAUTH_RETURN) return null;
  const q = new URLSearchParams(location.search);
  history.replaceState(null, '', '/settings');
  const state = q.get('state'), code = q.get('code'), error = q.get('error');
  if (!state) return null;
  return { state, ...(code ? { code } : {}), ...(error ? { error } : {}) };
}

/** The provider's return, until the Mailbox card hands it to the server. */
let returned: OAuthReturn | null = typeof location === 'undefined' ? null : takeOAuthReturn();

export function Mailbox({ admin }: { admin: boolean }) {
  const id = useId();
  const [mail, setMail] = useState<MailSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<Settings>('/settings').then((s) => setMail(s.mail ?? null), (e) => setError(message(e)));

  useEffect(() => {
    // The provider's answer goes to the server once, whatever renders this card again.
    const back = admin ? returned : null;
    if (!back) { void load(); return; }
    returned = null;
    api<MailSettings>('/mail/oauth/finish', { method: 'POST', body: back })
      .then((m) => { setMail(m); setOk('The mailbox is connected. The mail job signs in with its token from now on.'); }, (e) => { setError(message(e)); void load(); });
  }, [admin]);

  const connect = async () => {
    if (!mail?.oauth || mail.oauth.connectBlocked) return;
    setError(null); setOk(''); setBusy(true);
    try {
      const { authorizeUrl } = await api<{ authorizeUrl: string }>('/mail/oauth/start', { method: 'POST', body: { accept: mail.oauth.allowsVersion } });
      location.assign(authorizeUrl);
    } catch (err) { setError(message(err)); setBusy(false); }
  };
  const disconnect = async () => {
    setError(null); setOk('');
    try {
      const { revoked } = await api<{ revoked: boolean | null }>('/mail/oauth', { method: 'DELETE' });
      setOk(revoked === true ? 'Disconnected: the token is forgotten here and revoked at the provider.'
        : revoked === null ? 'Disconnected: the token is forgotten here. The provider has no revocation endpoint: also remove Philobiblos from the account’s connected apps.'
        : 'Disconnected: the token is forgotten here, but the provider did not confirm it revoked it. Remove Philobiblos from the account’s connected apps.');
      await load();
    } catch (err) { setError(message(err)); }
  };

  const o = mail?.oauth;
  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <div>
        <h2 className="card-title" id={`${id}-h`}>Mailbox</h2>
        <p className="footnote">The mailbox only the bookshop’s mail is forwarded to. Philobiblos reads one folder of it, read-only, and never sends mail.</p>
      </div>
      {!mail ? (error ? <Notice kind="error">{error}</Notice> : <p className="sr-only" role="status">Loading</p>)
        : !mail.configured ? <p>No mailbox is set up on the server yet (docs/mail-providers.md).</p>
        : (
          <>
            <p>{mail.user} at {mail.host}{mail.port !== 993 ? `:${mail.port}` : ''}, the folder {mail.folder}, {mail.auth === 'xoauth2' ? 'with a token from the household’s own OAuth client.' : 'with an app password from the server’s settings.'}</p>
            {o && !admin && <p className="footnote">{o.connected ? 'It is connected.' : 'It is not connected yet.'} An admin of the household connects it.</p>}
            {o && admin && (
              <>
                {o.needsReconnect && <Notice kind="warn" title="The mailbox needs connecting again.">The OAuth client or the mailbox changed on the server, or the token was sealed under another key: it is not used.</Notice>}
                <p>{o.connected ? <>Connected{o.connectedAt ? ` since ${new Date(o.connectedAt).toLocaleDateString()}` : ''}.</> : 'Not connected.'}</p>
                <h3 className="field-label">What connecting allows</h3>
                <ul className="footnote">{o.allows.map((l) => <li key={l}>{l}.</li>)}</ul>
                <p className="footnote">The redirect URI to register with the provider: <code>{o.redirectUri}</code></p>
                <div className="btn-row">
                  <button type="button" className="btn btn-primary" aria-disabled={o.connectBlocked || busy ? true : undefined} aria-describedby={o.connectBlocked ? `${id}-why` : undefined} onClick={() => void connect()}>
                    {o.connected ? 'Connect again' : 'Connect the mailbox'}
                  </button>
                  {(o.connected || o.needsReconnect) && <button type="button" className="btn" onClick={() => void disconnect()}>Disconnect</button>}
                </div>
                {o.connectBlocked && <p className="footnote" id={`${id}-why`}>It cannot be connected now; {o.connectBlocked}.</p>}
              </>
            )}
            {error && <Notice kind="error">{error === 'sign in again to do this' ? 'Sign in again to connect the mailbox: it needs a sign-in of the last few minutes.' : error}</Notice>}
            {ok && <Notice kind="ok">{ok}</Notice>}
          </>
        )}
    </section>
  );
}
