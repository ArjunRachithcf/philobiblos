// A household join link (/join#token; ADR 0011, philobiblos#34 slice 2). The token is read from the #fragment, kept in
// memory only and removed from the address bar at once (Enrol.tsx takeToken). The page shows nothing of the household:
// whoever holds a link gives a name and makes a passkey, then waits for an admin (or is let in at once, when the link's
// rules accept them: slice 3). A link that does not open here gets
// one message, whatever the reason. A link with the mail-domain rule (slice 4a) first asks for an address: a 6-digit code
// goes to it, and the right code lets its domain count for the rules. The page never names the domain, and says the same
// whether a mail went out or not; skipping it, the person asks to join as anyone else does.
import { useCallback, useEffect, useId, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { ApiError, api, message, type AuthSession } from '../api';
import { Notice, PageHead } from '../ui';

interface Start { challengeId: string; options: object }

export function Join({ token, member, onSignedIn }: { token: string | null; member: boolean; onSignedIn: (s: AuthSession) => void }) {
  const nameId = useId();
  const labelId = useId();
  const [opens, setOpens] = useState<boolean | null>(token ? null : false);
  // The mail-domain rule: 'address' (asked), 'code' (a code may be on its way), 'done' (verified or skipped).
  const [step, setStep] = useState<'address' | 'code' | 'done'>('done');
  const [request, setRequest] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [name, setName] = useState('');
  const [label, setLabel] = useState('This device');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : 'This link is incomplete. Open the whole link again.');

  // A link that does not open here is final (404); a limit or a hiccup can be tried again, with the token still in memory.
  const [retry, setRetry] = useState(false);
  const check = useCallback(() => {
    if (!token) return;
    setError(null); setRetry(false); setOpens(null);
    api<{ askAddress?: boolean } | undefined>('/join/open', { method: 'POST', body: { token } }).then((r) => { setStep(r?.askAddress ? 'address' : 'done'); setOpens(true); }, (e) => {
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
      const start = await api<Start>('/join/options', { method: 'POST', body: { token, name: name.trim(), ...(verified && request ? { request } : {}) } });
      let response;
      try {
        response = await startRegistration({ optionsJSON: start.options as Parameters<typeof startRegistration>[0]['optionsJSON'] });
      } catch { throw new Error('The passkey was not made. Try again when you are ready.'); }
      onSignedIn(await api<AuthSession>('/join/verify', { method: 'POST', body: { challengeId: start.challengeId, response, label: label.trim() || 'Passkey' } }));
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };

  return (
    <main className="auth" id="main" aria-busy={opens === null}>
      <PageHead title="Ask to join" sub="Give your name and make a passkey on this device. An admin of the household then lets you in, or the link does at once; there is no password." />
      {member ? (
        <Notice kind="info" title="You are in the household already.">This link is for someone new: send it to them. To use it yourself, sign out first.</Notice>
      ) : opens === true && step !== 'done' ? (
        <AddressStep token={token!} step={step} onSent={(r) => { setRequest(r); setStep('code'); }} onAgain={() => setStep('address')}
          onVerified={() => { setVerified(true); setStep('done'); }} onSkip={() => { setRequest(null); setStep('done'); }} request={request} />
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
          {verified && <p className="hint" role="status">Your address is confirmed for the next 30 minutes: ask to join before then.</p>}
          {error && <Notice kind="error">{error}</Notice>}
        </form>
      )}
    </main>
  );
}

/** The mail-domain rule's step: an address, then the code it was sent. The same words whether a mail went out or not. */
function AddressStep({ token, step, request, onSent, onVerified, onAgain, onSkip }: {
  token: string; step: 'address' | 'code'; request: string | null;
  onSent: (request: string) => void; onVerified: () => void; onAgain: () => void; onSkip: () => void;
}) {
  const id = useId();
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await f(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  if (step === 'address') {
    return (
      <form className="stack" noValidate onSubmit={(e) => { e.preventDefault(); void run(async () => onSent((await api<{ request: string }>('/join/code', { method: 'POST', body: { token, address: address.trim() } })).request)); }}>
        <div className="field">
          <label className="field-label" htmlFor={id}>Your mail address</label>
          <input className="input" id={id} type="email" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={254} autoComplete="email"
            inputMode="email" aria-describedby={`${id}-hint`} />
          <span className="hint" id={`${id}-hint`}>If the household lets in addresses like yours, a 6-digit code to it lets you in. The mail holds the code alone.</span>
        </div>
        <button type="submit" className="btn btn-primary btn-lg btn-block" aria-busy={busy} disabled={busy || !address.trim()}>Send me a code</button>
        <button type="button" className="btn btn-block" onClick={onSkip}>Ask to join without it</button>
        {error && <Notice kind="error">{error}</Notice>}
      </form>
    );
  }
  return (
    <form className="stack" noValidate onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('/join/code/check', { method: 'POST', body: { request, code: code.trim() } }); onVerified(); }); }}>
      <p className="hint" role="status">If that address can join this way, a code is on its way to it. It works for 10 minutes, on this page only.</p>
      <div className="field">
        <label className="field-label" htmlFor={id}>The code</label>
        <input className="input mono" id={id} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric"
          autoComplete="one-time-code" maxLength={6} />
      </div>
      <button type="submit" className="btn btn-primary btn-lg btn-block" aria-busy={busy} disabled={busy || code.length !== 6}>Check the code</button>
      <div className="btn-row">
        <button type="button" className="btn" onClick={onAgain}>Send a new code</button>
        <button type="button" className="btn" onClick={onSkip}>Ask to join without it</button>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
    </form>
  );
}
