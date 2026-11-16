// Settings (spec §4): the household's monthly budget (one shared budget for the month's order; admins set it, everyone
// sees it; no rollover) and where orders go (the bookshop's address and the delivery address, sealed on the server; the
// delivery address is never shown back), when the monthly refresh runs, the AI (AiSettings.tsx) and phone share tokens (ShareTokens.tsx). The rest
// arrives with its parts.
import { useEffect, useId, useState } from 'react';
import { api, message, type Me, type Settings as S } from '../api';
import { Notice, PageHead } from '../ui';
import { ShareTokens } from './ShareTokens';
import { AiSettings } from './AiSettings';

const toChf = (c: number) => (c / 100).toFixed(0);

export function Settings({ me }: { me: Me }) {
  const id = useId();
  const admin = me.person?.role === 'admin';
  const [budget, setBudget] = useState<{ min: number; max: number } | null>(null);
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState('');

  useEffect(() => {
    api<S>('/settings').then((s) => {
      const b = { min: s.budget?.min ?? 0, max: s.budget?.max ?? 0 };
      setBudget(b); setMin(toChf(b.min)); setMax(toChf(b.max));
    }, (e) => setError(message(e)));
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setOk('');
    const next = { min: Math.round(Number(min) * 100), max: Math.round(Number(max) * 100) };
    if (!/^\d{1,5}$/.test(min) || !/^\d{1,5}$/.test(max)) return setError('Enter whole francs, for example 100.');
    if (next.min > next.max) return setError('The lower end is above the upper end.');
    try {
      await api('/settings', { method: 'PATCH', body: { budget: next } });
      setBudget(next); setOk('The budget is saved. It applies from the next month’s order.');
    } catch (err) { setError(message(err)); }
  };

  return (
    <>
      <PageHead title="Settings" sub="The household’s monthly budget, where orders go, the AI, and phone share. The rest of the settings come with their screens." />
      <div className="stack">
        <section className="card stack" aria-labelledby={`${id}-h`}>
          <div>
            <h2 className="card-title" id={`${id}-h`}>Monthly budget</h2>
            <p className="footnote">One budget for the whole household’s monthly order. What a month leaves unspent is not carried over.</p>
          </div>
          {!budget ? <p className="sr-only" role="status">Loading</p> : admin ? (
            <form className="stack" onSubmit={save} noValidate>
              <div className="fields fields-2">
                <div className="field">
                  <label className="field-label" htmlFor={`${id}-min`}>At least (CHF)</label>
                  <input className="input" id={`${id}-min`} inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value.replace(/\D/g, '').slice(0, 5))} />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor={`${id}-max`}>At most (CHF)</label>
                  <input className="input" id={`${id}-max`} inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, '').slice(0, 5))} />
                </div>
              </div>
              {error && <Notice kind="error">{error}</Notice>}
              {ok && <Notice kind="ok">{ok}</Notice>}
              <div className="btn-row"><button type="submit" className="btn btn-primary">Save the budget</button></div>
            </form>
          ) : (
            <>
              <p className="bl-budget">CHF {toChf(budget.min)} to {toChf(budget.max)} a month</p>
              <p className="footnote">An admin of the household changes it.</p>
              {error && <Notice kind="error">{error}</Notice>}
            </>
          )}
        </section>
        <OrderPlaces admin={admin} />
        <MonthlyRefresh admin={admin} />
        <AiSettings admin={admin} />
        <ShareTokens />
      </div>
    </>
  );
}

