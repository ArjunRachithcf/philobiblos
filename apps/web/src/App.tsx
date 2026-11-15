// Shelf's web app. M1 so far: sign-in, the one-time links, and the household. A screen never calls the network
// beyond Shelf's own API (ADR 0003).
import { useCallback, useEffect, useState } from 'react';
import { api, message, type AuthSession, type Me } from './api';
import { Enrol, takeToken } from './pages/Enrol';
import { Household } from './pages/Household';
import { SignIn } from './pages/SignIn';
import { Notice } from './ui';

const path = () => location.pathname.replace(/\/+$/, '') || '/';

export function App() {
  const [route, setRoute] = useState(path);
  const [token] = useState(() => (route === '/setup' || route === '/enrol' ? takeToken() : null));
  const [session, setSession] = useState<AuthSession | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const go = useCallback((to: string) => { history.pushState(null, '', to); setRoute(to); }, []);
  useEffect(() => {
    const pop = () => setRoute(path());
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);

  const loadMe = useCallback(async () => setMe(await api<Me>('/me')), []);
  useEffect(() => {
    api<AuthSession>('/auth/session').then(setSession, (e) => setError(message(e)));
  }, []);
  useEffect(() => {
    if (session?.signedIn) loadMe().catch((e) => setError(message(e)));
  }, [session, loadMe]);

  const signedIn = (s: AuthSession) => { setSession(s); go('/household'); };
  const signOut = async () => {
    await api('/auth/sign-out', { method: 'POST' }).catch(() => undefined);
    setMe(null);
    setSession(await api<AuthSession>('/auth/session'));
    go('/');
  };

  if (error) return <main className="auth" id="main"><h1 className="large-title">Shelf</h1><Notice kind="error" title="Shelf did not answer.">{error}</Notice></main>;
  if (!session) return <main className="auth" id="main" aria-busy="true"><p className="sr-only">Loading</p></main>;
  if (route === '/setup' || route === '/enrol') return <Enrol kind={route === '/setup' ? 'setup' : 'enrol'} token={token} onSignedIn={signedIn} />;
  if (!session.signedIn) return <SignIn session={session} onSignedIn={signedIn} />;

  return (
    <>
      <a className="sr-only skip" href="#main">Skip to the page</a>
      <header className="bar glass">
        <div className="page bar-inner">
          <a className="brand-name" href="/" onClick={(e) => { e.preventDefault(); go('/household'); }}>Shelf</a>
          <nav aria-label="Shelf">
            <a className="nav-link" href="/household" aria-current={route === '/household' || route === '/' ? 'page' : undefined}
              onClick={(e) => { e.preventDefault(); go('/household'); }}>Household</a>
          </nav>
          {session.mode === 'standalone' && <button type="button" className="btn btn-sm" onClick={signOut}>Sign out</button>}
        </div>
      </header>
      <main className="page" id="main">
        {me ? <Household me={me} reload={loadMe} /> : <p className="sr-only" role="status">Loading</p>}
      </main>
    </>
  );
}
