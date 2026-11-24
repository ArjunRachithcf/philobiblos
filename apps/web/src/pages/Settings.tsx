// Settings (spec §4): the household's monthly budget (one shared budget for the month's order; admins set it, everyone
// sees it; no rollover), its currency and unknown price (philobiblos#27: none is built in) and where orders go (the bookshop's address and the delivery address, sealed on the server; the
// delivery address is never shown back), the bookshops (Bookshops.tsx), the mailbox (Mailbox.tsx: its XOAUTH2 connection), when the monthly refresh runs, notifications (Notifications.tsx), the AI (AiSettings.tsx) and phone share tokens (ShareTokens.tsx). The rest
// arrives with its parts.
import { useEffect, useId, useMemo, useState } from 'react';
import { api, message, type Me, type Settings as S } from '../api';
import { Notice, PageHead } from '../ui';
import { ShareTokens } from './ShareTokens';
import { AiSettings } from './AiSettings';
import { Bookshops } from './Bookshops';
import { Mailbox } from './Mailbox';
import { Notifications } from './Notifications';
import { asTyped, budgetPatch, moneyPatch, unit, useMoney, wholeUnits } from '../money';

/** The most digits a whole amount may have (packages/contracts money.ts AMOUNT_CEILING_C: 10,000,000,000). */
const WHOLE_DIGITS = 11;

export function Settings({ me, reload }: { me: Me; reload: () => Promise<void> }) {
  const id = useId();
  const admin = me.person?.role === 'admin';
  const { currency, format } = useMoney();
  const [budget, setBudget] = useState<{ min: number; max: number } | null>(null);
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState('');
  // Every currency the server knows, with the decimals it counts (philobiblos#62): Settings' one source for them.
  // Null until GET /settings answers; empty if it could not (the choice is then a field for the code).
  const [known, setKnown] = useState<{ code: string; digits: number }[] | null>(null);

  useEffect(() => {
    api<S>('/settings').then((s) => {
      const b = { min: s.budget?.min ?? 0, max: s.budget?.max ?? 0 };
      setBudget(b); setMin(wholeUnits(b.min)); setMax(wholeUnits(b.max));
      setKnown(s.money?.currencies ?? []);
    }, (e) => { setError(message(e)); setKnown([]); });
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setOk('');
    if (!budget) return;
    // Only an end that was changed is sent: one kept from before is never rounded (philobiblos#62).
    const p = budgetPatch(min, max, budget);
    if ('error' in p) return setError(p.error);
    try {
      if (Object.keys(p.body).length) await api('/settings', { method: 'PATCH', body: { budget: p.body } });
      setBudget({ ...budget, ...p.body }); setOk('The budget is saved. It applies from the next month’s order.');
    } catch (err) { setError(message(err)); }
  };

  return (
    <>
      <PageHead title="Settings" sub="The household’s monthly budget and currency, where orders go, the AI, and phone share. The rest of the settings come with their screens." />
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
                  <label className="field-label" htmlFor={`${id}-min`}>At least ({unit(currency)})</label>
                  <input className="input" id={`${id}-min`} inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value.replace(/\D/g, '').slice(0, WHOLE_DIGITS))} />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor={`${id}-max`}>At most ({unit(currency)})</label>
                  <input className="input" id={`${id}-max`} inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, '').slice(0, WHOLE_DIGITS))} />
                </div>
              </div>
              {error && <Notice kind="error">{error}</Notice>}
              {ok && <Notice kind="ok">{ok}</Notice>}
              <div className="btn-row"><button type="submit" className="btn btn-primary">Save the budget</button></div>
            </form>
          ) : (
            <>
              <p className="bl-budget">{format(budget.min)} to {format(budget.max)} a month</p>
              <p className="footnote">An admin of the household changes it.</p>
              {error && <Notice kind="error">{error}</Notice>}
            </>
          )}
        </section>
        {known && <HouseholdMoney admin={admin} reload={reload} known={known} />}
        <Bookshops admin={admin} />
        <Mailbox admin={admin} />
        <OrderPlaces admin={admin} />
        <MonthlyRefresh admin={admin} />
        <Notifications admin={admin} />
        <AiSettings admin={admin} />
        <ShareTokens />
      </div>
    </>
  );
}

