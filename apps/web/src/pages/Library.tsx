// The Library (spec §4, the design's "Library"): per person. Adults: a status per book, the takeaway prompt when a
// book is marked read, and the stats. Kids: the emotional map and loved / meh / not yet per book. You change your own
// readings and act for the kids; another adult's library is for looking, and their takeaways stay theirs (the server
// never sends them).
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, message, type Library as Lib, type Me, type Person, type Reading, type Settings } from '../api';
import { Notice, PageHead } from '../ui';

type Item = NonNullable<Lib['books']>[number];
type Status = NonNullable<Reading['status']>;
type Feedback = 'loved' | 'meh' | 'not_yet';

const STATUS: [Status, string][] = [['to_read', 'To read'], ['reading', 'Reading'], ['read', 'Read'], ['abandoned', 'Stopped']];
const FEEDBACK: [Feedback, string][] = [['loved', 'Loved'], ['meh', 'Meh'], ['not_yet', 'Not yet']];
const TAKEAWAY_MAX = 280;

export function Library({ me }: { me: Me }) {
  const people = me.household ?? [];
  const [who, setWho] = useState(me.person?.id ?? '');
  const [lib, setLib] = useState<Lib | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Item | null>(null);
  const [settings, setSettings] = useState<Settings['person'] | null>(null);
  const [status, setStatus] = useState('');

  const load = useCallback(() => {
    setError(null);
    return api<Lib>(`/people/${encodeURIComponent(who)}/library`).then(setLib, (e) => setError(message(e)));
  }, [who]);
  useEffect(() => { setLib(null); void load(); }, [load]);
  useEffect(() => { api<Settings>('/settings').then((s) => setSettings(s.person ?? null), () => undefined); }, []);

  const person = lib?.person;
  const own = person?.id === me.person?.id;
  const kid = person?.role === 'kid';
  const canChange = own || kid;

  const save = async (it: Item, body: Partial<Reading>, said: string) => {
    setError(null);
    try {
      const reading = await api<Reading>(`/people/${encodeURIComponent(who)}/reading/${encodeURIComponent(it.book.id)}`, { method: 'PUT', body });
      setStatus(said);
      await load();
      return reading;
    } catch (e) { setError(message(e)); return null; }
  };
  const setBookStatus = async (it: Item, st: Status) => {
    const was = it.reading?.status;
    const r = await save(it, { status: st }, `${it.book.title}: ${STATUS.find(([k]) => k === st)![1]}.`);
    if (r && st === 'read' && was !== 'read' && own && settings?.takeaways !== false) setPrompt({ ...it, reading: r });
  };

  return (
    <>
      <PageHead title="Library" sub="What each of you owns and has read. Only finished books grow a brain." />
      <div className="stack">
        <PersonPicker people={people} who={who} me={me.person?.id} onPick={setWho} />
        {error && <Notice kind="error">{error}</Notice>}
        <p className="sr-only" role="status">{status}</p>
        {!lib ? <p className="sr-only" role="status">Loading</p> : kid ? (
          <KidLibrary lib={lib} onFeedback={(it, f) => void save(it, { feedback: f }, `${it.book.title}: ${FEEDBACK.find(([k]) => k === f)![1]}.`)} />
        ) : (
          <>
            <Stats lib={lib} own={own} />
            <section className="group-block" aria-labelledby="books-h">
              <div className="group-head"><h2 id="books-h">{own ? 'Your books' : `${person?.name}’s books`}</h2><span>{lib.books?.length ?? 0}</span></div>
              {lib.books?.length ? (
                <ul className="group lib-list" role="list">
                  {lib.books.map((it) => (
                    <BookRow key={it.book.id} it={it} own={own} canChange={canChange}
                      onStatus={(st) => void setBookStatus(it, st)} onTakeaway={() => setPrompt(it)} />
                  ))}
                </ul>
              ) : <Empty />}
              {!own && <p className="group-foot">Only {person?.name} changes these, and their takeaways are theirs alone.</p>}
            </section>
            {own && settings && <AiTakeaways settings={settings} onChange={setSettings} />}
          </>
        )}
      </div>
      {prompt && (
        <TakeawaySheet it={prompt} onClose={() => setPrompt(null)}
          onSave={async (text) => { if (await save(prompt, { takeaway: text || null }, text ? 'Takeaway saved.' : 'Takeaway removed.')) setPrompt(null); }} />
      )}
    </>
  );
}

function PersonPicker({ people, who, me, onPick }: { people: Person[]; who: string; me?: string; onPick: (id: string) => void }) {
  return (
    <Choice label="Whose library" value={who} onChange={onPick} className="lib-people"
      options={people.map((p) => [p.id, p.id === me ? `${p.name} (you)` : p.name])} />
  );
}

