// The one-time links: the first admin's setup link (/setup#token) and an invite (/enrol#token). The token is read
// from the #fragment, kept in memory only, and removed from the address bar and history at once.
import { useEffect, useId, useState } from 'react';
import { message, type AuthSession } from '../api';
import { enrolOptions, finishEnrol } from '../passkeys';
import { Notice, PageHead } from '../ui';

export function takeToken(): string | null {
  const t = location.hash.slice(1);
  if (location.hash) history.replaceState(null, '', location.pathname);
  return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
}

export function Enrol({ kind, token, onSignedIn }: { kind: 'setup' | 'enrol'; token: string | null; onSignedIn: (s: AuthSession) => void }) {
  const nameId = useId();
  const labelId = useId();
  const [name, setName] = useState('');
  const [label, setLabel] = useState('This device');
  const [invitee, setInvitee] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : 'This link is incomplete. Open the whole link again.');

  useEffect(() => {
    if (kind !== 'enrol' || !token) return;
    // Who the invite is for; the options are fetched again when the passkey is made.
    enrolOptions(token).then((s) => setInvitee(s.person?.name ?? null), (e) => setError(message(e)));
  }, [kind, token]);

  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const start = await enrolOptions(token, kind === 'setup' ? name.trim() : undefined);
      onSignedIn(await finishEnrol(start, label.trim() || 'Passkey'));
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  };

  const title = kind === 'setup' ? 'Set up Philobiblos' : invitee ? `Welcome, ${invitee}` : 'Make your passkey';
  return (
    <main className="auth" id="main">
      <PageHead title={title} sub={kind === 'setup'
        ? 'You become the household’s admin. Your passkey signs you in; there is no password.'
        : 'A passkey on this device signs you in to the household’s Philobiblos; there is no password.'} />
      <form className="stack" onSubmit={go} noValidate>
        {kind === 'setup' && (
          <div className="field">
            <label className="field-label" htmlFor={nameId}>Your name</label>
            <input className="input" id={nameId} value={name} onChange={(e) => setName(e.target.value)} required maxLength={60}
              autoComplete="given-name" aria-describedby={`${nameId}-hint`} />
            <span className="hint" id={`${nameId}-hint`}>As the household calls you. If the household was imported, use the admin’s name there.</span>
          </div>
        )}
        <div className="field">
          <label className="field-label" htmlFor={labelId}>A name for this passkey</label>
          <input className="input" id={labelId} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} autoComplete="off" />
        </div>
        <button type="submit" className="btn btn-primary btn-lg btn-block" aria-busy={busy}
          disabled={busy || !token || (kind === 'setup' && !name.trim())}>
          {busy ? 'Waiting for your passkey…' : 'Create a passkey'}
        </button>
        {error && <Notice kind="error">{error}</Notice>}
      </form>
    </main>
  );
}
