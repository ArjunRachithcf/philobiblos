// The Inbox (spec §4): your shares, the AI's suggestions for you, and the household's bookshop mail that needs a person. For each book: add or skip;
// each item can be dismissed. Everything here is data from the server, rendered as text (never as markup): titles,
// captions and links come from phones and mail Philobiblos did not write, and a link is shown, never made clickable.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, message, type InboxItem, type Me } from '../api';
import { Choice, MenuButton, Notice, PageHead } from '../ui';
import { useMoney } from '../money';

type Found = InboxItem['found'][number];
interface Page { items: InboxItem[]; nextCursor: string | null }
const FILTERS: [string, string][] = [['all', 'All'], ['shared', 'Shared'], ['mail', 'Mail'], ['ai', 'AI']];
const KIND: Record<InboxItem['kind'], string> = {
  share: 'Shared', ai_suggestion: 'AI suggestion', unmatched_invoice_line: 'Invoice', unmatched_quote_line: 'Quote',
  unmatched_shop_line: 'Shop order', mail_failed: 'Could not read', mail_waiting: 'Waiting', mail_unverified: 'Not verified',
  maybe_typed_invoice: 'Invoice typed?',
};
const SHARE_STATUS: Record<string, string> = { received: 'Waiting for the media worker', reading: 'Reading the images and videos', done: 'Received', failed: 'Failed' };
const day = (iso?: string | null) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null; };

