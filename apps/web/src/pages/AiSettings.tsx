// Settings, "The AI" (contracts/ai-plugin.md): which provider reads books and shares, and what leaves the server with it.
// Ollama runs on the household's own machine and nothing leaves. Claude is an opt-in: the list of what would go to
// Anthropic is shown first, and the admin ticks that they read it in the same step that turns it on. The API key is
// write-only: typed here, sealed on the server, never shown again.
import { useEffect, useId, useState } from 'react';
import { api, message, type Settings as S } from '../api';
import { Notice } from '../ui';

type Ai = NonNullable<S['ai']>;
type Provider = 'claude' | 'ollama' | 'none';

export function AiSettings({ admin }: { admin: boolean }) {
  const id = useId();
  const [ai, setAi] = useState<Ai | null>(null);
  const [provider, setProvider] = useState<Provider>('ollama');
  const [model, setModel] = useState('');
  const [vision, setVision] = useState('');
  const [key, setKey] = useState('');
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState('');
  const load = () => api<S>('/settings').then((s) => {
    const a = s.ai ?? {};
    setAi(a); setProvider(a.provider ?? 'ollama'); setModel(a.model ?? ''); setVision(a.visionModel ?? ''); setAccept(false);
  }, (e) => setError(message(e)));
  useEffect(() => { void load(); }, []);
  // A new choice of provider asks again: the tick is for the list shown with it.
  useEffect(() => { setAccept(false); }, [provider]);

  // Turning Claude on, or Claude on with a list an admin has not accepted as it is now (a newer Shelf sends more).
  const optingIn = provider === 'claude' && (ai?.provider !== 'claude' || ai?.leavesAccepted !== true);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setOk('');
    if (optingIn && !accept) return setError('Tick that you read what goes to Anthropic first.');
    const body: Record<string, unknown> = { provider, model: model.trim() || undefined, visionModel: vision.trim() || null };
    if (key.trim()) body.claudeApiKey = key.trim();
    if (optingIn) body.acceptLeaves = true;
    try {
      await api('/settings', { method: 'PATCH', body: { ai: body } });
      setKey('');
      setOk(provider === 'claude' ? 'Saved. The key is sealed on the server and not shown again.' : 'Saved.');
      await load();
    } catch (err) { setError(message(err)); }
  };
  const forget = async () => {
    setError(null); setOk('');
    try { await api('/settings', { method: 'PATCH', body: { ai: { claudeApiKey: null } } }); setOk('The key is removed.'); await load(); } catch (err) { setError(message(err)); }
  };

  const list = (items: string[] | undefined) => <ul className="footnote">{(items ?? []).map((l) => <li key={l}>{l}</li>)}</ul>;
  return (
    <section className="card stack" aria-labelledby={`${id}-h`}>
      <div>
        <h2 className="card-title" id={`${id}-h`}>The AI</h2>
        <p className="footnote">It reads shared posts, tags books with ideas, proposes links and suggests what to read next. It proposes; Shelf’s own rules pick, and you confirm.</p>
      </div>
      {!ai ? (error ? <Notice kind="error">{error}</Notice> : <p className="sr-only" role="status">Loading</p>) : (
        <>
          {ai.provider === 'claude'
            ? ai.leavesAccepted
              ? <Notice kind="info" title="Claude is on. This leaves the server:">{list(ai.leaves)}</Notice>
              : <Notice kind="warn" title="Claude is paused.">What goes to Anthropic changed since an admin accepted it. Nothing is sent until an admin reads the list again and accepts it.</Notice>
            : ai.provider === 'ollama'
              ? <p>Ollama{ai.ollamaUrl ? <> at <b>{ai.ollamaUrl}</b></> : ''}: nothing leaves your home network.{!ai.ollamaConfigured && ' It is not set up on the server yet (OLLAMA_URL).'}</p>
              : <p>The AI is off.</p>}
          {admin ? (
            <form className="stack" onSubmit={save} noValidate>
              <div className="field">
                <label className="field-label" htmlFor={`${id}-p`}>Provider</label>
                <select className="input select" id={`${id}-p`} value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
                  <option value="ollama">Ollama, on your own machine (nothing leaves)</option>
                  <option value="claude">Claude, by Anthropic (an API key; data leaves)</option>
                  <option value="none">Off</option>
                </select>
              </div>
              {provider === 'ollama' && (
                <div className="fields fields-2">
                  <div className="field">
                    <label className="field-label" htmlFor={`${id}-m`}>Text model</label>
                    <input className="input" id={`${id}-m`} autoComplete="off" value={model} onChange={(e) => setModel(e.target.value)} />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor={`${id}-v`}>Vision model (for shared images)</label>
                    <input className="input" id={`${id}-v`} autoComplete="off" value={vision} onChange={(e) => setVision(e.target.value)} aria-describedby={`${id}-vh`} />
                    <span className="hint" id={`${id}-vh`}>Without one, shares are read by their captions only.</span>
                  </div>
                </div>
              )}
              {provider === 'claude' && (
                <>
                  {optingIn && (
                    <Notice kind="warn" title="With Claude, this goes to Anthropic:">
                      {list(ai.leavesWithClaude)}
                      <label className="row"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /> I read this, and I turn Claude on for the household.</label>
                    </Notice>
                  )}
                  <div className="field">
                    <label className="field-label" htmlFor={`${id}-k`}>Anthropic API key{ai.hasClaudeKey ? ' (saved; type a new one to replace it)' : ''}</label>
                    <input className="input" id={`${id}-k`} type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} aria-describedby={`${id}-kh`} />
                    <span className="hint" id={`${id}-kh`}>Sealed on the server and never shown again.</span>
                  </div>
                </>
              )}
              {error && <Notice kind="error">{error}</Notice>}
              {ok && <Notice kind="ok">{ok}</Notice>}
              <div className="btn-row">
                <button type="submit" className="btn btn-primary">Save the AI settings</button>
                {ai.hasClaudeKey && <button type="button" className="btn" onClick={() => void forget()}>Remove the Claude key</button>}
              </div>
            </form>
          ) : <p className="footnote">An admin of the household changes it.</p>}
        </>
      )}
    </section>
  );
}