function Stats({ lib, own }: { lib: Lib; own: boolean }) {
  const s = lib.stats ?? {};
  const pile = s.unreadPile ?? 0, limit = s.unreadLimit ?? 0;
  const over = pile > limit;
  return (
    <ul className="widgets lib-stats" role="list" aria-label="Reading so far">
      <Stat label="Read" value={s.read ?? 0} caption="grow the brain" />
      <Stat label="Reading" value={s.reading ?? 0} caption="glow on the map" />
      <Stat label="Unread pile" value={pile} caption={over ? `over the limit of ${limit}: fewer picks next month` : `limit ${limit}`} bad={over} />
      {own && <Stat label="Takeaways" value={s.takeaways ?? 0} caption="one line each, yours alone" />}
    </ul>
  );
}

function Stat({ label, value, caption, bad }: { label: string; value: number; caption: string; bad?: boolean }) {
  return (
    <li className={`widget${bad ? ' is-bad' : ''}`}>
      <span className="widget-label">{label}</span>
      <span className="widget-value">{value}</span>
      <span className="widget-caption">{caption}</span>
    </li>
  );
}

function BookRow({ it, own, canChange, onStatus, onTakeaway }: { it: Item; own: boolean; canChange: boolean; onStatus: (s: Status) => void; onTakeaway: () => void }) {
  const st = it.reading?.status ?? 'to_read';
  const authors = (it.book.authors ?? []).join(', ');
  return (
    <li className={`row lib-row${st === 'to_read' ? ' is-unread' : ''}`}>
      <Cover title={it.book.title} />
      <span className="row-main">
        <span className="row-title wrap">{it.book.title}</span>
        <span className="row-sub wrap">{[authors, ...(it.ideas ?? [])].filter(Boolean).join(' · ')}</span>
        {own && it.reading?.takeaway && <q className="lib-take">{it.reading.takeaway}</q>}
        {own && st === 'read' && (
          <button type="button" className="btn btn-plain btn-sm lib-take-btn" onClick={onTakeaway}>
            {it.reading?.takeaway ? 'Edit the takeaway' : 'Add a takeaway'}<span className="sr-only"> for {it.book.title}</span>
          </button>
        )}
      </span>
      <span className="row-trail">
        {canChange
          ? <Choice label={`Status of ${it.book.title}`} value={st} onChange={(v) => onStatus(v as Status)} options={STATUS} />
          : <span className="pill pill-neutral">{STATUS.find(([k]) => k === st)![1]}</span>}
      </span>
    </li>
  );
}

