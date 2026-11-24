// Philobiblos's web app: sign-in, the one-time links, the household, this month, the inbox and phone share, the brain and its proposals,
// the library, the backlog and the budget. A screen never calls the network
// beyond Philobiblos's own API (ADR 0003).
import { useCallback, useEffect, useState } from 'react';
import { api, message, type AuthSession, type Me } from './api';
import { Enrol, takeToken } from './pages/Enrol';
import { Household } from './pages/Household';
import { Backlog } from './pages/Backlog';
import { Brain } from './pages/Brain';
import { Proposals } from './pages/Proposals';
import { ThisMonth } from './pages/ThisMonth';
import { Library } from './pages/Library';
import { Settings } from './pages/Settings';
// Imported before the route is read: it takes the mail provider's return out of the address bar (Settings, Mailbox).
import './pages/Mailbox';
import { Inbox } from './pages/Inbox';
import { Share } from './pages/Share';
import { SignIn } from './pages/SignIn';
import { Notice } from './ui';
import { MoneyContext } from './money';

const NAV = [['/month', 'This month'], ['/inbox', 'Inbox'], ['/brain', 'Brain'], ['/proposals', 'Proposals'], ['/backlog', 'Backlog'], ['/library', 'Library'], ['/settings', 'Settings']] as const;
const NAV_KID = NAV.filter(([to]) => to !== '/brain' && to !== '/proposals' && to !== '/month' && to !== '/inbox');
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

  if (error) return <main className="auth" id="main"><h1 className="large-title">Philobiblos</h1><Notice kind="error" title="Philobiblos did not answer.">{error}</Notice></main>;
  if (!session) return <main className="auth" id="main" aria-busy="true"><p className="sr-only">Loading</p></main>;
  if (route === '/setup' || route === '/enrol') return <Enrol kind={route === '/setup' ? 'setup' : 'enrol'} token={token} onSignedIn={signedIn} />;
  if (!session.signedIn) return <SignIn session={session} onSignedIn={signedIn} />;

  return (
    <>
      <a className="sr-only skip" href="#main">Skip to the page</a>
      <header className="bar glass">
        <div className="page bar-inner">
          <a className="brand-name" href="/" onClick={(e) => { e.preventDefault(); go('/household'); }}>Philobiblos</a>
          <nav aria-label="Philobiblos">
            <a className="nav-link" href="/household" aria-current={route === '/household' || route === '/' ? 'page' : undefined}
              onClick={(e) => { e.preventDefault(); go('/household'); }}>Household</a>
            {(me?.person?.role === 'kid' ? NAV_KID : NAV).map(([to, label]) => (
              <a key={to} className="nav-link" href={to} aria-current={route === to ? 'page' : undefined}
                onClick={(e) => { e.preventDefault(); go(to); }}>{label}</a>
            ))}
          </nav>
          {session.mode === 'standalone' && <button type="button" className="btn btn-sm" onClick={signOut}>Sign out</button>}
        </div>
      </header>
      <main className="page" id="main">
        {/* The household's currency for every amount on the screens (money.ts); Settings changes it, then /me is read again. */}
        <MoneyContext.Provider value={{ currency: me?.money?.currency ?? null, unknownPrice: me?.money?.unknownPrice ?? null, priceLimits: me?.money?.priceLimits ?? null }}>
        {!me ? <p className="sr-only" role="status">Loading</p>
          : route === '/month' ? <ThisMonth me={me} go={go} />
          : route === '/brain' ? <Brain me={me} go={go} />
          : route === '/proposals' ? <Proposals />
          : route === '/library' ? <Library me={me} />
          : route === '/backlog' ? <Backlog me={me} />
          : route === '/settings' ? <Settings me={me} reload={loadMe} />
          : route === '/inbox' ? <Inbox me={me} />
          : route === '/share' ? <Share go={go} />
          : <Household me={me} reload={loadMe} />}
        </MoneyContext.Provider>
      </main>
    </>
  );
}