/**
 * Every code the server knows (GET /settings), with its name in the reader's language where this browser has one (for
 * the choice), and always the household's own. Before the list arrives there is a field for the code instead (the
 * server checks it either way).
 */
function currencies(known: { code: string }[], own: string | null | undefined): { code: string; name: string }[] {
  if (!known.length) return [];
  let names: Intl.DisplayNames | null = null;
  try { names = new Intl.DisplayNames(undefined, { type: 'currency' }); } catch { /* codes alone */ }
  const codes = known.map((c) => c.code);
  return [...(own && !codes.includes(own) ? [own] : []), ...codes].map((code) => ({ code, name: names?.of(code) ?? code }));
}

/**
 * The household's currency and what a price nobody knows counts as (philobiblos#27). Every amount is in the currency;
 * a bookshop counts only in it, so it is chosen before one is enabled. Changing it converts nothing.
 */
function HouseholdMoney({ admin, reload, known }: { admin: boolean; reload: () => Promise<void>; known: { code: string; digits: number }[] }) {
  const id = useId();
  const { currency, digits, unknownPrice, priceLimits, format } = useMoney();
  const shown = (c: number | null | undefined) => (c == null ? '' : asTyped(c, digits));
  const [code, setCode] = useState(currency ?? '');
  const [unknown, setUnknown] = useState(shown(unknownPrice));
  // The scores' price limits (philobiblos#40): the household's own, or following the unknown price.
  const [own, setOwn] = useState(priceLimits?.own ?? false);
  const [high, setHigh] = useState(shown(priceLimits?.high));
  const [max, setMax] = useState(shown(priceLimits?.max));
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState('');
  const list = useMemo(() => (admin ? currencies(known, currency) : []), [admin, known, currency]);
  useEffect(() => { setCode(currency ?? ''); }, [currency]);
  useEffect(() => { if (unknownPrice != null) setUnknown(asTyped(unknownPrice, digits)); }, [unknownPrice, digits]);
  useEffect(() => {
    if (!priceLimits) return;
    setOwn(priceLimits.own ?? false);
    setHigh(shown(priceLimits.high));
    setMax(shown(priceLimits.max));
  }, [priceLimits?.own, priceLimits?.high, priceLimits?.max, digits]);
  // The decimals of a currency as the server counts them: the household's from /me, any other from Settings' list.
  const digitsOf = (c: string | null | undefined) => (c === currency ? digits : known.find((k) => k.code === c)?.digits ?? 2);
  const three = digitsOf(code || currency) > 2;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setOk('');
    // Only what was changed is sent, typed in the currency being saved with its own decimals (money.ts moneyPatch).
    const p = moneyPatch({ code, unknown, own, high, max }, { currency, unknownPrice, priceLimits }, digitsOf);
    if ('error' in p) return setError(p.error);
    try {
      if (Object.keys(p.body).length) {
        await api('/settings', { method: 'PATCH', body: { money: p.body } });
        await reload();
      }
      setOk('Saved.');
    } catch (err) { setError(message(err)); }
  };

  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <div>
        <h2 className="card-title" id={`${id}-h`}>Currency</h2>
        <p className="footnote">Every amount in Philobiblos is in the household’s currency. A bookshop counts only in it, so choose it before you enable one.</p>
      </div>
      {currency
        ? <p>Amounts are in <b>{currency}</b>. A price nobody knows counts as <b>{unknownPrice == null ? '' : format(unknownPrice)}</b> in the month’s plan.{priceLimits?.high != null && priceLimits.max != null && <> A book above <b>{format(priceLimits.high)}</b> counts as dear in the scores; an adult’s above <b>{format(priceLimits.max)}</b> is left out.</>}</p>
        : <Notice kind="warn" title="The household has no currency yet.">{admin ? 'Choose it here.' : 'An admin of the household chooses it.'} Until then no bookshop can be enabled.</Notice>}
      {admin ? (
        <form className="stack" onSubmit={save} noValidate>
          <div className="fields fields-2">
            <div className="field">
              <label className="field-label" htmlFor={`${id}-c`}>The household’s currency</label>
              {list.length ? (
                <select className="input" id={`${id}-c`} value={code} onChange={(e) => setCode(e.target.value)} aria-describedby={`${id}-ch`}>
                  {!currency && <option value="">Choose…</option>}
                  {list.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
                </select>
              ) : (
                <input className="input" id={`${id}-c`} autoComplete="off" spellCheck={false} maxLength={3} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} aria-describedby={`${id}-ch`} />
              )}
              <span className="hint" id={`${id}-ch`}>While a bookshop is enabled, the currency cannot change: turn it off first, then enable it again in the new currency. Changing it converts nothing: the budget and prices keep their numbers.</span>
            </div>
            <div className="field">
              <label className="field-label" htmlFor={`${id}-u`}>An unknown price counts as ({unit(code || currency)})</label>
              <input className="input" id={`${id}-u`} inputMode="decimal" value={unknown} onChange={(e) => setUnknown(e.target.value.slice(0, 15))} />
            </div>
          </div>
          <fieldset className="stack set-limits">
            <legend className="field-label">Price limits in the scores</legend>
            <label className="row"><input type="checkbox" checked={!own} onChange={(e) => setOwn(!e.target.checked)} aria-describedby={`${id}-lh`} /> Follow the unknown price</label>
            <span className="hint" id={`${id}-lh`}>Above 1.6 times the unknown price a book counts as dear; above 2.4 times it, an adult’s book is left out of the picks. Set your own amounts instead, in the household’s currency.</span>
            {own && (
              <div className="fields fields-2">
                <div className="field">
                  <label className="field-label" htmlFor={`${id}-lh1`}>Dear above ({unit(code || currency)})</label>
                  <input className="input" id={`${id}-lh1`} inputMode="decimal" value={high} onChange={(e) => setHigh(e.target.value.slice(0, 15))} />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor={`${id}-lh2`}>Left out above ({unit(code || currency)})</label>
                  <input className="input" id={`${id}-lh2`} inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value.slice(0, 15))} />
                </div>
              </div>
            )}
          </fieldset>
          {three && <p className="footnote">{code || currency} is written with three decimals; Philobiblos keeps amounts to hundredths, so an amount’s third decimal is 0 (1.250). One with a thousandth (1.255) is refused here, in a CSV, and in a bookshop’s mail or markup: it is never rounded.</p>}
          {error && <Notice kind="error">{error}</Notice>}
          {ok && <Notice kind="ok">{ok}</Notice>}
          <div className="btn-row"><button type="submit" className="btn btn-primary">Save the currency</button></div>
        </form>
      ) : <p className="footnote">An admin of the household changes it.</p>}
    </section>
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
        <p className="footnote">Compose on This month opens your mail app with the order to this address. Philobiblos never sends mail and never asks for a card number.</p>
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
          {order.needsReentry && <Notice kind="warn" title="Enter both addresses again.">They were sealed with a key that has since changed, so Philobiblos cannot read them. Compose waits until they are saved again.</Notice>}
          {order.canSeal === false && <Notice kind="warn" title={`The sealing key is ${order.keyProblem ?? 'missing'}.`}>The server’s configuration needs fixing (PHILOBIBLOS_SEALING_KEY). The saved addresses are kept; nothing needs entering again.</Notice>}
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
        <p className="footnote">Once a month Philobiblos reads the bookshop’s mail, refreshes prices, keeps the month’s picks and tells the adults. A month the server was off for is not made up.</p>
      </div>
      {!cycle ? (error ? <Notice kind="error">{error}</Notice> : <p className="sr-only" role="status">Loading</p>) : (
        <>
          {cycle.problem && <Notice kind="error">{cycle.problem}</Notice>}
          <p>Next: <b>{when(cycle.next)}</b>{cycle.last ? `. ${cycle.last.period} ${STATUS[cycle.last.status ?? ''] ?? ''}.` : '.'}</p>
          {cycle.futureRun && <Notice kind="warn">A run was recorded for a future month ({cycle.futureRun}; clock moved?). It does not stop this month’s run; that month runs again when it comes.</Notice>}
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