export function Inbox({ me }: { me: Me }) {
  const [filter, setFilter] = useState('all');
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const refocus = useRef<number | null>(null);
  const kids = (me.household ?? []).filter((p) => p.role === 'kid' && p.handle);

  const [next, setNext] = useState<string | null>(null);
  // The first page, again after each decision; "Show more" adds the pages after it.
  // A page can come back empty with more after it (settled rows newer than anything waiting): followed, up to ten.
  const load = useCallback(async () => {
    try {
      let p = await api<Page>(`/inbox?filter=${filter}`);
      for (let i = 0; i < 10 && !p.items.length && p.nextCursor; i++) p = await api<Page>(`/inbox?filter=${filter}&cursor=${encodeURIComponent(p.nextCursor)}`);
      setItems(p.items); setNext(p.nextCursor);
    } catch (e) { setError(message(e)); }
  }, [filter]);
  const more = async () => {
    if (!next) return;
    try { const p = await api<Page>(`/inbox?filter=${filter}&cursor=${encodeURIComponent(next)}`); setItems((x) => [...(x ?? []), ...p.items]); setNext(p.nextCursor); } catch (e) { setError(message(e)); }
  };
  useEffect(() => { void load(); }, [load]);
  // After a decision, focus goes to the next book's first button, or to the list's heading.
  useEffect(() => {
    const at = refocus.current;
    if (at == null || !items) return;
    refocus.current = null;
    const buttons = list.current?.querySelectorAll<HTMLElement>('[data-first]') ?? [];
    (buttons[Math.min(at, buttons.length - 1)] ?? list.current?.querySelector<HTMLElement>('h2'))?.focus();
  }, [items]);

  const act = async (path: string, body: object | undefined, said: string) => {
    setError(null);
    setBusy(true);
    const buttons = [...(list.current?.querySelectorAll<HTMLElement>('[data-first]') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    try {
      await api(path, { method: 'POST', body });
      refocus.current = Math.max(0, at);
      setStatus(said);
      await load();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const decide = (it: InboxItem, f: Found, action: 'add' | 'skip', forWho?: { handle: string; name: string }) =>
    act(`/inbox/${encodeURIComponent(it.id)}/books/${f.index}`, { action, ...(forWho ? { for: forWho.handle } : {}) },
      `${f.title ?? 'The line'}: ${action === 'skip' ? 'skipped' : forWho ? `added for ${forWho.name}` : 'added'}.`);
  const dismiss = (it: InboxItem) => act(`/inbox/${encodeURIComponent(it.id)}/dismiss`, undefined, `${it.title}: dismissed.`);
  const answer = (it: InboxItem, a: 'same' | 'another') => act(`/inbox/${encodeURIComponent(it.id)}/typed`, { answer: a },
    a === 'same' ? 'Counted once, as the invoice typed in.' : 'Counted as another purchase: its copies are in the library.');

  return (
    <>
      <PageHead title="Inbox" sub="What you shared, what the AI suggests for you, and the bookshop’s mail that needs a person. Add or skip each book." />
      <div className="stack" ref={list}>
        <Choice label="Show" value={filter} options={FILTERS} onChange={setFilter} />
        {error && <Notice kind="error">{error}</Notice>}
        <p className="sr-only" role="status">{status}</p>
        {!items ? <p className="sr-only" role="status">Loading</p> : !items.length && !next ? (
          <section className="group-block" aria-labelledby="in-empty-h">
            <div className="group-head"><h2 id="in-empty-h" tabIndex={-1}>Nothing waiting</h2></div>
            <p className="group-foot">{filter === 'ai' ? 'The AI’s suggestions for you arrive here, after the monthly refresh or when an admin runs them.' : 'Share a post from your phone, or wait for the bookshop’s next mail.'}</p>
          </section>
        ) : items.map((it) => (it.kind === 'maybe_typed_invoice'
          ? <TypedItem key={it.id} it={it} busy={busy} onAnswer={answer} />
          : <Item key={it.id} it={it} kids={kids} busy={busy} onDecide={decide} onDismiss={dismiss} />))}
        {next && <div className="btn-row"><button type="button" className="btn" onClick={() => void more()}>Show more</button></div>}
      </div>
    </>
  );
}

function Item({ it, kids, busy, onDecide, onDismiss }: {
  it: InboxItem; kids: { handle?: string | null; name: string }[]; busy: boolean;
  onDecide: (it: InboxItem, f: Found, a: 'add' | 'skip', forWho?: { handle: string; name: string }) => void; onDismiss: (it: InboxItem) => void;
}) {
  const h = `in-${it.id}`;
  const when = day(it.mail?.date ?? it.createdAt);
  return (
    <section className="group-block" aria-labelledby={h}>
      <div className="group-head">
        <h2 id={h} tabIndex={-1} className="wrap">{it.title}</h2>
        <span className="pill pill-neutral">{KIND[it.kind]}</span>
      </div>
      <div className="card stack">
        <p className="footnote">{[when, it.by ? `shared by ${it.by.name}` : null].filter(Boolean).join(' · ')}</p>
        {it.share && <ShareFacts s={it.share} media={it.mediaCount ?? 0} />}
        {it.kind === 'mail_unverified' && (
          <>
            <Notice kind="warn" title="Not verified, so they changed nothing.">Philobiblos could not confirm the bookshop sent them. Nothing of their content is kept.</Notice>
            <ul className="footnote" aria-label="Why">{(it.unverified?.reasons ?? []).map((r) => <li key={r.reason}>{r.reason}: {r.count}</li>)}</ul>
          </>
        )}
        {it.kind === 'mail_failed' && <Notice kind="warn" title="Philobiblos could not read this mail, so it changed nothing.">{it.mail?.reason}{it.mail?.expected ? ` (it looked like: ${it.mail.expected.replace(/_/g, ' ')})` : ''}</Notice>}
        {it.kind === 'mail_waiting' && <Notice kind="info">{it.mail?.reason}</Notice>}
        {it.share?.aiNote && <Notice kind="info">{it.share.aiNote}</Notice>}
        {it.kind === 'ai_suggestion' && <p className="footnote">The AI suggests these from your reading map. Nothing is added until you add it.</p>}
        {it.kind === 'share' && it.share?.status === 'done' && !it.found.length && !it.share.aiNote && <p className="footnote">The AI reads shares for books once it is set up; until then, add the books by hand in the Backlog.</p>}
        {it.found.length > 0 && (
          <ul className="group" role="list">
            {it.found.map((f) => <Book key={f.index} it={it} f={f} kids={kids} busy={busy} onDecide={onDecide} />)}
          </ul>
        )}
        <div className="btn-row"><button type="button" className="btn btn-sm" disabled={busy} aria-label={`Dismiss ${it.title}`} onClick={() => onDismiss(it)}>Dismiss</button></div>
      </div>
    </section>
  );
}

/** A mailed invoice that may be one typed in already (philobiblos#45): it changes nothing until it is answered. */
function TypedItem({ it, busy, onAnswer }: { it: InboxItem; busy: boolean; onAnswer: (it: InboxItem, a: 'same' | 'another') => void }) {
  const money = useMoney().format;
  const h = `in-${it.id}`;
  const typed = it.typed;
  const by = typed?.by ? ` by ${typed.by.name}` : '';
  return (
    <section className="group-block" aria-labelledby={h}>
      <div className="group-head">
        <h2 id={h} tabIndex={-1} className="wrap">{it.title}</h2>
        <span className="pill pill-neutral">{KIND[it.kind]}</span>
      </div>
      <div className="card stack">
        <p className="footnote">{[day(it.mail?.date ?? it.createdAt), it.mail?.number ? `invoice ${it.mail.number}` : null].filter(Boolean).join(' · ')}</p>
        <Notice kind="info" title="Not counted yet.">
          {`The bookshop mailed an invoice with ${typed?.part ? 'some of the books' : 'the books'} of the one typed in${by}${typed?.number ? ` (number ${typed.number})` : ''}${typed ? `, ${money(typed.totalC, 'always')}` : ''}${typed?.more ? `, and ${typed.more} more ${typed.more === 1 ? 'copy' : 'copies'}` : ''}. If it is the same purchase, ${typed?.more ? 'only the copies beyond the typed ones are added' : 'it counts once'}; if it is another purchase, its copies are added.`}
        </Notice>
        {it.found.length > 0 && (
          <ul className="footnote" aria-label="Its books">
            {it.found.map((f) => <li key={f.index}>{[f.title ?? 'A line without a title', f.qty && f.qty > 1 ? `${f.qty} copies` : null, f.priceC == null ? null : money(f.priceC, 'always')].filter(Boolean).join(' · ')}</li>)}
          </ul>
        )}
        <div className="btn-row">
          <button type="button" className="btn btn-sm btn-primary" data-first disabled={busy} onClick={() => onAnswer(it, 'same')}>The same invoice</button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onAnswer(it, 'another')}>Another purchase</button>
        </div>
      </div>
    </section>
  );
}

function ShareFacts({ s, media }: { s: NonNullable<InboxItem['share']>; media: number }) {
  const total = s.progress?.total ?? 0;
  return (
    <div className="stack">
      {s.url && <p className="wrap"><span className="muted">Link: </span><span className="mono">{s.url}</span></p>}
      {s.note && <p className="wrap">{s.note}</p>}
      <p className="footnote">{SHARE_STATUS[s.status ?? 'received']}{total ? ` · ${media} of ${total} image${total === 1 ? '' : 's'} kept${s.refused ? `, ${s.refused} refused` : ''}` : ''}</p>
    </div>
  );
}

function Book({ it, f, kids, busy, onDecide }: {
  it: InboxItem; f: Found; kids: { handle?: string | null; name: string }[]; busy: boolean;
  onDecide: (it: InboxItem, f: Found, a: 'add' | 'skip', forWho?: { handle: string; name: string }) => void;
}) {
  const money = useMoney().format;
  const name = f.title ?? 'A line without a title';
  const invoice = it.kind === 'unmatched_invoice_line';
  // A toy (no ISBN), or a row whose EAN could not be read (a position number as much as a book): skip only.
  const addable = !f.notBook && !f.eanUnreadable && Boolean(f.title);
  const facts = [f.author, f.ean ? `EAN ${f.ean}` : null, f.qty && f.qty > 1 ? `${f.qty} copies` : null, f.priceC == null ? null : money(f.priceC, 'always')].filter(Boolean).join(' · ');
  return (
    <li className="row pr-row">
      <span className="row-main">
        <span className="row-title wrap">{name}</span>
        {facts && <span className="row-sub wrap">{facts}</span>}
        {f.why && <span className="row-sub wrap">{f.why}</span>}
        <span className="pr-pills">
          {f.notBook && <span className="pill pill-orange">Not a book (no ISBN)</span>}
          {f.eanUnreadable && <span className="pill pill-orange">EAN unreadable</span>}
          {f.verdict === 'skip_off_theme' && <span className="pill">Off theme</span>}
          {f.move && <span className="pill">{f.move}</span>}
          {f.idea && <span className="pill">{f.idea}{f.layer ? `, ${f.layer}` : ''}</span>}
        </span>
      </span>
      <span className="row-trail pr-trail">
        {addable && (
          <button type="button" className="btn btn-sm btn-primary" data-first disabled={busy} aria-label={`${invoice ? 'Add to the library' : 'Add to my backlog'}: ${name}`}
            onClick={() => onDecide(it, f, 'add')}>{invoice ? 'Add to the library' : 'Add'}</button>
        )}
        {addable && !invoice && it.kind !== 'ai_suggestion' && kids.length > 0 && (
          <MenuButton label="For a kid" name={`Add ${name} for a kid`} items={kids.map((k) => ({ value: k.handle!, text: `Add for ${k.name}` }))}
            onPick={(h) => { const k = kids.find((x) => x.handle === h); if (k && !busy) onDecide(it, f, 'add', { handle: h, name: k.name }); }} />
        )}
        <button type="button" className="btn btn-sm" {...(addable ? {} : { 'data-first': true })} disabled={busy} aria-label={`Skip ${name}`} onClick={() => onDecide(it, f, 'skip')}>Skip</button>
      </span>
    </li>
  );
}
