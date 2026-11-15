// The Backlog (spec §4, the design's "Backlog"): one filter bar with the query language of contracts/backlog-query.md
// (parsed by packages/contracts here and on the server), open/closed tabs, dropdowns per qualifier with counts, saved
// filters, labels that add their qualifier, a score that opens into its parts, grouping, and bulk actions.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
// The query module only: the package's root also holds the AI schemas (Ajv), which the page must not load (CSP).
import { parseQuery, withQualifier, type QualifierKey } from '@shelf/contracts/backlog-query';
import { api, message, type Candidate, type Me } from '../api';
import { Notice, PageHead } from '../ui';

interface Page { items: Candidate[]; counts: { open?: number; closed?: number }; facets: Record<string, { value?: string; count?: number }[]>; nextCursor: string | null; queryErrors: string[] }
interface Saved { id?: string; name?: string; q?: string }

const DEFAULT_Q = 'is:open sort:score';
const MOVE: Record<string, string> = { deepen: 'Deepen', connect: 'Connect', broaden: 'Broaden', counterpoint: 'Counterpoint', wildcard: 'Wildcard', intro: 'Intro', fiction: 'Fiction' };
const SOURCE: Record<string, [QualifierKey, string, string]> = {
  share: ['source', 'instagram', 'From a share'], wishlist: ['source', 'wishlist', 'Wishlist'], to_buy: ['source', 'to-buy', 'To buy'],
  ai: ['source', 'ai', 'AI suggestion'], manual: ['source', 'manual', 'Added by hand'], seed: ['source', 'manual', 'Imported'],
};
const REASON: Record<string, string> = { not_for_me: 'Not for me', snoozed: 'Snoozed', owned: 'Owned', repeats: 'Repeats a book', picked: 'Picked' };
const FACETS: [string, string][] = [['for', 'For'], ['move', 'Move'], ['idea', 'Idea'], ['source', 'Source']];
const SORTS: [string, string][] = [['score', 'Score'], ['links', 'Links'], ['price', 'Price'], ['added', 'Added'], ['title', 'Title']];
type Group = 'none' | 'for' | 'move' | 'idea';
const GROUPS: [Group, string][] = [['none', 'No groups'], ['for', 'Group: person'], ['move', 'Group: move'], ['idea', 'Group: idea or theme']];
const chf = (c?: number) => (c == null ? null : `CHF ${(c / 100).toFixed(2)}`);

