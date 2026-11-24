// A household join link (/join#token; ADR 0011, philobiblos#34 slice 2). The token is read from the #fragment, kept in
// memory only and removed from the address bar at once (Enrol.tsx takeToken). The page shows nothing of the household:
// whoever holds a link gives a name and makes a passkey, then waits for an admin. A link that does not open here gets
// one message, whatever the reason.
import { useCallback, useEffect, useId, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { ApiError, api, message, type AuthSession } from '../api';
import { Notice, PageHead } from '../ui';

interface Start { challengeId: string; options: object }

export function Join({ token, member, onSignedIn }: { token: string | null; member: boolean; onSignedIn: (s: AuthSession) => void }) {
  const nameId = useId();
  const labelId = useId();
  const [opens, setOpens] = useState<boolean | null>(token ? null : false);
  const [name, setName] = useState('');
  const [label, setLabel] = useState('This device');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : 'This link is incomplete. Open the whole link again.');

  // A link that does not open here is final (404); a limit or a hiccup can be tried again, with the token still in memory.
  const [retry, setRetry] = useState(false);
  const check = useCallback(() => {
    if (!token) return;
    setError(null); setRetry(false); setOpens(null);
    api('/join/open', { method: 'POST', body: { token } }).then(() => setOpens(true), (e) => {
      setOpens(false); setError(message(e)); setRetry(!(e instanceof ApiError && e.status === 404));
    });
  }, [token]);
  useEffect(check, [check]);

  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const start = await api<Start>('/join/options', { method: 'POST', body: { token, name: name.trim() } });
      let response;
      try {
        response = await startRegistration({ optionsJSON: start.options as Parameters<typeof startRegistration>[0]['optionsJSON'] });
      } catch { throw new Error('The passkey was not made. Try again when you are ready.'); }
      onSignedIn(await api<AuthSession>('/join/verify', { method: 'POST', body: { challengeId: start.challengeId, response, label: label.trim() || 'Passkey' } }));
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };

  return (
    <main className="auth" id="main" aria-busy={opens === null}>
      <PageHead title="Ask to join" sub="Give your name and make a passkey on this device. An admin of the household then lets you in; there is no password." />
      {member ? (
        <Notice kind="info" title="You are in the household already.">This link is for someone new: send it to them. To use it yourself, sign out first.</Notice>
      ) : opens === false ? (
        <div className="stack">
          {error && <Notice kind="error">{error}</Notice>}
          {retry && <button type="button" className="btn btn-block" onClick={check}>Try again</button>}
        </div>
      ) : (
        <form className="stack" onSubmit={go} noValidate>
          <div className="field">
            <label className="field-label" htmlFor={nameId}>Your name</label>
            <input className="input" id={nameId} value={name} onChange={(e) => setName(e.target.value)} required maxLength={60}
              autoComplete="given-name" aria-describedby={`${nameId}-hint`} disabled={opens !== true} />
            <span className="hint" id={`${nameId}-hint`}>As the household calls you. The admin checks who you are before letting you in.</span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor={labelId}>A name for this passkey</label>
            <input className="input" id={labelId} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} autoComplete="off" disabled={opens !== true} />
          </div>
          <button type="submit" className="btn btn-primary btn-lg btn-block" aria-busy={busy} disabled={busy || opens !== true || !name.trim()}>
            {busy ? 'Waiting for your passkey…' : 'Ask to join'}
          </button>
          {error && <Notice kind="error">{error}</Notice>}
        </form>
      )}
    </main>
  );
}
