// This month, "Record a quote or an invoice" (philobiblos#27 slice 4): for a shop whose mail Philobiblos does not read, or no
// shop at all. A person types what the shop answered (its quote for the month's order) or what was bought (an invoice), or
// imports a CSV of it; Check shows what it would do (the server's dry run: which book each row names, which are new), and
// Record does it, with a verified mail's effects (copies owned, the order's lines delivered or quoted). The file is read
// in the browser as text and sent as it is; the server reads its columns and keeps none of its text. Typing only holds
// values (WCAG 3.2.2): a check shows only while it is the check of what is entered now. An invoice that may be one the
// bookshop's mail counted already is asked about before it counts (philobiblos#58): the same invoice, or another purchase.
import { useEffect, useId, useRef, useState } from 'react';
import type { components } from '@philobiblos/contracts/openapi';
import { ApiError, api, message } from '../api';
import { Choice, Notice } from '../ui';
import { amountExample, typed, unit, useMoney } from '../money';
import { CSV_MAX, TOO_LONG, decodeCsv } from '../csvfile';

type Result = components['schemas']['OrderEntryResult'];
type Recent = components['schemas']['OrderEntrySummary'];
type MaybeMailed = components['schemas']['MaybeMailed'];
type Kind = 'invoice' | 'quote';
interface Row { title: string; author: string; isbn: string; qty: string; price: string; available: boolean }
const EMPTY: Row = { title: '', author: '', isbn: '', qty: '1', price: '', available: true };
const ROWS_MAX = 100;
const OTHER = '\u0000other';


