// The Brain (spec §4, the design's "Brain"): an adult's ideas as a map. A point grows with every book finished on it;
// its four rings are the layers (intro, core, deep, counterpoint), faint and dashed where nothing is read yet; lines
// are read books spanning two ideas (thickness = count), dashed for a wished-for book that would connect them; a new
// idea (nothing read yet) is dashed purple; this month's focus glows. The map is for the eye only: the table under it
// holds the same information and is how a keyboard or screen reader uses this screen.
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { api, message, type Brain as BrainData, type Layer, type Me } from '../api';
import { Choice, Notice, PageHead } from '../ui';

type Idea = BrainData['ideas'][number];
type Edge = BrainData['edges'][number];
type View = 'all' | 'focus' | 'gaps';

export const LAYERS: [Layer, string][] = [['intro', 'Intro'], ['core', 'Core'], ['deep', 'Deep'], ['counterpoint', 'Counterpoint']];
const VIEWS: [View, string][] = [['all', 'All ideas'], ['focus', 'This month’s focus'], ['gaps', 'Gaps']];
const MOVE: Record<string, string> = { deepen: 'Deepen', connect: 'Connect', broaden: 'Broaden', wildcard: 'Wildcard' };

const layerOf = (i: Idea, l: Layer) => i.layers[l] ?? { books: [], next: null };
const emptyLayers = (i: Idea) => LAYERS.filter(([l]) => !layerOf(i, l).books?.length);
/** A gap: a new idea, or an empty layer something on the backlog would fill. */
const hasGap = (i: Idea) => i.isNew || emptyLayers(i).some(([l]) => layerOf(i, l).next);
const inView = (i: Idea, v: View) => v === 'all' || (v === 'focus' ? Boolean(i.focus) : hasGap(i));
const tagOf = (i: Idea) => i.isNew ? 'New idea' : i.focus ? `Focus · ${MOVE[i.focus] ?? i.focus}` : i.readCount >= 3 ? 'Dense' : 'Growing';

