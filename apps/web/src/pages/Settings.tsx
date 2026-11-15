// Settings (spec §4): the household's monthly budget (one shared budget for the month's order; admins set it, everyone
// sees it; no rollover) and where orders go (the bookshop's address and the delivery address, sealed on the server; the
// delivery address is never shown back). The rest of the screen arrives with its parts (M3).
import { useEffect, useId, useState } from 'react';
import { api, message, type Me, type Settings as S } from '../api';
import { Notice, PageHead } from '../ui';

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
      <PageHead title="Settings" sub="The household’s monthly budget and where orders go. The rest of the settings come with their screens." />
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
      {!order ? <p className="sr-only" role="status">Loading</p> : admin ? (
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
          {order.canSeal === false && <Notice kind="warn">The sealing key is missing, so the addresses cannot be saved.</Notice>}
          {error && <Notice kind="error">{error}</Notice>}
          {ok && <Notice kind="ok">{ok}</Notice>}
          <div className="btn-row"><button type="submit" className="btn btn-primary">Save where orders go</button></div>
        </form>
      ) : (
        <>
          <p>{order.bookshopEmail ? <>Orders go to <b>{order.bookshopEmail}</b>.</> : 'No bookshop address yet.'} {order.hasDelivery ? 'A delivery address is saved.' : ''}</p>
          <p className="footnote">An admin of the household changes it.</p>
        </>
      )}
    </section>
  );
}
