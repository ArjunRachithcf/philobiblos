// People → Home network and Join links (standalone, admins; ADR 0011, philobiblos#34 slice 2). A join link opens only
// from the household's networks, so until one is listed no link can be made; the page proposes the private range the
// admin is on, for them to confirm. A new link is shown once (its token is never kept); revoking one declines the
// people who wait after using it. A link's rules (slice 3) only narrow the household's: ranges inside the home network,
// letting in at once (as an adult) whoever matches, and refusing whoever does not instead of letting them wait.
import { useCallback, useEffect, useId, useState } from 'react';
import { api, message, type HomeNetworks, type JoinLink } from '../api';
import { Notice } from '../ui';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

export function JoinLinks({ changes, onChanged }: { changes: number; onChanged: () => Promise<void> }) {
  const [nets, setNets] = useState<HomeNetworks | null>(null);
  const [links, setLinks] = useState<JoinLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ url: string; expiresAt: string; maxUses: number } | null>(null);
  const load = useCallback(async () => {
    try {
      const [n, l] = await Promise.all([api<HomeNetworks>('/people/home-networks'), api<JoinLink[]>('/people/join-links')]);
      setNets(n); setLinks(l);
    } catch (e) { setError(message(e)); }
  }, []);
  useEffect(() => { void load(); }, [load, changes]);
  const act = async (f: () => Promise<unknown>) => {
    setError(null);
    try { await f(); await onChanged(); } catch (e) { setError(message(e)); }
  };
  if (!nets || !links) return error ? <Notice kind="error">{error}</Notice> : null;
  const save = (networks: string[]) => act(() => api('/people/home-networks', { method: 'PUT', body: { networks } }));
  return (
    <>
      {error && <Notice kind="error">{error}</Notice>}
      <HomeNetwork nets={nets} onSave={save} />
      <section className="group-block" aria-labelledby="links-h">
        <div className="group-head"><h2 id="links-h">Join links</h2><span>{links.filter((l) => l.open).length}</span></div>
        {links.length > 0 && (
          <ul className="group" role="list">
            {links.map((l) => (
              <li key={l.id} className="row">
                <span className="row-main">
                  <span className="row-title">{l.open ? `Until ${when(l.expiresAt)}` : 'Closed'}</span>
                  <span className="row-sub wrap">
                    {[`${l.uses} of ${l.maxUses} used`, l.waiting ? `${l.waiting} waiting` : null, l.createdBy ? `made by ${l.createdBy}` : null].filter(Boolean).join(' · ')}
                  </span>
                  <span className="row-sub wrap">
                    {[l.networks ? `only from ${l.networks.join(', ')}` : 'from the home network',
                      l.accept === 'automatic' ? 'lets in at once whoever matches' : 'you approve everyone',
                      l.nonMatches === 'refuse' ? 'refuses the rest' : null].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="row-trail">
                  <button type="button" className="btn btn-sm btn-destructive" aria-label={`Revoke the join link made ${when(l.createdAt)}`}
                    onClick={() => {
                      if (confirm(l.waiting ? `Revoke this link? The ${l.waiting} people waiting after using it are declined.` : 'Revoke this link?')) void act(() => api(`/people/join-links/${l.id}`, { method: 'DELETE' }));
                    }}>Revoke</button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {made && <MadeLink {...made} onDone={() => setMade(null)} />}
        <NewLink disabled={!nets.networks.length} home={nets.networks.map((n) => n.cidr)} onMake={(body) => act(async () => setMade(await api('/people/join-links', { method: 'POST', body })))} />
        <p className="group-foot">
          {nets.networks.length
            ? 'A join link opens only from the home network. Whoever opens it gives a name and makes a passkey, then waits here for you, unless the link lets in at once whoever matches its rules (always as an adult, never an admin). A link’s rules only narrow the home network. Making or revoking a link needs a sign-in in the last 10 minutes.'
            : 'List the home network first: a join link opens only from it.'}
        </p>
      </section>
    </>
  );
}

function HomeNetwork({ nets, onSave }: { nets: HomeNetworks; onSave: (networks: string[]) => Promise<void> }) {
  const id = useId();
  const [range, setRange] = useState('');
  const list = nets.networks.map((n) => n.cidr);
  const add = (cidr: string) => { setRange(''); void onSave([...list, cidr]); };
  return (
    <section className="group-block" aria-labelledby={`${id}-h`}>
      <div className="group-head"><h2 id={`${id}-h`}>Home network</h2></div>
      {list.length > 0 && (
        <ul className="group" role="list">
          {list.map((c) => (
            <li key={c} className="row">
              <span className="row-main"><span className="row-title mono">{c}</span></span>
              <span className="row-trail">
                <button type="button" className="btn btn-sm btn-destructive" aria-label={`Remove ${c}`} onClick={() => void onSave(list.filter((x) => x !== c))}>Remove</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Surroundings nets={nets} />
      {nets.proposal && !list.includes(nets.proposal) && (
        <div className="btn-row">
          <span className="hint">You are on {nets.proposal}. Is that the home network?</span>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => add(nets.proposal!)}>Add {nets.proposal}</button>
        </div>
      )}
      <form className="btn-row" onSubmit={(e) => { e.preventDefault(); if (range.trim()) add(range.trim()); }} noValidate>
        <label className="sr-only" htmlFor={`${id}-range`}>A range, such as 192.0.2.0/24</label>
        <input className="input mono" id={`${id}-range`} value={range} onChange={(e) => setRange(e.target.value)} placeholder="192.0.2.0/24" maxLength={64} autoComplete="off" />
        <button type="submit" className="btn btn-sm" disabled={!range.trim()}>Add the range</button>
      </form>
      <p className="group-foot">
        The ranges a join link opens from (CIDRs). A guest network on the same range counts as home. Behind a reverse proxy
        every visitor has the proxy’s address.
      </p>
    </section>
  );
}

/** Why no join link opens for anyone, if none does: what Philobiblos sees of the admin says how every visitor arrives. */
function Surroundings({ nets }: { nets: HomeNetworks }) {
  if (nets.surroundings === 'no-ipv6-route') {
    return (
      <Notice kind="warn" title="No join link opens on this machine.">
        The host started with IPv6 turned off (ipv6.disable=1), so Philobiblos cannot read its container’s IPv6 routes
        and cannot tell a proxy or a published port from a person. Every visitor counts as outside the home network:
        invite people one by one instead, or start the host with IPv6 on.
      </Notice>
    );
  }
  if (nets.surroundings === 'unreadable') {
    return (
      <Notice kind="warn" title="No join link opens on this machine.">
        Philobiblos cannot read its container’s networks and routes, so it cannot tell a proxy or a published port from a
        person, and every visitor counts as outside the home network. Invite people one by one instead.
      </Notice>
    );
  }
  if (!nets.behindProxy) return null;
  return nets.trustedProxy ? (
    <Notice kind="warn" title="Join links wait for the trusted proxy’s address.">
      You came through a proxy that is not PHILOBIBLOS_TRUSTED_PROXY, or the trusted proxy sent no X-Forwarded-For that
      Philobiblos can read, so no visitor that way is on the home network. Set the proxy’s address in
      PHILOBIBLOS_TRUSTED_PROXY and have it set X-Forwarded-For; until then, invite people one by one.
    </Notice>
  ) : (
    <Notice kind="warn" title="Join links wait for the trusted proxy.">
      Philobiblos sees you through a proxy or a published port, so every visitor has the same address and none is on the
      home network. Set PHILOBIBLOS_TRUSTED_PROXY to the proxy’s address (one it sets X-Forwarded-For for); until then no
      join link opens: invite people one by one instead.
    </Notice>
  );
}

interface NewLinkBody { days: number; uses: number; accept: 'approval' | 'automatic'; nonMatches: 'wait' | 'refuse'; networks?: string[] }

function NewLink({ disabled, home, onMake }: { disabled: boolean; home: string[]; onMake: (body: NewLinkBody) => Promise<void> }) {
  const id = useId();
  const [days, setDays] = useState('7');
  const [uses, setUses] = useState('5');
  const [accept, setAccept] = useState<NewLinkBody['accept']>('approval');
  const [nonMatches, setNonMatches] = useState<NewLinkBody['nonMatches']>('wait');
  const [only, setOnly] = useState('');
  const ranges = only.split(/[\s,]+/).filter(Boolean);
  const body = (): NewLinkBody => ({ days: Number(days), uses: Number(uses), accept, nonMatches, ...(ranges.length ? { networks: ranges } : {}) });
  return (
    <form className="fields fields-2" onSubmit={(e) => { e.preventDefault(); void onMake(body()); }} noValidate aria-label="A new join link">
      <div className="field">
        <label className="field-label" htmlFor={`${id}-days`}>Days it works</label>
        <input className="input" id={`${id}-days`} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, '').slice(0, 2))} disabled={disabled} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-uses`}>People it lets ask</label>
        <input className="input" id={`${id}-uses`} inputMode="numeric" value={uses} onChange={(e) => setUses(e.target.value.replace(/\D/g, '').slice(0, 2))} disabled={disabled} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-accept`}>Who gets in</label>
        <select className="input select" id={`${id}-accept`} value={accept} onChange={(e) => setAccept(e.target.value as NewLinkBody['accept'])} disabled={disabled}>
          <option value="approval">Everyone waits for an admin</option>
          <option value="automatic">Whoever matches gets in at once, as an adult</option>
        </select>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-non`}>Whoever does not match</label>
        <select className="input select" id={`${id}-non`} value={nonMatches} onChange={(e) => setNonMatches(e.target.value as NewLinkBody['nonMatches'])} disabled={disabled}>
          <option value="wait">Waits for an admin</option>
          <option value="refuse">Is turned away</option>
        </select>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-only`}>Only from (optional)</label>
        <input className="input mono" id={`${id}-only`} value={only} onChange={(e) => setOnly(e.target.value)} placeholder={home[0] ?? '192.0.2.0/24'} maxLength={400}
          autoComplete="off" disabled={disabled} aria-describedby={`${id}-only-hint`} />
        <span className="hint" id={`${id}-only-hint`}>Ranges inside the home network, to narrow it; left empty, all of it. Outside the home network a link never opens.</span>
      </div>
      {accept === 'automatic' && (
        <p className="hint wrap">Anyone with this link{ranges.length ? `, on ${ranges.join(' or ')},` : ', on the home network,'} becomes an adult of the household at once, without you seeing them first. A guest on the same Wi-Fi counts too.</p>
      )}
      <div className="btn-row"><button type="submit" className="btn btn-primary" disabled={disabled || !days || !uses}>Make a join link</button></div>
    </form>
  );
}

function MadeLink({ url, expiresAt, maxUses, onDone }: { url: string; expiresAt: string; maxUses: number; onDone: () => void }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <h2 className="card-title" id={`${id}-h`}>A new join link</h2>
      <div className="field">
        <label className="field-label" htmlFor={id}>Send it yourself; it lets {maxUses} {maxUses === 1 ? 'person' : 'people'} ask to join, until {when(expiresAt)}.</label>
        <input className="input mono" id={id} readOnly value={url} onFocus={(e) => e.target.select()} />
        <span className="hint">Philobiblos shows it only now. Anyone with the link, on the home network, can ask to join; its rules say who gets in at once and who waits for you.</span>
      </div>
      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={() => navigator.clipboard?.writeText(url).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy the link'}</button>
        <button type="button" className="btn" onClick={onDone}>Done</button>
      </div>
      <p className="sr-only" role="status">{copied ? 'The link is copied.' : ''}</p>
    </section>
  );
}