function KidLibrary({ lib, onFeedback }: { lib: Lib; onFeedback: (it: Item, f: Feedback) => void }) {
  const p = lib.person!;
  const themes = lib.themes ?? [];
  const most = Math.max(1, ...themes.map((t) => (t.books ?? 0) + (t.loved ?? 0)));
  return (
    <>
      <section className="card stack" aria-labelledby="map-h">
        <div>
          <h2 className="card-title" id="map-h">{p.name}’s emotional map</h2>
          <p className="footnote">{p.ageBand ? `Age ${p.ageBand.replace('-', '–')}. ` : ''}Loved books count double. Thin themes get picked first.</p>
        </div>
        <ul className="lib-map" role="list">
          {themes.map((t) => {
            const n = t.books ?? 0, loved = t.loved ?? 0;
            return (
              <li key={t.theme} className="meter">
                <span className="meter-head"><b>{t.theme}</b><span>{n ? `${n} ${n === 1 ? 'book' : 'books'}${loved ? `, ${loved} loved` : ''}` : 'none yet'}</span></span>
                <span className="meter-track" aria-hidden="true"><span className="meter-fill" style={{ '--used': `${((n + loved) / most) * 100}%` } as React.CSSProperties} /></span>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="group-block" aria-labelledby="kbooks-h">
        <div className="group-head"><h2 id="kbooks-h">{p.name}’s books</h2><span>{lib.books?.length ?? 0}</span></div>
        {lib.books?.length ? (
          <ul className="group lib-list" role="list">
            {lib.books.map((it) => (
              <li key={it.book.id} className="row lib-row">
                <Cover title={it.book.title} />
                <span className="row-main">
                  <span className="row-title wrap">{it.book.title}</span>
                  <span className="row-sub wrap">{[(it.book.authors ?? []).join(', '), ...(it.themes ?? [])].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="row-trail">
                  <Choice label={`How ${p.name} liked ${it.book.title}`} value={it.reading?.feedback ?? 'not_yet'}
                    onChange={(v) => onFeedback(it, v as Feedback)} options={FEEDBACK} />
                </span>
              </li>
            ))}
          </ul>
        ) : <Empty />}
        <p className="group-foot">Kids never sign in: the adults tell Shelf how a book went.</p>
      </section>
    </>
  );
}

function Empty() {
  return <div className="empty"><span className="empty-title">No books yet</span><span className="empty-text">Books the household owns appear here, and so does every book with a status.</span></div>;
}

/** A cover drawn from the title (stored nowhere, fetched from nowhere): the page never calls the network (ADR 0003). */
function Cover({ title }: { title: string }) {
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) % 360;
  const ini = title.replace(/^(The|A|An) /, '').split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase();
  return <span className="lib-cover" aria-hidden="true" style={{ '--h': h } as React.CSSProperties}>{ini}</span>;
}

/**
 * A single choice as a segmented control: a radio group with manual activation (ARIA APG). Arrow keys move focus
 * only; Space, Enter or a click chooses, because choosing has effects (a saved status, the takeaway prompt). Focus
 * comes back to the chosen option after the list re-sorts.
 */
function Choice({ label, value, options, onChange, className = '' }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void; className?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const chose = useRef<string | null>(null);
  const pos = Math.max(0, options.findIndex(([k]) => k === value));
  useEffect(() => {
    if (chose.current !== value) return; // wait for the saved value (the list may re-sort first)
    chose.current = null;
    // A modal opened by the choice keeps its focus; otherwise focus stays on the control.
    if (!document.querySelector('dialog[open]')) refs.current[pos]?.focus();
  });
  const key = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1
      : e.key === 'Home' ? -i : e.key === 'End' ? options.length - 1 - i : 0;
    if (!d) return;
    e.preventDefault();
    refs.current[(i + d + options.length) % options.length]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={`segmented ${className}`} style={{ '--n': options.length, '--pos': pos } as React.CSSProperties}>
      <span className="segmented-thumb" aria-hidden="true" />
      {options.map(([k, l], i) => (
        <button key={k} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={k === value} tabIndex={k === value ? 0 : -1}
          onClick={() => { if (k !== value) { chose.current = k; onChange(k); } }} onKeyDown={(e) => key(e, i)}>{l}</button>
      ))}
    </div>
  );
}

function TakeawaySheet({ it, onClose, onSave }: { it: Item; onClose: () => void; onSave: (text: string) => Promise<void> }) {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState(it.reading?.takeaway ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const d = ref.current!;
    d.showModal(); // the page behind is inert; focus starts in the dialog; Escape closes it
    return () => d.close();
  }, []);
  const ideas = (it.ideas ?? []).join(' and ');
  return (
    <dialog ref={ref} className="sheet is-open lib-sheet" aria-labelledby={`${id}-h`} aria-describedby={`${id}-sub`} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <form className="lib-sheet-form" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await onSave(text.trim()); setBusy(false); }}>
        <div className="sheet-head">
          <div className="sheet-head-text">
            <h2 className="sheet-title" id={`${id}-h`}>Finished {it.book.title}</h2>
            <p className="sheet-sub" id={`${id}-sub`}>{ideas ? `It adds to ${ideas}. ` : ''}What stuck with you? One line is plenty, and you can skip it.</p>
          </div>
        </div>
        <div className="sheet-body">
          <div className="field">
            <label className="field-label" htmlFor={`${id}-t`}>Takeaway (optional)</label>
            <textarea className="input textarea" id={`${id}-t`} value={text} maxLength={TAKEAWAY_MAX} autoFocus
              onChange={(e) => setText(e.target.value)} aria-describedby={`${id}-n`} />
            <span className="hint" id={`${id}-n`}>{TAKEAWAY_MAX - text.length} characters left. Only you see it.</span>
          </div>
        </div>
        <div className="sheet-foot">
          <button type="button" className="btn" onClick={onClose}>Skip</button>
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>Save</button>
        </div>
      </form>
    </dialog>
  );
}

function AiTakeaways({ settings, onChange }: { settings: NonNullable<Settings['person']>; onChange: (s: Settings['person']) => void }) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  const on = settings.takeawaysToAi === true;
  const flip = async () => {
    setError(null);
    try {
      await api('/settings', { method: 'PATCH', body: { person: { takeawaysToAi: !on } } });
      onChange({ ...settings, takeawaysToAi: !on });
    } catch (e) { setError(message(e)); }
  };
  return (
    <section className="group-block" aria-labelledby={`${id}-h`}>
      <div className="group-head"><h2 id={`${id}-h`}>Your takeaways and the AI</h2></div>
      <ul className="group" role="list">
        <li className="row">
          <span className="row-main">
            <label className="row-title" htmlFor={id}>Let the AI read my takeaways</label>
            <span className="row-sub wrap" id={`${id}-d`}>Off: no AI sees them, not even the one on this server. On: it may use them to link your next books.</span>
          </span>
          <span className="row-trail"><input type="checkbox" role="switch" className="switch" id={id} checked={on} onChange={() => void flip()} aria-describedby={`${id}-d`} /></span>
        </li>
      </ul>
      {error && <Notice kind="error">{error}</Notice>}
    </section>
  );
}
