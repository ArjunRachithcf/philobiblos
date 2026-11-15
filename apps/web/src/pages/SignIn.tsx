import { useState } from 'react';
import { message, type AuthSession } from '../api';
import { signIn } from '../passkeys';
import { Notice } from '../ui';

export function SignIn({ session, onSignedIn }: { session: AuthSession; onSignedIn: (s: AuthSession) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (session.mode === 'homerslab') {
    return (
      <main className="auth" id="main">
        <h1 className="large-title">Shelf</h1>
        <Notice kind="info" title="Open Shelf from HomersLab.">HomersLab signs you in; Shelf has no sign-in of its own here.</Notice>
      </main>
    );
  }
  const go = async () => {
    setBusy(true);
    setError(null);
    try { onSignedIn(await signIn()); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return (
    <main className="auth" id="main">
      <h1 className="large-title">Shelf</h1>
      <p className="auth-sub">What to read next, and the month's order.</p>
      {session.setupNeeded ? (
        <Notice kind="info" title="Shelf needs its first admin.">
          Open the setup link in the file <code>setup-link.txt</code> in Shelf's data folder. It works once, for 24 hours;
          restarting Shelf makes a new one.
        </Notice>
      ) : (
        <div className="stack">
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={go} aria-busy={busy} disabled={busy}>
            {busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
          </button>
          {error && <Notice kind="error">{error}</Notice>}
          <p className="footnote">No passkey yet? An admin of the household sends you a link to make one.</p>
        </div>
      )}
    </main>
  );
}
