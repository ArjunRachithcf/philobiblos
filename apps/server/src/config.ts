// Settings from the environment (contracts/homerslab-app.yaml, docker-compose.yml). Secrets are read here and
// nowhere else, and never logged.
import { join, resolve } from 'node:path';

export type Mode = 'homerslab' | 'standalone';

export interface Config {
  mode: Mode;
  dataDir: string;
  dbFile: string;
  host: string;
  port: number;
  timezone: string;
  /** homerslab: the only address whose X-HomersLab-Person header is trusted. */
  trustedProxy: string | null;
  webDir: string | null;
  /** The address people open (scheme, host, port): WebAuthn's origin and relying party, and the Origin requests must carry. */
  origin: string;
  rpId: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.SHELF_MODE ?? 'standalone';
  if (mode !== 'homerslab' && mode !== 'standalone') throw new Error(`SHELF_MODE must be homerslab or standalone, not ${mode}`);
  const dataDir = resolve(env.SHELF_DATA_DIR ?? './data');
  const port = Number(env.SHELF_PORT ?? 8080);
  // Under HomersLab the address is HomersLab's to give; a guess would make every passkey and Origin check wrong.
  if (mode === 'homerslab' && !env.SHELF_ORIGIN) throw new Error('SHELF_ORIGIN must be set in homerslab mode');
  const origin = parseOrigin(env.SHELF_ORIGIN ?? `http://localhost:${port}`);
  return {
    mode,
    dataDir,
    dbFile: env.SHELF_DB_FILE ?? join(dataDir, 'shelf.sqlite'),
    // Standalone binds to localhost unless told otherwise (ADR 0009); the container sets SHELF_HOST=0.0.0.0 and
    // publishes the port on 127.0.0.1 only.
    host: env.SHELF_HOST ?? '127.0.0.1',
    port,
    timezone: env.SHELF_TZ ?? 'Europe/Zurich',
    trustedProxy: env.SHELF_TRUSTED_PROXY || null,
    webDir: env.SHELF_WEB_DIR ?? null,
    origin: origin.origin,
    rpId: origin.hostname,
  };
}

function parseOrigin(v: string): URL {
  const u = new URL(v);
  if (u.pathname !== '/' || u.search || u.hash || u.username) throw new Error(`SHELF_ORIGIN must be scheme://host[:port], not ${v}`);
  // WebAuthn needs a secure context: https, or http only on localhost.
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) {
    throw new Error(`SHELF_ORIGIN must be https (or http://localhost), not ${v}`);
  }
  return u;
}
