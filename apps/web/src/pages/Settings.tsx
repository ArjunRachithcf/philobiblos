// Settings (spec §4), M1: the household's monthly budget. One shared budget for the month's order; admins set it,
// everyone sees it; there is no rollover. The rest of the screen arrives with its parts (M2, M3).
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
      <PageHead title="Settings" sub="The household’s monthly budget. The rest of the settings come with their screens." />
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
      </div>
    </>
  );
}
