// The household (spec §2, the design's "Family"): who is in it, their role, kids' age bands. Admins add people,
// change roles, invite adults to make a passkey, make join links from the home network (JoinLinks.tsx), and remove
// people. Under HomersLab it is read-only here, but for the people who wait to join (ADR 0011): admins approve or
// decline them, in both modes. A household of one shows only you.
import { useCallback, useEffect, useId, useState } from 'react';
import { api, message, type Me, type Passkey, type Person, type PersonInput, type WaitingPerson } from '../api';
import { Notice, PageHead, initials } from '../ui';
import { JoinLinks } from './JoinLinks';

const ROLE_TEXT: Record<Person['role'], string> = { admin: 'Admin · sets the budget and the rules', adult: 'Adult · shares posts, adds books, marks orders', kid: 'Kid' };
const AVATAR: Record<Person['role'], string> = { admin: 'av-admin', adult: 'av-adult', kid: 'av-kid' };

function sub(p: Person) {
  if (p.role !== 'kid') return ROLE_TEXT[p.role];
  return p.ageBand ? `Kid · ${p.ageBand.replace('-', '–')} years` : 'Kid';
}

export function Household({ me, reload }: { me: Me; reload: () => Promise<void> }) {
  const isAdmin = me.person?.role === 'admin';
  const editable = isAdmin && me.mode === 'standalone';
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ name: string; url: string; expiresAt: string } | null>(null);
  // Bumped by every decision and every link revoked: the waiting list and the links read again together.
  const [changes, setChanges] = useState(0);
  const changed = async () => { setChanges((n) => n + 1); await reload(); };

  const act = async (f: () => Promise<unknown>) => {
    setError(null);
    try { await f(); await reload(); } catch (e) { setError(message(e)); }
  };

  // A household of one (ADR 0011): no family sections until a second person is there.
  const alone = (me.household?.length ?? 0) < 2;
  return (
    <>
      <PageHead title="Household" sub={me.mode === 'homerslab'
        ? 'People come from Homeward: add, remove or change them there.'
        : alone ? 'Just you for now. Add someone, or a kid to pick books for, and Philobiblos shows the family’s parts.'
        : 'Everyone who uses Philobiblos, and the kids it picks books for. Kids never sign in; adults act for them.'} />
      <div className="stack">
        {error && <Notice kind="error">{error}</Notice>}
        {isAdmin && <WaitingList mode={me.mode ?? 'standalone'} changes={changes} onDecided={changed} />}
        <section className="group-block" aria-labelledby="people-h">
          <div className="group-head"><h2 id="people-h">{alone ? 'You' : 'People'}</h2>{!alone && <span>{me.household?.length ?? 0}</span>}</div>
          <ul className="group lead-lg" role="list">
            {(me.household ?? []).map((p) => (
              <li key={p.id} className="row">
                <span className={`avatar ${AVATAR[p.role]}`} aria-hidden="true">{initials(p.name)}</span>
                <span className="row-main">
                  <span className="row-title">{p.name}{p.id === me.person?.id ? ' (you)' : ''}</span>
                  <span className="row-sub wrap">{sub(p)}</span>
                </span>
                <span className="row-trail">
                  {p.role !== 'kid' && me.mode === 'standalone' && !p.signsIn && <span className="pill pill-orange">No passkey yet</span>}
                  {editable && p.role !== 'kid' && p.id !== me.person?.id && !p.signsIn && (
                    <button type="button" className="btn btn-sm" aria-label={`Invite ${p.name} to make a passkey`}
                      onClick={() => act(async () => setInvite({ name: p.name, ...(await api<{ url: string; expiresAt: string }>(`/people/${p.id}/invites`, { method: 'POST' })) }))}>
                      Invite
                    </button>
                  )}
                  {editable && p.id !== me.person?.id && (
                    <button type="button" className="btn btn-sm btn-destructive" aria-label={`Remove ${p.name}`}
                      onClick={() => { if (confirm(`Remove ${p.name} from the household, with their reading?`)) void act(() => api(`/people/${p.id}`, { method: 'DELETE' })); }}>
                      Remove
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
        {invite && <InviteLink {...invite} onDone={() => setInvite(null)} />}
        {editable && <AddPerson onAdded={reload} />}
        {editable && <JoinLinks changes={changes} onChanged={changed} />}
        {me.mode === 'standalone' && <Passkeys name={me.person?.name ?? ''} />}
      </div>
    </>
  );
}

/** Who waits to join (ADR 0011): what Philobiblos knows of each, and approve (as an adult, or an admin) or decline. */
function WaitingList({ mode, changes, onDecided }: { mode: NonNullable<Me['mode']>; changes: number; onDecided: () => Promise<void> }) {
  const [people, setPeople] = useState<WaitingPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const load = useCallback(() => api<WaitingPerson[]>('/people/waiting').then(setPeople, (e) => setError(message(e))), []);
  useEffect(() => { void load(); }, [load, changes]);
  // Under HomersLab a decision needs the edge's recent sign-in signal, which it does not send yet (homeward#253).
  const blocked = mode === 'homerslab';
  const decide = async (p: WaitingPerson, what: 'approve' | 'decline', role: 'adult' | 'admin' = 'adult') => {
    if (what === 'decline' && !confirm(`Decline ${p.name}? Their request goes, with their passkey.`)) return;
    setError(null);
    try {
      await api(`/people/waiting/${p.id}/${what}`, { method: 'POST', ...(what === 'approve' ? { body: { role } } : {}) });
      setStatus(what === 'approve' ? `${p.name} is in the household now, as ${role === 'admin' ? 'an admin' : 'an adult'}.` : `${p.name} was declined.`);
      await onDecided();
    } catch (e) { setError(message(e)); }
  };
  if (!people?.length && !error) return <p className="sr-only" role="status">{status}</p>;
  return (
    <section className="group-block" aria-labelledby="waiting-h">
      <div className="group-head"><h2 id="waiting-h">Waiting to join</h2><span>{people?.length ?? 0}</span></div>
      {error && <Notice kind="error">{error}</Notice>}
      <ul className="group" role="list">
        {(people ?? []).map((p) => (
          <li key={p.id} className="row">
            <span className={`avatar ${AVATAR.adult}`} aria-hidden="true">{initials(p.name)}</span>
            <span className="row-main">
              <span className="row-title">{p.name}</span>
              <span className="row-sub wrap">
                {[p.via === 'homeward' ? 'Came from Homeward' : p.joinLink?.createdBy ? `Came with ${p.joinLink.createdBy}’s join link` : 'Came with a join link',
                  p.arrivedAt ? new Date(p.arrivedAt).toLocaleString(undefined, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : null,
                  p.fromHomeNetwork == null ? null : p.fromHomeNetwork ? 'from the home network' : 'from outside the home network',
                  p.verifiedAddress ? `verified ${p.verifiedAddress}` : null].filter(Boolean).join(' · ')}
              </span>
            </span>
            <span className="row-trail">
              <button type="button" className="btn btn-sm btn-primary" disabled={blocked} aria-label={`Approve ${p.name} as an adult`} onClick={() => void decide(p, 'approve')}>Approve</button>
              {p.mayBeAdmin && <button type="button" className="btn btn-sm" disabled={blocked} aria-label={`Approve ${p.name} as an admin`} onClick={() => void decide(p, 'approve', 'admin')}>As admin</button>}
              <button type="button" className="btn btn-sm btn-destructive" disabled={blocked} aria-label={`Decline ${p.name}`} onClick={() => void decide(p, 'decline')}>Decline</button>
            </span>
          </li>
        ))}
      </ul>
      <p className="group-foot">
        {blocked
          ? 'Approving and declining need a recent sign-in, which Homeward does not tell Philobiblos yet: until it does, they wait here.'
          : 'Anyone with a link can type a family member’s name: check who it is before you approve. Approving or declining needs a sign-in in the last 10 minutes.'}
      </p>
      <p className="sr-only" role="status">{status}</p>
    </section>
  );
}

function InviteLink({ name, url, expiresAt, onDone, self = false }: { name: string; url: string; expiresAt: string; onDone: () => void; self?: boolean }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  const until = new Date(expiresAt).toLocaleString(undefined, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <h2 className="card-title" id={`${id}-h`}>{self ? 'A link for your other device' : `A link for ${name}`}</h2>
      <div className="field">
        <label className="field-label" htmlFor={id}>
          {self ? `Open it on the other device; it works once, until ${until}.` : `Send it to ${name} yourself; it works once, until ${until}.`}
        </label>
        <input className="input mono" id={id} readOnly value={url} onFocus={(e) => e.target.select()} />
        <span className="hint">Philobiblos shows it only now. Anyone with the link can make a passkey as {self ? 'you' : name}.</span>
      </div>
      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={() => navigator.clipboard?.writeText(url).then(() => setCopied(true))}>
          {copied ? 'Copied' : 'Copy the link'}
        </button>
        <button type="button" className="btn" onClick={onDone}>Done</button>
      </div>
      <p className="sr-only" role="status">{copied ? 'The link is copied.' : ''}</p>
    </section>
  );
}

function AddPerson({ onAdded }: { onAdded: () => Promise<void> }) {
  const id = useId();
  const [name, setName] = useState('');
  const [role, setRole] = useState<PersonInput['role']>('adult');
  const [birthYear, setBirthYear] = useState('');
  const [error, setError] = useState<string | null>(null);
  const year = new Date().getFullYear();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const body: PersonInput = { name: name.trim(), role, ...(role === 'kid' && birthYear ? { birthYear: Number(birthYear) } : {}) };
    try {
      await api('/people', { method: 'POST', body });
      setName(''); setBirthYear(''); setRole('adult');
      await onAdded();
    } catch (err) { setError(message(err)); }
  };
  return (
    <section className="card" aria-labelledby={`${id}-h`}>
      <h2 className="card-title" id={`${id}-h`}>Add someone</h2>
      <form className="stack" onSubmit={submit} noValidate>
        <div className="fields fields-2">
          <div className="field">
            <label className="field-label" htmlFor={`${id}-name`}>Name</label>
            <input className="input" id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" required />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-role`}>Role</label>
            <select className="input select" id={`${id}-role`} value={role} onChange={(e) => setRole(e.target.value as PersonInput['role'])}>
              <option value="adult">Adult</option>
              <option value="kid">Kid</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          {role === 'kid' && (
            <div className="field">
              <label className="field-label" htmlFor={`${id}-year`}>Birth year</label>
              <input className="input" id={`${id}-year`} inputMode="numeric" value={birthYear} onChange={(e) => setBirthYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
                aria-describedby={`${id}-year-hint`} placeholder={String(year - 4)} />
              <span className="hint" id={`${id}-year-hint`}>Philobiblos picks books for the kid’s age band and moves them up as the kid grows.</span>
            </div>
          )}
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="btn-row"><button type="submit" className="btn btn-primary" disabled={!name.trim()}>Add {role === 'kid' ? 'the kid' : 'them'}</button></div>
      </form>
    </section>
  );
}

function Passkeys({ name }: { name: string }) {
  const [keys, setKeys] = useState<Passkey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const load = useCallback(() => api<Passkey[]>('/me/passkeys').then(setKeys, (e) => setError(message(e))), []);
  useEffect(() => { void load(); }, [load]);
  const addDevice = () => {
    setError(null);
    api<{ url: string; expiresAt: string }>('/me/passkeys/invite', { method: 'POST' }).then(setLink, (e) => setError(message(e)));
  };
  const everywhere = () => {
    if (!confirm('Sign out on every device, this one too?')) return;
    api('/me/sessions/end', { method: 'POST' }).then(() => location.assign('/'), (e) => setError(message(e)));
  };
  return (
    <section className="group-block" aria-labelledby="keys-h">
      <div className="group-head"><h2 id="keys-h">Your passkeys</h2></div>
      {error && <Notice kind="error">{error}</Notice>}
      <ul className="group" role="list">
        {(keys ?? []).map((k) => (
          <li className="row" key={k.id}>
            <span className="row-main">
              <span className="row-title">{k.label}</span>
              <span className="row-sub wrap">
                Made {new Date(k.createdAt).toLocaleDateString()}
                {k.invitedBy ? ` from ${k.invitedBy}’s invite` : ''}
                {k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : ''}
                {k.backedUp ? ' · synced' : ''}
              </span>
            </span>
            {keys && keys.length > 1 && (
              <span className="row-trail">
                <button type="button" className="btn btn-sm btn-destructive" aria-label={`Remove the passkey ${k.label}`}
                  onClick={() => api(`/me/passkeys/${k.id}`, { method: 'DELETE' }).then(load, (e) => setError(message(e)))}>Remove</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {link && <InviteLink self name={name} {...link} onDone={() => { setLink(null); void load(); }} />}
      <div className="btn-row">
        <button type="button" className="btn" onClick={addDevice}>Add a passkey on another device</button>
        <button type="button" className="btn" onClick={everywhere}>Sign out everywhere</button>
      </div>
      <p className="group-foot">
        Your last passkey stays. Removing a passkey signs out the browsers it signed in. Adding a passkey, or inviting
        someone, needs a sign-in in the last 10 minutes: if Philobiblos asks, sign out and in again.
      </p>
    </section>
  );
}