export function RecordEntry({ month, monthName, orderStatus, onRecorded }: { month: string; monthName: string; orderStatus: string | null; onRecorded: () => void }) {
  const id = useId();
  const { currency, format } = useMoney();
  const quotable = orderStatus === 'drafted' || orderStatus === 'quoted';
  const [kind, setKind] = useState<Kind>('invoice');
  const [how, setHow] = useState<'typed' | 'csv'>('typed');
  const [rows, setRows] = useState<Row[]>([{ ...EMPTY }]);
  const [csv, setCsv] = useState('');
  const [number, setNumber] = useState('');
  const [date, setDate] = useState('');
  // The invoice's shop: an enabled connector (its mail of the same number then counts once with this), another shop by
  // the household's own name for it, or none. Its number counts once for that shop.
  const [shops, setShops] = useState<{ id: string; name: string }[]>([]);
  const [shopPick, setShopPick] = useState('');
  const [shopName, setShopName] = useState('');
  useEffect(() => { api<{ shops: { id: string; name: string }[] }>('/orders/shops').then((r) => setShops(r.shops), () => setShops([])); }, []);
  const [check, setCheck] = useState<{ key: string; result: Result } | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The server's question about a mail it may be, while it is about what is entered now.
  const [ask, setAsk] = useState<{ key: string; question: string; mail: MaybeMailed } | null>(null);
  // One request at a time: a second tap on Record while the first runs would record an invoice without a number twice.
  const [busy, setBusy] = useState(false);
  const k: Kind = quotable ? kind : 'invoice';
  // The invoices recorded lately, each undone while nothing has changed it since (philobiblos#45).
  const [recent, setRecent] = useState<Recent[]>([]);
  const [said, setSaid] = useState('');
  const loadRecent = () => api<{ entries: Recent[] }>('/orders/entries').then((r) => setRecent(r.entries), () => setRecent([]));
  useEffect(() => { void loadRecent(); }, []);
  const undo = async (e: { id: string }) => {
    if (busy) return;
    setError(null); setSaid(''); setBusy(true);
    try {
      await api(`/orders/entries/${encodeURIComponent(e.id)}/undo`, { method: 'POST' });
      if (done?.id === e.id) setDone(null);
      setSaid('The invoice is undone: its copies are gone and the order is as it was.');
      onRecorded();
      await loadRecent();
    } catch (x) { setError(message(x)); } finally { setBusy(false); }
  };

  const shop = shopPick === OTHER ? shopName.trim() : shopPick;
  /** What would be sent, or what is missing. */
  const entry = (): object | string => {
    const head = { kind: k, ...(k === 'quote' ? { month } : {}), ...(k === 'invoice' && number.trim() ? { number: number.trim() } : {}), ...(k === 'invoice' && shop ? { shop } : {}), ...(k === 'invoice' && date ? { date } : {}) };
    if (how === 'csv') return !csv.trim() ? 'Choose a CSV file or paste one.' : csv.length > CSV_MAX ? TOO_LONG : { ...head, csv };
    const lines = [];
    for (const [i, r] of rows.entries()) {
      if (!r.title.trim() && !r.isbn.trim()) return `Book ${i + 1}: give its title or its ISBN.`;
      // An amount as typed (18.90 or 18,90; whole units in a currency without decimals), in hundredths (money.ts).
      const price = r.price.trim() ? typed(r.price, currency) : null;
      if (r.price.trim() && price === null && (k === 'invoice' || r.available)) return `Book ${i + 1}: enter the price as an amount, for example ${amountExample(currency)}.`;
      if ((k === 'invoice' || r.available) && price === null) return `Book ${i + 1}: enter its price.`;
      lines.push({
        ...(r.title.trim() ? { title: r.title.trim() } : {}), ...(r.author.trim() ? { author: r.author.trim() } : {}), ...(r.isbn.trim() ? { isbn: r.isbn.trim() } : {}),
        ...(k === 'invoice' ? { qty: Number(r.qty) || 1, price } : r.available ? { price } : { available: false }),
      });
    }
    return { ...head, lines };
  };
  const now = entry();
  const key = JSON.stringify(now);
  const shown = check && check.key === key ? check.result : done;

  const send = async (dryRun: boolean, mailed?: { mail: string; answer: 'same' | 'another' }) => {
    if (busy) return;
    setError(null); setDone(null); setAsk(null);
    if (typeof now === 'string') return setError(now);
    setBusy(true);
    try {
      const r = await api<Result>('/orders/entries', { method: 'POST', body: { ...now, dryRun, ...(mailed ? { mailed } : {}) } });
      if (dryRun) return setCheck({ key, result: r });
      setCheck(null); setDone(r); setSaid(''); void loadRecent();
      setRows([{ ...EMPTY }]); setCsv(''); setNumber(''); setDate(''); setShopPick(''); setShopName('');
      onRecorded();
    } catch (e) {
      setCheck(null);
      const asked = e instanceof ApiError && e.status === 409 ? (e.body as { maybeMailed?: MaybeMailed } | null)?.maybeMailed : undefined;
      if (asked) setAsk({ key, question: e instanceof Error ? e.message : '', mail: asked });
      else setError(message(e));
    } finally { setBusy(false); }
  };
  const asking = ask && ask.key === key ? ask : null;
  // The question takes the focus when it appears, so a screen reader reads it and its two answers come next.
  const askRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ask) askRef.current?.focus(); }, [ask]);
  const longDay = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const readFile = async (f: File | undefined) => {
    setError(null);
    if (!f) return;
    const r = decodeCsv(new Uint8Array(await f.arrayBuffer()));
    if ('error' in r) return setError(r.error);
    setCsv(r.text);
  };
  const copies = (r: Result) => r.lines.reduce((n, l) => n + (l.qty ?? 0), 0);

  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <div>
        <h2 className="card-title" id={`${id}-h`}>Record a quote or an invoice</h2>
        <p className="footnote">For a bookshop whose mail Philobiblos does not read, or no bookshop at all: type what the shop answered or what you bought, or import it as a CSV. Check shows what it would do before anything changes.</p>
      </div>
      {quotable
        ? <Choice label="What it is" value={k} options={[['invoice', 'An invoice'], ['quote', `The quote for ${monthName}`]]} onChange={(v) => setKind(v as Kind)} />
        : <p className="footnote">A quote can be recorded once the month’s order has gone to a bookshop (Compose).</p>}
      <Choice label="How" value={how} options={[['typed', 'Type it'], ['csv', 'Import a CSV']]} onChange={(v) => setHow(v as 'typed' | 'csv')} />
      {k === 'invoice' && (
        <div className="fields fields-2">
          <div className="field">
            <label className="field-label" htmlFor={`${id}-s`}>Shop</label>
            <select className="input" id={`${id}-s`} value={shopPick} onChange={(e) => setShopPick(e.target.value)} aria-describedby={`${id}-sh`}>
              <option value="">Not named</option>
              {shops.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              <option value={OTHER}>Another shop…</option>
            </select>
            <span className="hint" id={`${id}-sh`}>An invoice number counts once for its shop.{shops.length ? ' A bookshop Philobiblos reads the mail of: its mailed invoice with this number then counts once.' : ''}</span>
          </div>
          {shopPick === OTHER && (
            <div className="field">
              <label className="field-label" htmlFor={`${id}-so`}>The shop’s name</label>
              <input className="input" id={`${id}-so`} autoComplete="off" maxLength={80} value={shopName} onChange={(e) => setShopName(e.target.value)} />
            </div>
          )}
        </div>
      )}
      {k === 'invoice' && (
        <div className="fields fields-2">
          <div className="field">
            <label className="field-label" htmlFor={`${id}-n`}>Invoice number (optional)</label>
            <input className="input" id={`${id}-n`} autoComplete="off" maxLength={40} value={number} onChange={(e) => setNumber(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-d`}>Bought on (optional)</label>
            <input className="input" id={`${id}-d`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
      )}
      {how === 'typed' ? (
        <>
          {rows.map((r, i) => (
            <BookRow key={i} n={i + 1} kind={k} row={r} unit={unit(currency)} setRow={(x) => setRows((all) => all.map((y, j) => (j === i ? x : y)))}
              remove={rows.length > 1 ? () => setRows((all) => all.filter((_, j) => j !== i)) : undefined} />
          ))}
          <div className="btn-row"><button type="button" className="btn btn-sm" disabled={rows.length >= ROWS_MAX} onClick={() => setRows((all) => [...all, { ...EMPTY }])}>Add a book</button></div>
        </>
      ) : (
        <div className="stack">
          {/* Choosing a file only fills the text below, in this browser: nothing is sent until Check or Record. */}
          <div className="field">
            <label className="field-label" htmlFor={`${id}-f`}>A CSV file</label>
            <input className="input" id={`${id}-f`} type="file" accept=".csv,text/csv,text/plain" onInput={(e) => void readFile(e.currentTarget.files?.[0])} aria-describedby={`${id}-ch`} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-c`}>Or paste it</label>
            <textarea className="input textarea" id={`${id}-c`} spellCheck={false} value={csv} onChange={(e) => setCsv(e.target.value)} aria-describedby={`${id}-ch`} />
            <span className="hint" id={`${id}-ch`}>A header row, then a row a book. Columns: isbn, title, author, {k === 'invoice' ? 'qty, price (of a copy) and for (me or a kid’s handle)' : 'price and available (yes or no)'}; any others are left out. Prices as amounts, for example {amountExample(currency)}.</span>
          </div>
        </div>
      )}
      <div className="btn-row">
        <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => void send(true)}>Check</button>
        <button type="button" className="btn btn-primary" aria-disabled={busy || undefined} onClick={() => void send(false)}>Record {k === 'invoice' ? 'the invoice' : 'the quote'}</button>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {asking && (
        <div className="stack" role="group" aria-label={asking.question} tabIndex={-1} ref={askRef}>
          <Notice kind="info" title={asking.question}>
            {`The bookshop’s invoice${asking.mail.number ? ` ${asking.mail.number}` : ''} came by mail and counts already, with the same books for ${format(asking.mail.total, 'always')}. The same invoice records nothing new; another purchase records these copies too.`}
          </Notice>
          <div className="btn-row">
            <button type="button" className="btn btn-primary" aria-disabled={busy || undefined} onClick={() => void send(false, { mail: asking.mail.mail, answer: 'same' })}>The same invoice</button>
            <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => void send(false, { mail: asking.mail.mail, answer: 'another' })}>Another purchase</button>
          </div>
        </div>
      )}
      <div role="status">{said && <Notice kind="ok">{said}</Notice>}</div>
      <div className="stack" role="status">
        {shown && (
          <>
            <Notice kind={shown.dryRun ? 'info' : 'ok'} title={shown.dryRun ? 'Nothing is recorded yet.' : 'Recorded.'}>
              {shown.sameAsMail
                ? `The same invoice as the one that came by mail on ${longDay(shown.sameAsMail.cameOn)}: nothing new is counted.`
                : shown.kind === 'invoice'
                ? `${copies(shown)} ${copies(shown) === 1 ? 'copy' : 'copies'} for ${format(shown.total, 'always')} ${shown.dryRun ? 'would be' : 'are'} in the library.`
                : `The ${monthName} order ${shown.dryRun ? 'would come' : 'comes'} to ${format(shown.total, 'always')}.`}
              {shown.ignoredColumns.length > 0 && ` Left out: the columns ${shown.ignoredColumns.join(', ')}.`}
              {shown.dryRun && shown.maybeMailed && ` It may be the invoice that came by mail on ${longDay(shown.maybeMailed.cameOn)}: Record asks first.`}
            </Notice>
            <ul className="footnote">
              {shown.lines.map((l) => (
                <li key={l.row}>Row {l.row}: {l.title}{l.authors.length ? `, ${l.authors.join(', ')}` : ''}{l.new ? ' (a new book)' : ''}{l.available ? (l.price != null ? `, ${format(l.price, 'always')}` : '') : ', cannot be delivered'}</li>
              ))}
            </ul>
            {!shown.dryRun && shown.kind === 'invoice' && shown.id && recent.some((x) => x.id === shown.id && x.canUndo) && (
              <div className="btn-row"><button type="button" className="btn btn-sm" aria-disabled={busy || undefined} onClick={() => void undo({ id: shown.id! })}>Undo this invoice</button></div>
            )}
          </>
        )}
      </div>
      {recent.length > 0 && (
        <div className="stack">
          <h3 className="field-label">Invoices recorded in the last 7 days</h3>
          <ul className="group" role="list">
            {recent.map((x) => (
              <li key={x.id} className="row">
                <span className="row-main">
                  <span className="row-title wrap">{[new Date(x.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), x.number ? `invoice ${x.number}` : 'no number', x.shop].filter(Boolean).join(' · ')}</span>
                  <span className="row-sub wrap">{`${x.sameAsMail ? 'the invoice that came by mail' : `${x.copies} ${x.copies === 1 ? 'copy' : 'copies'}`}, ${format(x.total, 'always')}${x.by ? `, by ${x.by.name}` : ''}`}</span>
                </span>
                {x.canUndo && <span className="row-trail"><button type="button" className="btn btn-sm" aria-disabled={busy || undefined} aria-label={`Undo the invoice of ${new Date(x.createdAt).toLocaleDateString('en-GB')}${x.number ? `, ${x.number}` : ''}`} onClick={() => void undo(x)}>Undo</button></span>}
              </li>
            ))}
          </ul>
          <p className="footnote">An invoice is undone (its copies removed, the order as it was) by whoever recorded it, or an admin, while nothing has changed it since.</p>
        </div>
      )}
    </section>
  );
}

