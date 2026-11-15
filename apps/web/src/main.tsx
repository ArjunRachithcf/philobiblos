import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { paths } from '@shelf/contracts/openapi';

type Health = paths['/health']['get']['responses']['200']['content']['application/json'];

// M0: the only screen is a health page. The design (HomersLab tokens) arrives with M1.
function HealthPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setHealth, (e: Error) => setError(e.message));
  }, []);
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 480, margin: '4rem auto', padding: '0 16px' }}>
      <h1>Shelf</h1>
      {error && <p role="alert">The server did not answer: {error}</p>}
      {!error && !health && <p>Checking…</p>}
      {health && (
        <p>
          {health.ok ? 'Running' : 'Not ready'} · version {health.version} · {health.mode} mode
        </p>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><HealthPage /></StrictMode>);