export function Brain({ me, go }: { me: Me; go: (to: string) => void }) {
  const adults = (me.household ?? []).filter((p) => p.role !== 'kid');
  const [who, setWho] = useState(me.person?.id ?? '');
  const [brain, setBrain] = useState<BrainData | null>(null);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('all');
  const [sel, setSel] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    return api<BrainData>(`/people/${encodeURIComponent(who)}/brain`).then((b) => { setBrain(b); setSel((s) => (b.ideas.some((i) => i.id === s) ? s : b.ideas[0]?.id ?? null)); }, (e) => setError(message(e)));
  }, [who]);
  useEffect(() => { setBrain(null); void load(); }, [load]);
  useEffect(() => { api<{ links: unknown[]; ideas: unknown[]; newIdeas?: unknown[] }>('/proposals').then((p) => setWaiting(p.links.length + p.ideas.length + (p.newIdeas?.length ?? 0)), () => undefined); }, []);

  const own = who === me.person?.id;
  const name = adults.find((p) => p.id === who)?.name ?? '';
  const ideas = brain?.ideas ?? [];
  const shown = ideas.filter((i) => inView(i, view));
  const selected = ideas.find((i) => i.id === sel) ?? null;

  return (
    <>
      <PageHead title="Brain" sub="Ideas you have read about. A point grows with every book you finish on it, and its four rings fill in as you read the intro, the core text, deeper work and a counterpoint."
        actions={<a className="btn" href="/proposals" onClick={(e) => { e.preventDefault(); go('/proposals'); }}>Waiting for a decision{waiting ? ` (${waiting})` : ''}</a>} />
      <div className="stack">
        <div className="brain-tools">
          {adults.length > 1 && <Choice label="Whose brain" value={who} onChange={setWho} className="lib-people"
            options={adults.map((p) => [p.id, p.id === me.person?.id ? `${p.name} (you)` : p.name])} />}
          <Choice label="Show" value={view} onChange={(v) => setView(v as View)} options={VIEWS} />
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        {!brain ? <p className="sr-only" role="status">Loading</p> : !ideas.length ? (
          <Notice kind="info" title="No ideas yet.">{own ? 'Mark a book read in your library and its ideas appear here.' : `${name} has not finished a book with ideas yet.`}</Notice>
        ) : (
          <>
            <div className="brain-top">
              <BrainMap brain={brain} view={view} sel={sel} onPick={setSel} />
              {selected && <Panel idea={selected} />}
            </div>
            <IdeaTable ideas={shown} view={view} sel={sel} onPick={setSel} own={own} name={name} />
            <Connections edges={brain.edges} ideas={ideas} />
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------- the map

const radius = (i: Idea) => 22 + Math.min(i.readCount, 12) * 6;
const RING = 230;

/** A fixed layout: the most-read idea in the middle, the next six around it (from the right), then twelve, eighteen... */
function place(ideas: Idea[]) {
  const pos = new Map<string, { x: number; y: number }>();
  let k = 0;
  for (let ring = 0; k < ideas.length; ring++) {
    const n = ring === 0 ? 1 : Math.min(6 * ring, ideas.length - k);
    for (let j = 0; j < n; j++, k++) {
      const a = (2 * Math.PI * j) / n + (ring % 2 ? 0 : Math.PI / n);
      pos.set(ideas[k]!.id, { x: ring * RING * Math.cos(a), y: ring * RING * Math.sin(a) * 0.8 });
    }
  }
  return pos;
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number) {
  const p = (a: number) => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  return `M${p(a0)} A${r} ${r} 0 0 1 ${p(a1)}`;
}

function BrainMap({ brain, view, sel, onPick }: { brain: BrainData; view: View; sel: string | null; onPick: (id: string) => void }) {
  const pos = useMemo(() => place(brain.ideas), [brain.ideas]);
  const box = useMemo(() => {
    const pad = 110;
    const xs = brain.ideas.map((i) => pos.get(i.id)!.x), ys = brain.ideas.map((i) => pos.get(i.id)!.y);
    const [x0, x1, y0, y1] = [Math.min(...xs) - pad, Math.max(...xs) + pad, Math.min(...ys) - pad, Math.max(...ys) + pad + 30];
    // never zoomed in: a small brain stays small, in the middle
    const [w, h] = [Math.max(x1 - x0, 900), Math.max(y1 - y0, 420)];
    return `${(x0 + x1 - w) / 2} ${(y0 + y1 - h) / 2} ${w} ${h}`;
  }, [brain.ideas, pos]);
  const byId = new Map(brain.ideas.map((i) => [i.id, i]));
  return (
    // The same as the table below, for the eye; pointing at an idea shows it in the panel.
    <svg className="brain-map card" viewBox={box} aria-hidden="true" focusable="false" data-view={view}>
      {brain.edges.map((e) => <EdgeLine key={`${e.kind}:${e.a}:${e.b}`} e={e} pos={pos} byId={byId} view={view} />)}
      {brain.ideas.map((i) => {
        const { x, y } = pos.get(i.id)!;
        const r = radius(i);
        const dim = !inView(i, view);
        return (
          <g key={i.id} className={`brain-node${i.isNew ? ' is-new' : ''}${i.id === sel ? ' is-sel' : ''}${i.focus ? ' is-focus' : ''}${dim ? ' is-dim' : ''}`}
            data-idea={i.id} onClick={() => onPick(i.id)}>
            {i.focus && <circle className="brain-halo" cx={x} cy={y} r={r + 30} />}
            {LAYERS.map(([l], q) => {
              const a0 = -Math.PI + (q * Math.PI) / 2 + 0.12;
              return <path key={l} className={`brain-ring ring-${l}${layerOf(i, l).books?.length ? '' : ' is-empty'}`} d={arc(x, y, r + 10, a0, a0 + Math.PI / 2 - 0.24)} />;
            })}
            <circle className="brain-dot" cx={x} cy={y} r={r} />
            <text className="brain-count" x={x} y={y} dy="0.35em">{i.isNew ? '+' : i.readCount}</text>
            <text className="brain-label" x={x} y={y + r + 34}>{i.name}</text>
          </g>
        );
      })}
    </svg>
  );
}

function EdgeLine({ e, pos, byId, view }: { e: Edge; pos: Map<string, { x: number; y: number }>; byId: Map<string, Idea>; view: View }) {
  const [a, b] = [pos.get(e.a ?? ''), pos.get(e.b ?? '')];
  if (!a || !b) return null;
  const focus = Boolean(byId.get(e.a!)?.focus && byId.get(e.b!)?.focus);
  if (view === 'gaps' && e.kind === 'read') return null;
  if (view === 'focus' && !focus) return null;
  const cls = e.kind === 'future' ? 'is-future' : focus ? 'is-focus' : 'is-read';
  return <line className={`brain-edge ${cls}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} style={{ strokeWidth: e.kind === 'read' ? 2 + (e.weight ?? 1) * 3 : 2 }} />;
}

// ---------------------------------------------------------------------------------------------------------- the panel

function Panel({ idea }: { idea: Idea }) {
  const id = useId();
  const unread = idea.unreadOwned ? `${idea.unreadOwned} on the shelf, unread` : 'nothing unread';
  return (
    <section className="brain-panel card" aria-labelledby={`${id}-h`}>
      <span className={`pill${idea.isNew ? ' pill-new' : idea.focus ? ' pill-focus' : ''}`}>{tagOf(idea)}</span>
      <h2 className="card-title" id={`${id}-h`}>{idea.name}</h2>
      <p className="card-meta">{idea.readCount} read · {unread}</p>
      <ul className="brain-layers" role="list">
        {LAYERS.map(([l, label]) => {
          const { books = [], next } = layerOf(idea, l);
          return (
            <li key={l} className={`brain-layer ring-${l}`}>
              <span className="brain-layer-head"><span className="brain-swatch" aria-hidden="true" /><b>{label}</b><span className="card-meta">{books.length ? `${books.length} read` : 'empty'}</span></span>
              {books.map((bk) => <span key={bk.id} className="brain-book">✓ {bk.title}</span>)}
              {!books.length && (next ? <span className="brain-next">Next: {next.title}</span> : <span className="card-meta">Nothing on the backlog for it yet.</span>)}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------- the table

function LayerCell({ idea, layer }: { idea: Idea; layer: Layer }) {
  const { books = [], next } = layerOf(idea, layer);
  if (books.length) return <ul className="brain-cell" role="list">{books.map((b) => <li key={b.id}>{b.title}</li>)}</ul>;
  return next ? <span className="brain-gap">Gap. Next: {next.title}</span> : <span className="brain-none">Empty</span>;
}

function IdeaTable({ ideas, view, sel, onPick, own, name }: { ideas: Idea[]; view: View; sel: string | null; onPick: (id: string) => void; own: boolean; name: string }) {
  const id = useId();
  const caption = view === 'all' ? 'Every idea' : view === 'focus' ? 'This month’s focus' : 'Gaps: new ideas, and layers the backlog would fill';
  return (
    <section className="group-block brain-section" aria-labelledby={`${id}-h`}>
      <div className="group-head"><h2 id={`${id}-h`}>{own ? 'Your ideas' : `${name}’s ideas`}</h2><span>{ideas.length}</span></div>
      {!ideas.length ? (
        <p className="group-foot">{view === 'focus' ? 'No focus yet: the month’s picks choose where the brain grows.' : 'No gaps: every layer is read, or nothing on the backlog fills it.'}</p>
      ) : (
        <div className="brain-scroll card" role="region" aria-labelledby={`${id}-c`} tabIndex={0}>
          <table className="brain-table">
            <caption id={`${id}-c`} className="sr-only">{caption}: books read per layer, and the next suggestion for an empty one</caption>
            <thead>
              <tr><th scope="col">Idea</th><th scope="col">Read</th>{LAYERS.map(([l, label]) => <th key={l} scope="col">{label}</th>)}<th scope="col">Unread on the shelf</th></tr>
            </thead>
            <tbody>
              {ideas.map((i) => (
                <tr key={i.id} className={i.id === sel ? 'is-sel' : undefined}>
                  <th scope="row">
                    <button type="button" className="brain-pick" aria-pressed={i.id === sel} onClick={() => onPick(i.id)}>{i.name}</button>
                    <span className="brain-tag">{tagOf(i)}</span>
                  </th>
                  <td>{i.readCount}</td>
                  {LAYERS.map(([l]) => <td key={l}><LayerCell idea={i} layer={l} /></td>)}
                  <td>{i.unreadOwned}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Connections({ edges, ideas }: { edges: Edge[]; ideas: Idea[] }) {
  const id = useId();
  const names = new Map(ideas.map((i) => [i.id, i.name]));
  return (
    <section className="group-block" aria-labelledby={`${id}-h`}>
      <div className="group-head"><h2 id={`${id}-h`}>Connections</h2><span>{edges.length}</span></div>
      {!edges.length ? <p className="group-foot">No book connects two of these ideas yet.</p> : (
        <ul className="group" role="list">
          {edges.map((e) => (
            <li key={`${e.kind}:${e.a}:${e.b}`} className="row">
              <span className="row-main">
                <span className="row-title wrap">{names.get(e.a ?? '')} and {names.get(e.b ?? '')}</span>
                <span className="row-sub wrap">{e.kind === 'future' ? 'Would connect them: ' : `${e.weight} read: `}{(e.via ?? []).join(', ')}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
