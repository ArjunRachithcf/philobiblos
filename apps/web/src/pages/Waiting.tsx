// The one page a person who waits for an admin's approval sees (ADR 0011): nothing of the household, nothing to do but
// wait (or sign out, standalone). Every other route answers them 403.
import type { AuthSession } from '../api';
import { Notice } from '../ui';

export function Waiting({ session, onSignOut }: { session: AuthSession; onSignOut: () => void }) {
  return (
    <main className="auth" id="main">
      <h1 className="large-title">Philobiblos</h1>
      <div className="stack">
        <Notice kind="info" title="Waiting for approval.">
          {session.person?.name ? `${session.person.name}, an` : 'An'} admin of the household lets you in. Until then there is nothing to see here; come back later.
        </Notice>
        {session.mode === 'standalone' && <button type="button" className="btn btn-block" onClick={onSignOut}>Sign out</button>}
      </div>
    </main>
  );
}
