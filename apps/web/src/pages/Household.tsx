// The household (spec §2, the design's "Family"): who is in it, their role, kids' age bands. Admins add people,
// change roles, invite adults to make a passkey, and remove people. Under HomersLab it is read-only here.
import { useCallback, useEffect, useId, useState } from 'react';
import { api, message, type Me, type Passkey, type Person, type PersonInput } from '../api';
import { Notice, PageHead, initials } from '../ui';

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

  const act = async (f: () => Promise<unknown>) => {
    setError(null);
    try { await f(); await reload(); } catch (e) { setError(message(e)); }
  };

  return (
    <>
      <PageHead title="Household" sub={me.mode === 'homerslab'
        ? 'People come from HomersLab: add, remove or change them there.'
        : 'Everyone who uses Shelf, and the kids it picks books for. Kids never sign in; adults act for them.'} />
      <div className="stack">
        {error && <Notice kind="error">{error}</Notice>}
        <section className="group-block" aria-labelledby="people-h">
          <div className="group-head"><h2 id="people-h">People</h2><span>{me.household?.length ?? 0}</span></div>
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
        {me.mode === 'standalone' && <Passkeys name={me.person?.name ?? ''} />}
      </div>
    </>
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
        <span className="hint">Shelf shows it only now. Anyone with the link can make a passkey as {self ? 'you' : name}.</span>
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
              <span className="hint" id={`${id}-year-hint`}>Shelf picks books for the kid’s age band and moves them up as the kid grows.</span>
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
        someone, needs a sign-in in the last 10 minutes: if Shelf asks, sign out and in again.
      </p>
    </section>
  );
}
