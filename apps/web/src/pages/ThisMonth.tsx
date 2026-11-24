// This month (spec §4, the design's "This month"): the budget bar is the control (two handles on the bar itself, the
// fill is the order's total), the order's progress, where your brain grows (the Focus card, the brain in miniature),
// each adult's picks with their move, the kids' with their theme, and Compose: your own mail app opens with the order;
// then the shop's quote or an invoice, typed in or imported, for a shop whose mail Philobiblos does not read (RecordEntry).
// No-shop mode (philobiblos#27 slice 5): instead of Compose, the order as a plain list for any shop or none (its mail text
// to no one, a printed page, a CSV), and each book bought marked owned by a tap (undone by another).
// Nothing acts on a value change: the handles move a draft, a button applies it (WCAG 3.2.2).
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { components } from '@philobiblos/contracts/openapi';
import { ApiError, api, message, type Me } from '../api';
import { Notice, PageHead } from '../ui';
import { useMoney } from '../money';
import { RecordEntry } from './RecordEntry';

type Plan = components['schemas']['MonthPlan'];
type Pick = components['schemas']['Pick'];
type Order = components['schemas']['Order'];
type Budget = { min: number; max: number };

const MOVES: Record<string, string> = { deepen: 'Deepen', connect: 'Connect', broaden: 'Broaden', counterpoint: 'Counterpoint', wildcard: 'Wildcard', intro: 'Intro', fiction: 'Fiction' };
const STEPS = ['Picked', 'Composed', 'Quote', 'Invoice', 'In the library'];
const STEP_OF: Record<string, number> = { picked: 0, drafted: 1, quoted: 2, invoiced: 3, closed: 4 };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function ThisMonth({ me, go }: { me: Me; go: (to: string) => void }) {
  const fmt = useMoney().format;
  const [plan, setPlan] = useState<Plan | null>(null);
  // "This month" is the server's (its time zone), the same month the Backlog's "add to this month" uses.
  const month = plan?.month ?? '';
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [composed, setComposed] = useState<Order | null>(null);
  const admin = me.person?.role === 'admin';

  const load = useCallback(() => api<Plan>('/month').then(setPlan, (e) => setError(message(e))), []);
  useEffect(() => { void load(); }, [load]);
  const act = async (fn: () => Promise<Plan>, said: string) => {
    setError(null);
    try { setPlan(await fn()); setComposed(null); setStatus(said); } catch (e) { setError(message(e)); }
  };
  const change = (body: object, said: string) => act(() => api<Plan>(`/month/${month}/picks`, { method: 'POST', body }), said);
  const compose = async (list: boolean) => {
    setError(null);
    try {
      const o = await api<Order>('/orders', { method: 'POST', body: list ? { month, list: true } : { month } });
      setComposed(o); setStatus(list ? 'The list is ready to print, mail or download.' : 'The order is ready to open in your mail app.');
      await load();
    } catch (e) { setError(e instanceof ApiError && e.status === 409 ? `${message(e)}.` : message(e)); }
  };
  // A tap at a time: a second tap while the first runs is refused by the server anyway (409), never a second copy.
  const [tapping, setTapping] = useState(false);
  const own = async (bookId: string, title: string, owned: boolean) => {
    if (!plan?.order?.id || tapping) return;
    setError(null); setTapping(true);
    try {
      const order = await api<Order>(`/orders/${plan.order.id}/lines/${encodeURIComponent(bookId)}`, { method: 'PUT', body: { owned } });
      // The answer is the order as it is now: the plan around it does not change with a tap.
      setPlan((p) => (p ? { ...p, order } : p));
      setStatus(owned ? `${title} is in the library.` : `${title} is off the library again.`);
    } catch (e) { setError(message(e)); } finally { setTapping(false); }
  };

  const name = month ? `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}` : '';
  const kidCount = plan?.kids?.reduce((n, k) => n + (k.picks?.length ?? 0), 0) ?? 0;
  const adultCount = plan?.adults?.reduce((n, a) => n + (a.picks?.length ?? 0), 0) ?? 0;
  return (
    <>
      <PageHead title="This month" sub={`${name ? `${name}: ` : ''}non-fiction that grows each adult’s reading map, and kids’ books with a different theme and author each.`}
        actions={<button type="button" className="btn" onClick={() => void change({ recompute: true }, 'Picked again from the scoring.')}>Pick again</button>} />
      <div className="stack">
        {error && <Notice kind="error">{error}</Notice>}
        <p className="sr-only" role="status">{status}</p>
        {!plan ? <p className="sr-only" role="status">Loading</p> : (
          <>
            <div className="mo-top">
              <BudgetBar budget={plan.budget as Budget} total={plan.total ?? 0} override={Boolean(plan.budgetIsOverride)} admin={admin}
                count={`${adultCount} for adults, ${kidCount} for the kids`}
                onApply={(b) => act(() => api<Plan>(`/month/${month}/budget`, { method: 'PUT', body: b }), b ? `This month’s budget is ${fmt(b.min)} to ${fmt(b.max)}; the kids’ picks are made again.` : 'Back to the usual budget.')} />
              <Progress order={plan.order ?? null} />
            </div>
            <Focus focus={plan.focus ?? []} go={go} />
            {(plan.adults ?? []).map((a) => (
              <PickList key={a.person!.id} title={a.person!.id === me.person?.id ? 'For you · non-fiction' : `For ${a.person!.name} · non-fiction`}
                note={`Unread pile ${a.unreadPile ?? 0} of ${a.unreadLimit ?? 0}${(a.unreadPile ?? 0) > (a.unreadLimit ?? 0) ? ': fewer picks this month' : ''}`}
                picks={a.picks ?? []} canChange={a.person!.id === me.person?.id}
                onRemove={(p) => void change({ remove: [{ bookId: p.candidate!.book!.id, for: a.person!.id }] }, `${p.candidate!.book!.title} is off this month’s list.`)} />
            ))}
            {(plan.kids ?? []).map((k) => (
              <PickList key={k.person!.id} title={`For ${k.person!.name}`} note="One theme and one author each" picks={k.picks ?? []} canChange kid
                onRemove={(p) => void change({ remove: [{ bookId: p.candidate!.book!.id, for: k.person!.id }] }, `${p.candidate!.book!.title} is off this month’s list.`)} />
            ))}
            <ComposeCard total={plan.total ?? 0} order={composed} current={plan.order ?? null} empty={!adultCount && !kidCount} onCompose={(list) => void compose(list)} go={go} />
            {plan.order && plan.order.status !== 'picked' && (plan.order.lines?.length ?? 0) > 0 && <Bought order={plan.order} busy={tapping} onOwn={(b, t, o) => void own(b, t, o)} />}
            <RecordEntry month={month} monthName={name} orderStatus={plan.order?.status ?? null} onRecorded={() => void load()} />
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------- the budget

const STEP = 500; // 5 of the household's currency
const scaleOf = (b: Budget, total: number) => Math.max(40000, Math.ceil((Math.max(b.max, total) * 1.5) / 10000) * 10000);

function BudgetBar({ budget, total, override, admin, count, onApply }: { budget: Budget; total: number; override: boolean; admin: boolean; count: string; onApply: (b: Budget | null) => Promise<void> }) {
  const id = useId();
  const { format: fmt, unknownPrice } = useMoney();
  const [draft, setDraft] = useState(budget);
  useEffect(() => setDraft(budget), [budget.min, budget.max]);
  const [scale] = useState(() => scaleOf(budget, total));
  const track = useRef<HTMLDivElement>(null);
  const pct = (c: number) => `${Math.min(100, (c / scale) * 100)}%`;
  const over = total > budget.max;
  const changed = draft.min !== budget.min || draft.max !== budget.max;

  const set = (which: 'min' | 'max', v: number) => setDraft((d) => {
    const x = Math.round(Math.max(0, Math.min(scale, v)) / STEP) * STEP;
    return which === 'min' ? { ...d, min: Math.min(x, d.max) } : { ...d, max: Math.max(x, d.min) };
  });
  const key = (which: 'min' | 'max') => (e: React.KeyboardEvent) => {
    const v = draft[which];
    const to = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? v + STEP : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? v - STEP
      : e.key === 'PageUp' ? v + 10 * STEP : e.key === 'PageDown' ? v - 10 * STEP : e.key === 'Home' ? 0 : e.key === 'End' ? scale : null;
    if (to === null) return;
    e.preventDefault();
    set(which, to);
  };
  const drag = (which: 'min' | 'max') => (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.focus();
    const move = (ev: PointerEvent) => {
      const r = track.current!.getBoundingClientRect();
      set(which, ((ev.clientX - r.left) / r.width) * scale);
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const thumb = (which: 'min' | 'max', label: string) => (
    <div className={`mo-thumb mo-thumb-${which}`} role="slider" tabIndex={0} aria-label={label} aria-orientation="horizontal"
      aria-valuemin={which === 'min' ? 0 : draft.min / 100} aria-valuemax={which === 'min' ? draft.max / 100 : scale / 100}
      aria-valuenow={draft[which] / 100} aria-valuetext={fmt(draft[which])} aria-describedby={`${id}-help`}
      style={{ left: pct(draft[which]) }} onKeyDown={key(which)} onPointerDown={drag(which)} />
  );

  return (
    <section className="card stack mo-budget" aria-labelledby={`${id}-h`}>
      <div className="mo-budget-head">
        <div>
          <h2 className="card-title" id={`${id}-h`}>Order total</h2>
          <p className={`mo-total${over ? ' is-over' : ''}`}>{fmt(total)}</p>
          <p className="card-meta">{count}</p>
          <p className="card-meta">An estimate: a price we don't know counts as {unknownPrice == null ? 'the household’s unknown price' : fmt(unknownPrice)}. The bookshop's quote is the real one.</p>
        </div>
        <div className="mo-budget-range">
          <span className="card-meta">{override ? 'This month only' : 'Monthly budget'}</span>
          <b>{fmt(draft.min)} – {fmt(draft.max)}</b>
        </div>
      </div>
      <div className="mo-track" ref={track}>
        <div className="mo-band" style={{ left: pct(draft.min), width: `calc(${pct(draft.max)} - ${pct(draft.min)})` }} aria-hidden="true" />
        <div className={`mo-fill${over ? ' is-over' : ''}`} style={{ width: pct(total) }} aria-hidden="true" />
        {admin && thumb('min', 'Budget, lowest total')}
        {admin && thumb('max', 'Budget, highest total')}
      </div>
      <div className="mo-scale" aria-hidden="true"><span>{fmt(0)}</span><span>{fmt(scale)}</span></div>
      <p className="footnote" id={`${id}-help`}>
        {over ? `The order is ${fmt(total - budget.max)} over the budget. ` : ''}
        {admin ? `Move either end of the bar (arrow keys move ${fmt(STEP)}, Page Up and Page Down ${fmt(10 * STEP)}), then use it for this month. The kids’ picks are made again within it.` : 'An admin changes the budget.'}
      </p>
      {admin && (
        <div className="btn-row">
          <button type="button" className="btn btn-primary" disabled={!changed} onClick={() => void onApply(draft)}>Use for this month</button>
          {changed && <button type="button" className="btn" onClick={() => setDraft(budget)}>Undo</button>}
          {override && <button type="button" className="btn btn-plain" onClick={() => void onApply(null)}>Back to the usual budget</button>}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------- progress

function Progress({ order }: { order: Order | null }) {
  const at = order ? STEP_OF[order.status ?? 'picked'] ?? 0 : 0;
  return (
    <section className="card mo-progress" aria-labelledby="mo-steps-h">
      <h2 className="card-title" id="mo-steps-h">Order</h2>
      <ol className="mo-steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i < at ? 'is-done' : i === at ? 'is-now' : undefined} aria-current={i === at ? 'step' : undefined}>
            <span className="mo-step-dot" aria-hidden="true">{i < at ? '✓' : ''}</span>{s}{i < at && <span className="sr-only"> (done)</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------- focus

function Focus({ focus, go }: { focus: NonNullable<Plan['focus']>; go: (to: string) => void }) {
  if (!focus.length) return null;
  const ideas = [...new Set(focus.flatMap((f) => f.ideas ?? []))].slice(0, 5);
  const x = (i: number) => 40 + (i * 240) / Math.max(1, ideas.length - 1);
  return (
    <section className="card mo-focus" aria-labelledby="mo-focus-h">
      <div className="mo-focus-text">
        <h2 className="card-title" id="mo-focus-h">This month your brain grows here</h2>
        <ul className="mo-focus-list" role="list">
          {focus.map((f) => (
            <li key={f.bookId}><MovePill move={f.move} /> {f.sentence}</li>
          ))}
        </ul>
        <a href="/brain" className="btn btn-plain mo-focus-link" onClick={(e) => { e.preventDefault(); go('/brain'); }}>Open your brain</a>
      </div>
      {/* The brain in miniature, for the eye: the sentences above say the same. */}
      {ideas.length > 0 && <svg className="mo-mini" viewBox="0 0 320 120" aria-hidden="true" focusable="false">
        {ideas.slice(1).map((_, i) => <line key={i} x1={x(i)} y1={50} x2={x(i + 1)} y2={50} className="mo-mini-edge" />)}
        {ideas.map((name, i) => (
          <g key={name}>
            <circle cx={ideas.length === 1 ? 160 : x(i)} cy={50} r={16} className="mo-mini-node" />
            <text x={ideas.length === 1 ? 160 : x(i)} y={92} className="mo-mini-label">{name.length > 18 ? `${name.slice(0, 17)}…` : name}</text>
          </g>
        ))}
      </svg>}
    </section>
  );
}

function MovePill({ move }: { move?: string }) {
  if (!move) return null;
  return <span className={`mo-move move-${move}`}>{MOVES[move] ?? move}</span>;
}

// ---------------------------------------------------------------------------------------------------------- picks

function PickList({ title, note, picks, canChange, kid, onRemove }: { title: string; note: string; picks: Pick[]; canChange: boolean; kid?: boolean; onRemove: (p: Pick) => void }) {
  const id = useId();
  const fmt = useMoney().format;
  return (
    <section className="group-block" aria-labelledby={`${id}-h`}>
      <div className="group-head"><h2 id={`${id}-h`}>{title}</h2><span>{note}</span></div>
      {!picks.length ? <p className="group-foot">No picks this month.</p> : (
        <ul className="group" role="list">
          {picks.map((p) => {
            const b = p.candidate!.book!;
            return (
              <li key={b.id} className="row mo-pick">
                <span className="lib-cover" aria-hidden="true" style={{ '--h': (b.title.charCodeAt(0) * 37) % 360 } as React.CSSProperties}>{b.title.split(/\s+/).slice(0, 2).map((w) => w[0]).join('')}</span>
                <span className="row-main">
                  <span className="row-title wrap">{b.title}</span>
                  <span className="row-sub wrap">{(b.authors ?? []).join(', ')}{p.idea ? ` · ${p.idea}` : ''}</span>
                  <span className="row-sub wrap">{p.why}</span>
                </span>
                <span className="row-trail mo-trail">
                  {kid ? (p.idea && <span className="pill">{p.idea}</span>) : <MovePill move={p.move} />}
                  <span className="bl-price">{p.candidate!.price != null ? fmt(p.candidate!.price) : 'Price unknown'}</span>
                  {canChange && <button type="button" className="btn btn-sm" aria-label={`Remove ${b.title} from this month`} onClick={() => onRemove(p)}>Remove</button>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------- compose

function ComposeCard({ total, order, current, empty, onCompose, go }: { total: number; order: Order | null; current: Order | null; empty: boolean; onCompose: (list: boolean) => void; go: (to: string) => void }) {
  const id = useId();
  const fmt = useMoney().format;
  const [copied, setCopied] = useState('');
  const list = order?.listUrl !== undefined;
  const copy = async () => {
    try { await navigator.clipboard.writeText((list ? order!.listText : order!.composeText) ?? ''); setCopied('Copied.'); } catch { setCopied('Select the text and copy it.'); }
  };
  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <div>
        <h2 className="card-title" id={`${id}-h`}>Order the books</h2>
        <p className="footnote">Compose writes the order to the bookshop, about {fmt(total)}, and asks for prices and delivery times first. Your mail app sends it, not Philobiblos, and it never holds a card number. <a href="/settings" onClick={(e) => { e.preventDefault(); go('/settings'); }}>Where orders go</a></p>
        <p className="footnote">Or make a plain list for any shop, or none: print it, mail it to whoever you choose, or download it as a CSV. It holds the books only, not your address or anyone’s name.</p>
      </div>
      {!order ? (
        <div className="btn-row">
          <button type="button" className="btn btn-primary" disabled={empty} onClick={() => onCompose(false)}>Compose the order</button>
          <button type="button" className="btn" disabled={empty} onClick={() => onCompose(true)}>Make a plain list</button>
        </div>
      ) : list ? (
        <>
          <div className="btn-row">
            <a className="btn btn-primary" href={order.listUrl}>Open in your mail app</a>
            <button type="button" className="btn" onClick={() => void copy()}>Copy the list</button>
            <button type="button" className="btn" onClick={printList}>Print the list</button>
            <a className="btn" href={`/api/orders/${encodeURIComponent(order.id!)}/list.csv`} download>Download the CSV</a>
            <button type="button" className="btn btn-plain" onClick={() => onCompose(false)}>Compose to the bookshop instead</button>
            <span className="footnote" role="status">{copied}</span>
          </div>
          <p className="footnote">The mail goes to no one yet: choose the shop in your mail app. The CSV has the columns an invoice imports (below), so the same file with the prices paid records what you bought.</p>
          {order.listComplete === false && <Notice kind="info" title="A long list.">The link holds a greeting only: paste the copied text into the mail.</Notice>}
          <div className="field">
            <label className="field-label" htmlFor={`${id}-t`}>The list’s text</label>
            <textarea className="input textarea mo-text" id={`${id}-t`} readOnly value={`Subject: ${order.listSubject ?? ''}\n\n${order.listText ?? ''}`} />
          </div>
          <PrintedList subject={order.listSubject ?? ''} order={current ?? order} />
        </>
      ) : (
        <>
          <div className="btn-row">
            <a className="btn btn-primary" href={order.composeUrl} aria-describedby={`${id}-to`}>Open in your mail app</a>
            <button type="button" className="btn" onClick={() => void copy()}>Copy the order text</button>
            <button type="button" className="btn btn-plain" onClick={() => onCompose(true)}>Make a plain list instead</button>
            <span className="footnote" role="status">{copied}</span>
          </div>
          <p id={`${id}-to`}>To: <b>{order.composeTo}</b></p>
          {order.composeComplete === false && <Notice kind="info" title="A long order.">The link holds a greeting only: paste the copied text into the mail.</Notice>}
          <div className="field">
            <label className="field-label" htmlFor={`${id}-t`}>The order text</label>
            <textarea className="input textarea mo-text" id={`${id}-t`} readOnly value={`Subject: ${order.composeSubject ?? ''}\n\n${order.composeText ?? ''}`} />
          </div>
        </>
      )}
    </section>
  );
}

/** Print the list alone: the page is marked while it prints (app.css), so printing any other page prints that page. */
function printList() {
  const root = document.documentElement;
  root.classList.add('print-list');
  window.addEventListener('afterprint', () => root.classList.remove('print-list'), { once: true });
  window.print();
}

/**
 * The printed page: the books still to buy alone (title, authors, ISBN, estimate), as the order is now (after taps), a
 * child of <body> so that printing hides everything else without leaving its space (app.css .mo-print).
 */
function PrintedList({ subject, order }: { subject: string; order: Order }) {
  const fmt = useMoney().format;
  const lines = (order.lines ?? []).filter((l) => l.state === 'planned' || l.state === 'quoted');
  return createPortal(
    <section className="mo-print">
      <h2>{subject}</h2>
      <ol>
        {lines.map((l) => (
          <li key={l.book!.id}>
            <b>{l.book!.title}</b>{l.book!.authors?.length ? `, ${l.book!.authors.join(', ')}` : ''}
            {l.book!.isbn13 ? ` · ISBN ${l.book!.isbn13}` : ''}{l.estimate != null ? ` · about ${fmt(l.estimate)}` : ''}
          </li>
        ))}
      </ol>
    </section>,
    document.body,
  );
}

// ---------------------------------------------------------------------------------------------------------- bought

const LINE_STATE: Record<string, string> = { planned: 'To buy', quoted: 'Quoted', unavailable: 'Not available: next month', delivered: 'In the library', rolled_over: 'Next month' };

/** Each book of the composed order, marked owned by a tap once bought (no invoice to record), or the tap undone. */
function Bought({ order, busy, onOwn }: { order: Order; busy: boolean; onOwn: (bookId: string, title: string, owned: boolean) => void }) {
  const id = useId();
  const lines = order.lines ?? [];
  const inLibrary = lines.filter((l) => l.state === 'delivered').length;
  return (
    <section className="group-block" aria-labelledby={`${id}-h`}>
      <div className="group-head"><h2 id={`${id}-h`}>Bought</h2><span>{inLibrary} of {lines.length} in the library</span></div>
      <ul className="group" role="list">
        {lines.map((l) => {
          const b = l.book!;
          const open = l.state === 'planned' || l.state === 'quoted';
          return (
            <li key={b.id} className="row">
              <span className="row-main">
                <span className="row-title wrap">{b.title}</span>
                <span className="row-sub wrap">{(b.authors ?? []).join(', ')}{(b.authors?.length ? ' · ' : '') + (LINE_STATE[l.state ?? 'planned'] ?? '')}</span>
              </span>
              <span className="row-trail">
                {open && <button type="button" className="btn btn-sm" disabled={busy} aria-label={`Mark ${b.title} owned`} onClick={() => onOwn(b.id, b.title, true)}>Owned</button>}
                {l.ownedByTap && <button type="button" className="btn btn-sm btn-plain" disabled={busy} aria-label={`Undo: ${b.title} is not owned after all`} onClick={() => onOwn(b.id, b.title, false)}>Undo</button>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="group-foot">
        Bought a book? Mark it owned when it arrives and it goes to the library. If the shop’s invoice comes later, from its mail or typed in, it takes that copy and its price paid: never a second copy, and the book stays owned.
        {' '}<a href={`/api/orders/${encodeURIComponent(order.id!)}/list.csv`} download>Download the books still to buy (CSV)</a>
      </p>
    </section>
  );
}
