// Settings, "Bookshops" (philobiblos#27): the bookshop connectors and what each allows. A connector is a file of data
// (connectors/<id>/connector.yaml); it counts for nothing until an admin reads what it allows here and enables it, with a
// sign-in of the last few minutes. Enabling names the version this page showed, so a file that changed since is refused.
// When the server says an admin cannot enable one now (enableBlocked: the household's currency, or HomersLab's missing
// recent sign-in), the button stays, focusable and aria-disabled (a tap does nothing), with the reason it is described by.
import { useEffect, useId, useState } from 'react';
import { api, message, type Connector } from '../api';
import { Notice } from '../ui';
import { useMoney } from '../money';

export function Bookshops({ admin }: { admin: boolean }) {
  const id = useId();
  const [list, setList] = useState<Connector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState('');
  const load = () => api<{ connectors: Connector[] }>('/connectors').then((r) => setList(r.connectors), (e) => setError(message(e)));
  // Read again when the household's currency changes (Settings, above): what stands in a connector's way changes with it.
  const { currency } = useMoney();
  useEffect(() => { if (admin) void load(); }, [admin, currency]);

  const set = async (c: Connector, enabled: boolean) => {
    setError(null); setOk('');
    try {
      await api(`/connectors/${encodeURIComponent(c.id)}`, { method: 'PUT', body: enabled ? { enabled, acceptVersion: c.version } : { enabled } });
      setOk(enabled ? `${c.name} is enabled.` : `${c.name} is turned off: its mail and prices count no more.`);
      await load();
    } catch (err) { setError(message(err)); }
  };

  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <div>
        <h2 className="card-title" id={`${id}-h`}>Bookshops</h2>
        <p className="footnote">Each bookshop is a connector: which addresses its mail comes from, how its mails read, and where its prices are. None counts until an admin enables it here.</p>
      </div>
      {!admin ? <p className="footnote">An admin of the household chooses the bookshops.</p>
        : !list ? (error ? <Notice kind="error">{error}</Notice> : <p className="sr-only" role="status">Loading</p>) : (
          <>
            {!list.length && <p>No connectors are installed.</p>}
            {list.map((c) => (
              <div key={`${c.origin}-${c.id}`} className="stack">
                <h3 className="field-label">{c.name}{c.origin === 'local' ? ' (this household’s own)' : ''}</h3>
                {c.problem && <Notice kind="warn" title="This connector cannot be used.">{c.problem}</Notice>}
                {c.changed && <Notice kind="warn" title="Its file changed since it was enabled.">It allows nothing until an admin reads what it allows and enables it again.</Notice>}
                {c.allows && (
                  <ul className="footnote">
                    <li>Mail counts only from {c.allows.mailFrom.join(', ') || 'nowhere'}, signed by {c.allows.signedBy.join(', ') || 'nobody'}.</li>
                    {c.allows.quoteSenders.length > 0 && <li>Quotes and confirmations from {c.allows.quoteSenders.join(', ')}.</li>}
                    <li>{c.allows.priceHost ? <>Prices are looked up at {c.allows.priceHost} with {c.allows.priceAsks === 'isbn' ? 'a book’s ISBN (only books with one)' : 'a book’s title and first author'}.</> : 'No price lookup.'}</li>
                    {c.allows.orderTo && <li>Compose writes to {c.allows.orderTo} unless Where orders go names another address.</li>}
                    {c.allows.markup && <li>The order and invoice markup in its signed mail counts: an invoice there adds its books to the library.</li>}
                    {c.currency && <li>Amounts in {c.currency}.</li>}
                  </ul>
                )}
                <div className="btn-row">
                  {c.enabled
                    ? <button type="button" className="btn" onClick={() => void set(c, false)}>Turn {c.name} off</button>
                    : c.usable && <button type="button" className="btn btn-primary" aria-disabled={c.enableBlocked ? true : undefined} aria-describedby={c.enableBlocked ? `${id}-${c.id}-why` : undefined} onClick={() => { if (!c.enableBlocked) void set(c, true); }}>Enable {c.name}</button>}
                </div>
                {!c.enabled && c.usable && c.enableBlocked && <p className="footnote" id={`${id}-${c.id}-why`}>It cannot be enabled now; {c.enableBlocked}.</p>}
              </div>
            ))}
            {error && <Notice kind="error">{error === 'sign in again to do this' ? 'Sign in again to enable a bookshop: it needs a sign-in of the last few minutes.' : error}</Notice>}
            {ok && <Notice kind="ok">{ok}</Notice>}
          </>
        )}
    </section>
  );
}