function OrderPlaces({ admin }: { admin: boolean }) {
  const id = useId();
  const [order, setOrder] = useState<NonNullable<S['order']> | null>(null);
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState('');
  const load = () => api<S>('/settings').then((s) => { setOrder(s.order ?? {}); setEmail(s.order?.bookshopEmail ?? ''); }, (e) => setError(message(e)));
  useEffect(() => { void load(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setOk('');
    const body: { bookshopEmail: string | null; deliveryAddress?: string } = { bookshopEmail: email.trim() || null };
    if (address.trim()) body.deliveryAddress = address.trim();
    try {
      await api('/settings', { method: 'PATCH', body: { order: body } });
      setAddress('');
      setOk('Saved. The delivery address is kept sealed and is not shown again.');
      await load();
    } catch (err) { setError(message(err)); }
  };

  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <div>
        <h2 className="card-title" id={`${id}-h`}>Where orders go</h2>
        <p className="footnote">Compose on This month opens your mail app with the order to this address. Shelf never sends mail and never asks for a card number.</p>
      </div>
      {!order ? (error ? <Notice kind="error">{error}</Notice> : <p className="sr-only" role="status">Loading</p>) : admin ? (
        <form className="stack" onSubmit={save} noValidate>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-e`}>The bookshop’s e-mail address</label>
            <input className="input" id={`${id}-e`} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-a`}>Delivery address{order.hasDelivery ? ' (saved; type a new one to replace it)' : ''}</label>
            <textarea className="input textarea" id={`${id}-a`} maxLength={300} autoComplete="off" value={address} onChange={(e) => setAddress(e.target.value)} aria-describedby={`${id}-ah`} />
            <span className="hint" id={`${id}-ah`}>It goes into the order text only. It is sealed on the server and never shown here again.</span>
          </div>
          {order.needsReentry && <Notice kind="warn" title="Enter both addresses again.">They were sealed with a key that has since changed, so Shelf cannot read them. Compose waits until they are saved again.</Notice>}
          {order.canSeal === false && <Notice kind="warn" title={`The sealing key is ${order.keyProblem ?? 'missing'}.`}>The server’s configuration needs fixing (SHELF_SEALING_KEY). The saved addresses are kept; nothing needs entering again.</Notice>}
          {error && <Notice kind="error">{error}</Notice>}
          {ok && <Notice kind="ok">{ok}</Notice>}
          <div className="btn-row"><button type="submit" className="btn btn-primary">Save where orders go</button></div>
        </form>
      ) : (
        <>
          {order.needsReentry && <Notice kind="warn">The addresses need entering again by an admin.</Notice>}
          <p>{order.bookshopEmail ? <>Orders go to <b>{order.bookshopEmail}</b>.</> : 'No bookshop address yet.'} {order.hasDelivery ? 'A delivery address is saved.' : ''}</p>
          <p className="footnote">An admin of the household changes it.</p>
        </>
      )}
    </section>
  );
}

const STATUS: Record<string, string> = { running: 'is running', retry: 'failed and will be tried again', done: 'ran', gave_up: 'failed every try; an admin can run it from the server' };

/** When the monthly refresh runs (spec §5 step 1): the household's day, time and zone; admins change them. */
function MonthlyRefresh({ admin }: { admin: boolean }) {
  const id = useId();
  const [cycle, setCycle] = useState<NonNullable<S['cycle']> | null>(null);
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [zone, setZone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState('');
  const load = () => api<S>('/settings').then((s) => {
    const c = s.cycle ?? {};
    setCycle(c); setDay(String(c.day ?? 1)); setTime(c.time ?? ''); setZone(c.timezone ?? '');
  }, (e) => setError(message(e)));
  useEffect(() => { void load(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setOk('');
    if (!/^\d{1,2}$/.test(day) || Number(day) < 1 || Number(day) > 28) return setError('Choose a day from 1 to 28: every month has it.');
    try {
      await api('/settings', { method: 'PATCH', body: { cycle: { day: Number(day), time, timezone: zone.trim() } } });
      setOk('Saved.');
      await load();
    } catch (err) { setError(message(err)); }
  };
  const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: cycle?.timezone }) : '');

  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <div>
        <h2 className="card-title" id={`${id}-h`}>Monthly refresh</h2>
        <p className="footnote">Once a month Shelf reads the bookshop’s mail, refreshes prices, and keeps the month’s picks. A month the server was off for is not made up.</p>
      </div>
      {!cycle ? (error ? <Notice kind="error">{error}</Notice> : <p className="sr-only" role="status">Loading</p>) : (
        <>
          <p>Next: <b>{when(cycle.next)}</b>{cycle.last ? `. ${cycle.last.period} ${STATUS[cycle.last.status ?? ''] ?? ''}.` : '.'}</p>
          {admin ? (
            <form className="stack" onSubmit={save} noValidate>
              <div className="fields fields-2">
                <div className="field">
                  <label className="field-label" htmlFor={`${id}-d`}>Day of the month</label>
                  <input className="input" id={`${id}-d`} inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value.replace(/\D/g, '').slice(0, 2))} />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor={`${id}-t`}>Time</label>
                  <input className="input" id={`${id}-t`} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label className="field-label" htmlFor={`${id}-z`}>Time zone</label>
                <input className="input" id={`${id}-z`} autoComplete="off" spellCheck={false} value={zone} onChange={(e) => setZone(e.target.value.slice(0, 64))} aria-describedby={`${id}-zh`} />
                <span className="hint" id={`${id}-zh`}>For example Europe/Zurich.</span>
              </div>
              {error && <Notice kind="error">{error}</Notice>}
              {ok && <Notice kind="ok">{ok}</Notice>}
              <div className="btn-row"><button type="submit" className="btn btn-primary">Save the refresh time</button></div>
            </form>
          ) : <p className="footnote">On day {cycle.day} at {cycle.time} ({cycle.timezone}). An admin of the household changes it.</p>}
        </>
      )}
    </section>
  );
}
