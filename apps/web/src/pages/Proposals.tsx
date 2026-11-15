// Waiting for a decision (ADR 0005): ideas proposed for books and links between books, until a person confirms or
// rejects them; moving an idea to another layer confirms it there. A proposal written from someone's takeaways is
// theirs alone: the server sends it only to them, marked "Only you see this".
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, message, type Layer, type Proposals as Data } from '../api';
import { Notice, PageHead } from '../ui';
import { LAYERS } from './Brain';

type IdeaP = Data['ideas'][number];
type LinkP = Data['links'][number];

const authors = (b: { authors?: string[] }) => (b.authors?.length ? ` by ${b.authors.join(', ')}` : '');

export function Proposals() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const refocus = useRef<{ list: string; at: number } | null>(null);
  const ideasRef = useRef<HTMLElement>(null);
  const linksRef = useRef<HTMLElement>(null);

  const load = useCallback(() => api<Data>('/proposals').then(setData, (e) => setError(message(e))), []);
  useEffect(() => { void load(); }, [load]);
  // After a decision the row goes: focus moves to the next one's first control, or to the list's heading.
  useEffect(() => {
    const r = refocus.current;
    if (!r || !data) return;
    refocus.current = null;
    const sec = (r.list === 'ideas' ? ideasRef : linksRef).current;
    const rows = sec?.querySelectorAll<HTMLElement>('[data-row]') ?? [];
    const row = rows[Math.min(r.at, rows.length - 1)];
    (row?.querySelector<HTMLElement>('select, button') ?? sec?.querySelector<HTMLElement>('h2'))?.focus();
  }, [data]);

  const decide = async (list: 'ideas' | 'links', at: number, path: string, body: object, said: string) => {
    setError(null);
    setBusy(true);
    try {
      await api(path, { method: 'PUT', body });
      refocus.current = { list, at };
      setStatus(said);
      await load();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const idea = (p: IdeaP, at: number, body: { state?: 'confirmed' | 'rejected'; layer?: Layer }) => {
    const what = `${p.idea.name} on ${p.book.title}`;
    const said = body.layer ? `${what}: confirmed, ${LAYERS.find(([l]) => l === body.layer)![1]} layer.` : `${what}: ${body.state}.`;
    return decide('ideas', at, `/books/${encodeURIComponent(p.book.id)}/ideas/${encodeURIComponent(p.idea.id)}`, body, said);
  };
  const link = (p: LinkP, at: number, state: 'confirmed' | 'rejected') =>
    decide('links', at, `/links/${encodeURIComponent(p.from.id)}/${encodeURIComponent(p.to.id)}`, { state }, `${p.from.title} to ${p.to.title}: ${state}.`);

  return (
    <>
      <PageHead title="Waiting for a decision" sub="Ideas and links proposed for your books. Nothing counts in a brain or a score until a person confirms it." />
      <div className="stack">
        {error && <Notice kind="error">{error}</Notice>}
        <p className="sr-only" role="status">{status}</p>
        {!data ? <p className="sr-only" role="status">Loading</p> : (
          <>
            <section className="group-block" ref={ideasRef} aria-labelledby="pr-ideas-h">
              <div className="group-head"><h2 id="pr-ideas-h" tabIndex={-1}>Ideas on books</h2><span>{data.ideas.length}</span></div>
              {data.ideas.length ? (
                <ul className="group" role="list">
                  {data.ideas.map((p, at) => <IdeaRow key={`${p.book.id}:${p.idea.id}`} p={p} busy={busy} onDecide={(body) => void idea(p, at, body)} />)}
                </ul>
              ) : <p className="group-foot">Nothing is waiting.</p>}
            </section>
            <section className="group-block" ref={linksRef} aria-labelledby="pr-links-h">
              <div className="group-head"><h2 id="pr-links-h" tabIndex={-1}>Links between books</h2><span>{data.links.length}</span></div>
              {data.links.length ? (
                <ul className="group" role="list">
                  {data.links.map((p, at) => <LinkRow key={`${p.from.id}:${p.to.id}`} p={p} busy={busy} onDecide={(s) => void link(p, at, s)} />)}
                </ul>
              ) : <p className="group-foot">Nothing is waiting.</p>}
            </section>
          </>
        )}
      </div>
    </>
  );
}

function Pills({ fromAi, onlyYou }: { fromAi: boolean; onlyYou: boolean }) {
  if (!fromAi && !onlyYou) return null;
  return (
    <span className="pr-pills">
      {fromAi && <span className="pill">Proposed by the AI</span>}
      {onlyYou && <span className="pill pill-orange">Only you see this</span>}
    </span>
  );
}

function IdeaRow({ p, busy, onDecide }: { p: IdeaP; busy: boolean; onDecide: (b: { state?: 'confirmed' | 'rejected'; layer?: Layer }) => void }) {
  const id = useId();
  const what = `${p.idea.name} on ${p.book.title}`;
  return (
    <li className="row pr-row" data-row>
      <span className="row-main">
        <span className="row-title wrap">{p.book.title}<span className="row-sub">{authors(p.book)}</span></span>
        <span className="row-sub wrap">Idea: <b>{p.idea.name}</b>, {LAYERS.find(([l]) => l === p.layer)?.[1]} layer · {Math.round(p.confidence * 100)}% sure</span>
        <Pills fromAi={p.fromAi} onlyYou={p.onlyYou} />
      </span>
      <span className="row-trail pr-trail">
        <label className="sr-only" htmlFor={`${id}-l`}>Layer of {what}</label>
        <select className="input select pr-layer" id={`${id}-l`} value={p.layer} disabled={busy} aria-describedby={`${id}-d`}
          onChange={(e) => onDecide({ layer: e.target.value as Layer })}>
          {LAYERS.map(([l, label]) => <option key={l} value={l}>{label}</option>)}
        </select>
        <span className="sr-only" id={`${id}-d`}>Choosing another layer confirms it there.</span>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} aria-label={`Confirm ${what}`} onClick={() => onDecide({ state: 'confirmed' })}>Confirm</button>
        <button type="button" className="btn btn-sm" disabled={busy} aria-label={`Reject ${what}`} onClick={() => onDecide({ state: 'rejected' })}>Reject</button>
      </span>
    </li>
  );
}

function LinkRow({ p, busy, onDecide }: { p: LinkP; busy: boolean; onDecide: (s: 'confirmed' | 'rejected') => void }) {
  const what = `the link from ${p.from.title} to ${p.to.title}`;
  return (
    <li className="row pr-row" data-row>
      <span className="row-main">
        <span className="row-title wrap">{p.from.title} <span aria-hidden="true">→</span><span className="sr-only">leads to</span> {p.to.title}</span>
        <span className="row-sub wrap">{p.reason} · {Math.round(p.confidence * 100)}% sure</span>
        <Pills fromAi={p.fromAi} onlyYou={p.onlyYou} />
      </span>
      <span className="row-trail pr-trail">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} aria-label={`Confirm ${what}`} onClick={() => onDecide('confirmed')}>Confirm</button>
        <button type="button" className="btn btn-sm" disabled={busy} aria-label={`Reject ${what}`} onClick={() => onDecide('rejected')}>Reject</button>
      </span>
    </li>
  );
}