export function Backlog({ me }: { me: Me }) {
  const [q, setQ] = useState(() => new URLSearchParams(location.search).get('q') ?? DEFAULT_Q);
  const [draft, setDraft] = useState(q);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [group, setGroup] = useState<Group>('none');
  const [saved, setSaved] = useState<Saved[]>([]);
  const [said, setSaid] = useState('');
  const barId = useId();

  const load = useCallback(async (cursor?: string) => {
    setError(null);
    try {
      const next = await api<Page>(`/backlog?q=${encodeURIComponent(q)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      setPage((prev) => (cursor && prev ? { ...next, items: [...prev.items, ...next.items] } : next));
    } catch (e) { setError(message(e)); }
  }, [q]);
  useEffect(() => {
    setSelected(new Set());
    setDraft(q);
    history.replaceState(null, '', q === DEFAULT_Q ? location.pathname : `${location.pathname}?q=${encodeURIComponent(q)}`);
    void load();
  }, [q, load]);
  const loadSaved = useCallback(() => api<Saved[]>('/backlog/saved-filters').then(setSaved, () => undefined), []);
  useEffect(() => { void loadSaved(); }, [loadSaved]);

  const state = useMemo(() => parseQuery(q).state, [q]);
  const sort = useMemo(() => parseQuery(q).sort, [q]);
  const add = (key: QualifierKey, value: string) => setQ(withQualifier(q, key, value));

  const act = async (action: 'not_for_me' | 'snooze' | 'reopen', text: string) => {
    setError(null);
    try {
      const r = await api<{ changed: number }>('/backlog/bulk', { method: 'POST', body: { ids: [...selected], action, ...(action === 'snooze' ? { months: 3 } : {}) } });
      setSaid(`${r.changed} ${r.changed === 1 ? 'book' : 'books'} ${text}.`);
      setSelected(new Set());
      await load();
    } catch (e) { setError(message(e)); }
  };

  const groups = useMemo(() => {
    const items = page?.items ?? [];
    if (group === 'none') return [['', items]] as [string, Candidate[]][];
    const m = new Map<string, Candidate[]>();
    for (const c of items) {
      const k = group === 'for' ? c.for?.name ?? '—' : group === 'move' ? MOVE[c.move ?? ''] ?? (c.for?.role === 'kid' ? 'Kids' : 'No move') : c.ideas?.[0]?.name ?? (c.theme ?? 'No idea yet');
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return [...m];
  }, [page, group]);

  return (
    <>
      <PageHead title="Backlog" sub={<>Filter like on GitHub: type qualifiers such as <code>move:deepen</code> or <code>price:&lt;25</code>, or click any label in the list to add it.</>} />
      <div className="stack">
        {saved.length > 0 && (
          <div className="chips" role="group" aria-label="Saved filters">
            {saved.map((f) => (
              <button key={f.id} type="button" className="chip" aria-pressed={f.q === q} onClick={() => setQ(f.q ?? DEFAULT_Q)}>{f.name}</button>
            ))}
            <ManageFilters saved={saved} onChanged={async (text) => { await loadSaved(); setSaid(text); }} />
          </div>
        )}
        <form role="search" className="bl-bar" onSubmit={(e) => { e.preventDefault(); setQ(draft.trim() || DEFAULT_Q); }}>
          <label className="sr-only" htmlFor={barId}>Filter backlog</label>
          <input id={barId} className="input mono" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={500} spellCheck={false} autoComplete="off" />
          <button type="submit" className="btn btn-primary">Filter</button>
          <button type="button" className="btn" onClick={() => setQ(DEFAULT_Q)}>Clear</button>
          <SaveFilter q={q} onSaved={async (name) => { await loadSaved(); setSaid(`Saved as ${name}.`); }} />
        </form>
        {page && page.queryErrors.length > 0 && <Notice kind="warn" title="Some of the filter was ignored.">{page.queryErrors.join('; ')}</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
        <p className="sr-only" role="status">{said || (page ? `${page.items.length} shown` : 'Loading')}</p>

        <div className="bl-tools">
          <div className="segmented" role="group" aria-label="Open or closed" style={{ '--n': 2, '--pos': state === 'open' ? 0 : 1 } as React.CSSProperties}>
            <span className="segmented-thumb" aria-hidden="true" />
            <button type="button" aria-pressed={state === 'open'} onClick={() => add('is', 'open')}>{page?.counts.open ?? 0} open</button>
            <button type="button" aria-pressed={state === 'closed'} onClick={() => add('is', 'closed')}>{page?.counts.closed ?? 0} closed</button>
          </div>
          {/* Menu buttons (ARIA APG menu button), not <select>s: a closed select applies its next value on Arrow Down in
              some browsers, which here would refilter on every key (WCAG 3.2.2). Nothing happens until a value is chosen. */}
          {FACETS.map(([key, label]) => (
            <MenuButton key={key} label={label} name={`Filter by ${label.toLowerCase()}`}
              items={(page?.facets[key] ?? []).map((f) => ({ value: f.value!, text: `${key === 'move' ? MOVE[f.value!] ?? f.value : f.value} (${f.count})` }))}
              empty="Nothing to filter by" onPick={(v) => add(key as QualifierKey, v)} />
          ))}
          <MenuButton label={`Sort: ${SORTS.find(([k]) => k === sort.field)?.[1] ?? 'Score'}`} name="Sort by" checked={sort.field}
            items={SORTS.map(([k, l]) => ({ value: k, text: l }))} onPick={(v) => add('sort', v)} />
          <MenuButton label={GROUPS.find(([k]) => k === group)![1]} name="Group by" checked={group}
            items={GROUPS.map(([k, l]) => ({ value: k, text: l }))} onPick={(v) => setGroup(v as Group)} />
        </div>

        {selected.size > 0 && (
          <div className="bl-bulk card" role="region" aria-label="Selected books">
            <b>{selected.size} selected</b>
            <div className="btn-row">
              {state === 'open' ? (
                <>
                  <button type="button" className="btn btn-sm" onClick={() => void act('not_for_me', 'marked not for me')}>Not for me</button>
                  <button type="button" className="btn btn-sm" onClick={() => void act('snooze', 'snoozed for 3 months')}>Snooze 3 months</button>
                </>
              ) : <button type="button" className="btn btn-sm" onClick={() => void act('reopen', 'reopened')}>Reopen</button>}
              <button type="button" className="btn btn-sm btn-plain" onClick={() => setSelected(new Set())}>Clear selection</button>
            </div>
          </div>
        )}

        {page && page.items.length === 0 && (
          <div className="empty"><span className="empty-title">No books match</span><span className="empty-text mono">{q}</span></div>
        )}
        {groups.map(([name, items]) => items.length > 0 && (
          <section key={name || 'all'} className="group-block" aria-label={name || 'Books'}>
            {name && <div className="group-head"><h2>{name}</h2><span>{items.length}</span></div>}
            <ul className="group" role="list">
              {items.map((c) => (
                <Row key={c.id} c={c} me={me} checked={selected.has(c.id!)} onAdd={add}
                  onCheck={(on) => setSelected((s) => { const n = new Set(s); if (on) n.add(c.id!); else n.delete(c.id!); return n; })} />
              ))}
            </ul>
          </section>
        ))}
        {page?.nextCursor && <button type="button" className="btn" onClick={() => void load(page.nextCursor!)}>Show more</button>}
        <AddBook me={me} onAdded={async (title) => { setSaid(`${title} added.`); await load(); }} />
      </div>
    </>
  );
}

function Row({ c, me, checked, onCheck, onAdd }: { c: Candidate; me: Me; checked: boolean; onCheck: (on: boolean) => void; onAdd: (k: QualifierKey, v: string) => void }) {
  const [open, setOpen] = useState(false);
  const partsId = useId();
  const title = c.book?.title ?? '';
  const mine = c.for?.id === me.person?.id || c.for?.role === 'kid';
  const src = SOURCE[c.source ?? 'manual'];
  const label = (k: QualifierKey, v: string, text: string, cls = '') => (
    <button type="button" className={`bl-label ${cls}`} onClick={() => onAdd(k, v)} aria-label={`${text}: filter by ${k}:${v}`}>{text}</button>
  );
  return (
    <li className={`row bl-row${c.state === 'closed' ? ' is-closed' : ''}`}>
      {mine && <input type="checkbox" className="bl-check" checked={checked} onChange={(e) => onCheck(e.target.checked)} aria-label={`Select ${title}`} />}
      <span className="row-main">
        <span className="row-title wrap">{title}</span>
        <span className="row-sub wrap">{(c.book?.authors ?? []).join(', ')}{c.closedReason ? ` · ${REASON[c.closedReason]}` : ''}</span>
        <span className="bl-labels">
          {c.for?.handle && label('for', c.for.handle, `For ${c.for.name}`)}
          {c.move && label('move', c.move, MOVE[c.move]!, 'is-move')}
          {(c.ideas ?? []).map((i) => label('idea', i.name ?? '', i.name ?? ''))}
          {c.theme && label('theme', c.theme, c.theme, 'is-kids')}
          {src && label(src[0], src[1], src[2])}
        </span>
        {open && (
          <ul className="bl-parts" id={partsId} role="list">
            {(c.scoreParts ?? []).map((p, i) => <li key={i}><span>{p.label}</span><b>{(p.value ?? 0) > 0 ? '+' : ''}{Math.round((p.value ?? 0) * 10) / 10}</b></li>)}
            {(c.buildsOn ?? []).length > 0 && <li className="bl-builds">Builds on {(c.buildsOn ?? []).map((b) => `${b.book?.title} (${b.reason})`).join('; ')}</li>}
          </ul>
        )}
      </span>
      <span className="row-trail bl-trail">
        {c.price != null && <span className="bl-price">{chf(c.price)}</span>}
        <button type="button" className="btn btn-sm bl-score" aria-expanded={open} aria-controls={partsId} onClick={() => setOpen(!open)}>
          {c.score != null ? <>Score {Math.round(c.score)}</> : 'Over the price limit'}<span className="sr-only">: show its parts for {title}</span>
        </button>
      </span>
    </li>
  );
}

function SaveFilter({ q, onSaved }: { q: string; onSaved: (name: string) => Promise<void> }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!open) return <button type="button" className="btn" onClick={() => setOpen(true)}>Save filter</button>;
  const save = async () => {
    setError(null);
    try { await api('/backlog/saved-filters', { method: 'POST', body: { name: name.trim(), q } }); setOpen(false); setName(''); await onSaved(name.trim()); } catch (e) { setError(message(e)); }
  };
  return (
    <span className="bl-save">
      <label className="sr-only" htmlFor={id}>Name of the saved filter</label>
      <input id={id} className="input" value={name} maxLength={40} placeholder="Name" onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }} />
      <button type="button" className="btn" disabled={!name.trim()} onClick={() => void save()}>Save</button>
      {error && <span className="error-text" role="alert">{error}</span>}
    </span>
  );
}

function AddBook({ me, onAdded }: { me: Me; onAdded: (title: string) => Promise<void> }) {
  const id = useId();
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [forWho, setFor] = useState('me');
  const [error, setError] = useState<string | null>(null);
  const kids = (me.household ?? []).filter((p) => p.role === 'kid' && p.handle);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api('/backlog', { method: 'POST', body: { title: title.trim(), ...(author.trim() ? { author: author.trim() } : {}), for: forWho } });
      const t = title.trim();
      setTitle(''); setAuthor('');
      await onAdded(t);
    } catch (err) { setError(message(err)); }
  };
  return (
    <section className="card" aria-labelledby={`${id}-h`}>
      <h2 className="card-title" id={`${id}-h`}>Add a book</h2>
      <form className="stack" onSubmit={submit} noValidate>
        <div className="fields fields-2">
          <div className="field"><label className="field-label" htmlFor={`${id}-t`}>Title</label><input className="input" id={`${id}-t`} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} required /></div>
          <div className="field"><label className="field-label" htmlFor={`${id}-a`}>Author</label><input className="input" id={`${id}-a`} value={author} maxLength={200} onChange={(e) => setAuthor(e.target.value)} /></div>
          <div className="field"><label className="field-label" htmlFor={`${id}-f`}>For</label>
            <select className="input select" id={`${id}-f`} value={forWho} onChange={(e) => setFor(e.target.value)}>
              <option value="me">Me</option>
              {kids.map((k) => <option key={k.id} value={k.handle!}>{k.name}</option>)}
            </select>
          </div>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="btn-row"><button type="submit" className="btn btn-primary" disabled={!title.trim()}>Add to the backlog</button></div>
      </form>
    </section>
  );
}

/**
 * A menu button (ARIA APG): Enter, Space or Arrow Down opens the menu on its first (or checked) item, Arrow Up on its
 * last; arrows, Home and End move; Enter or Space chooses; Escape closes and returns to the button; Tab or a click
 * elsewhere closes. With `checked`, the items are menuitemradio.
 */
function MenuButton({ label, name, items, onPick, checked, empty = 'Nothing here' }: {
  label: string; name: string; items: { value: string; text: string }[]; onPick: (v: string) => void; checked?: string; empty?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const first = useRef<'first' | 'last'>('first');

  useEffect(() => {
    if (!open) return;
    const i = first.current === 'last' ? items.length - 1 : Math.max(0, items.findIndex((x) => x.value === checked));
    refs.current[i]?.focus();
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]); // focus once, when it opens (not on each new list of items)

  const close = (focus = true) => { setOpen(false); if (focus) button.current?.focus(); };
  const onButtonKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      first.current = e.key === 'ArrowUp' ? 'last' : 'first';
      setOpen(true);
    }
  };
  const onMenuKey = (e: React.KeyboardEvent, i: number) => {
    const n = items.length;
    const to = e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowUp' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to >= 0) { e.preventDefault(); refs.current[to]?.focus(); return; }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') close(false);
  };
  const role = checked === undefined ? 'menuitem' : 'menuitemradio';
  return (
    <div className="bl-menu-wrap" ref={wrap}>
      <button ref={button} type="button" className="btn btn-sm bl-menu-btn" id={`${id}-b`} aria-haspopup="menu" aria-expanded={open}
        aria-controls={`${id}-m`} aria-label={name === label ? undefined : `${name}: ${label}`}
        onClick={() => { first.current = 'first'; setOpen(!open); }} onKeyDown={onButtonKey}>
        {label}<span aria-hidden="true" className="bl-chev">▾</span>
      </button>
      {open && (
        <div className="menu is-open bl-menu" role="menu" id={`${id}-m`} aria-labelledby={`${id}-b`}>
          {items.length === 0 ? <p className="menu-label">{empty}</p> : items.map((it, i) => (
            <button key={it.value} ref={(el) => { refs.current[i] = el; }} type="button" role={role} tabIndex={-1} className="menu-item"
              {...(role === 'menuitemradio' ? { 'aria-checked': it.value === checked } : {})}
              onClick={() => { close(); onPick(it.value); }} onKeyDown={(e) => onMenuKey(e, i)}>
              {it.text}{it.value === checked && <span className="sr-only"> (current)</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Rename or remove saved filters (the list is capped, so removing is how there is room again). */
function ManageFilters({ saved, onChanged }: { saved: Saved[]; onChanged: (said: string) => Promise<void> }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const call = async (f: Saved, method: 'PATCH' | 'DELETE', name?: string) => {
    setError(null);
    try {
      await api(`/backlog/saved-filters/${encodeURIComponent(f.id ?? '')}`, { method, ...(name ? { body: { name } } : {}) });
      await onChanged(method === 'DELETE' ? `${f.name} removed.` : `Renamed to ${name}.`);
    } catch (e) { setError(message(e)); }
  };
  return (
    <>
      <button type="button" className="chip" aria-expanded={open} aria-controls={`${id}-p`} onClick={() => setOpen(!open)}>Manage</button>
      {open && (
        <div className="card bl-manage" id={`${id}-p`}>
          <ul className="group" role="list" aria-label="Your saved filters">
            {saved.map((f) => <ManageRow key={f.id} f={f} onRename={(n) => void call(f, 'PATCH', n)} onRemove={() => void call(f, 'DELETE')} />)}
          </ul>
          {error && <Notice kind="error">{error}</Notice>}
        </div>
      )}
    </>
  );
}

function ManageRow({ f, onRename, onRemove }: { f: Saved; onRename: (name: string) => void; onRemove: () => void }) {
  const id = useId();
  const [name, setName] = useState(f.name ?? '');
  return (
    <li className="row bl-manage-row">
      <span className="row-main">
        <label className="sr-only" htmlFor={id}>Name of {f.name}</label>
        <input className="input" id={id} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        <span className="row-sub mono wrap">{f.q}</span>
      </span>
      <span className="row-trail">
        <button type="button" className="btn btn-sm" disabled={!name.trim() || name.trim() === f.name} onClick={() => onRename(name.trim())}>Rename<span className="sr-only"> {f.name}</span></button>
        <button type="button" className="btn btn-sm btn-destructive" onClick={onRemove}>Remove<span className="sr-only"> {f.name}</span></button>
      </span>
    </li>
  );
}