/** One book's fields; `setRow` takes the whole row. */
function BookRow({ n, kind, row, unit: u, setRow, remove }: { n: number; kind: Kind; row: Row; unit: string; setRow: (r: Row) => void; remove?: () => void }) {
  const id = useId();
  const setTitle = (v: string) => setRow({ ...row, title: v });
  const setAuthor = (v: string) => setRow({ ...row, author: v });
  const setIsbn = (v: string) => setRow({ ...row, isbn: v });
  const setQty = (v: string) => setRow({ ...row, qty: v });
  const setPrice = (v: string) => setRow({ ...row, price: v });
  const off = kind === 'quote' && !row.available;
  return (
    <fieldset className="stack re-book">
      <legend className="field-label">Book {n}</legend>
      <div className="fields fields-2">
        <div className="field"><label className="field-label" htmlFor={`${id}-t`}>Title</label><input className="input" id={`${id}-t`} maxLength={300} value={row.title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="field"><label className="field-label" htmlFor={`${id}-a`}>Author</label><input className="input" id={`${id}-a`} maxLength={200} value={row.author} onChange={(e) => setAuthor(e.target.value)} /></div>
      </div>
      <div className="fields fields-2">
        <div className="field"><label className="field-label" htmlFor={`${id}-i`}>ISBN</label><input className="input" id={`${id}-i`} inputMode="numeric" autoComplete="off" maxLength={20} value={row.isbn} onChange={(e) => setIsbn(e.target.value)} /></div>
        {kind === 'invoice' && <div className="field"><label className="field-label" htmlFor={`${id}-q`}>Copies</label><input className="input" id={`${id}-q`} inputMode="numeric" maxLength={2} value={row.qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, '').slice(0, 2))} /></div>}
        <div className="field"><label className="field-label" htmlFor={`${id}-p`}>{kind === 'invoice' ? 'Price of a copy' : 'Price'} ({u})</label><input className="input" id={`${id}-p`} inputMode="decimal" disabled={off} value={off ? '' : row.price} onChange={(e) => setPrice(e.target.value)} /></div>
      </div>
      {kind === 'quote' && <label className="re-check"><input type="checkbox" checked={!row.available} onChange={(e) => setRow({ ...row, available: !e.target.checked })} /> The shop cannot deliver it</label>}
      {remove && <div className="btn-row"><button type="button" className="btn btn-sm" onClick={remove}>Remove book {n}</button></div>}
    </fieldset>
  );
}
