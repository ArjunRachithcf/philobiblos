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
        <h1 className="large-title">Philobiblos</h1>
        <Notice kind="info" title="Open Philobiblos from HomersLab.">HomersLab signs you in; Philobiblos has no sign-in of its own here.</Notice>
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
      <h1 className="large-title">Philobiblos</h1>
      <p className="auth-sub">What to read next, and the month's order.</p>
      <div className="stack">
        {session.setupNeeded && (
          <Notice kind="info" title="Philobiblos needs its first admin.">
            Open the setup link in the file <code>setup-link.txt</code> in Philobiblos's data folder. It works once, for 24 hours;
            restarting Philobiblos makes a new one.
          </Notice>
        )}
        <button type="button" className="btn btn-primary btn-lg btn-block" onClick={go} aria-busy={busy} disabled={busy}>
          {busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
        </button>
        {error && <Notice kind="error">{error}</Notice>}
        <p className="footnote">
          No passkey yet? An admin of the household sends you a link to make one. An admin who lost every passkey asks
          whoever runs Philobiblos for a recovery link (<code>philobiblos recover</code>).
        </p>
      </div>
    </main>
  );
}
