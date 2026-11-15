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
  /**
   * Where the key that seals the delivery address and the bookshop's address comes from (never the database):
   * SHELF_SEALING_KEY (base64, 32 bytes) or SHELF_SEALING_KEY_FILE; standalone falls back to a file it makes in the
   * data folder, next to the database but not in it. null: nothing can be sealed (homerslab mode without the secret).
   */
  sealingKey: { value: string } | { file: string; create: boolean } | null;
}

/**
 * What HomersLab's edge must promise before Shelf trusts its identity headers (HomersLab #236): it deletes every
 * X-HomersLab-* header a client sends and sets X-HomersLab-Person, -Name and -Role itself. HomersLab sets
 * SHELF_EDGE_IDENTITY to this value once its edge does that; until then homerslab mode does not start.
 */
export const EDGE_IDENTITY = 'homerslab-v1';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.SHELF_MODE ?? 'standalone';
  if (mode !== 'homerslab' && mode !== 'standalone') throw new Error(`SHELF_MODE must be homerslab or standalone, not ${mode}`);
  const dataDir = resolve(env.SHELF_DATA_DIR ?? './data');
  const port = Number(env.SHELF_PORT ?? 8080);
  // Under HomersLab the address is HomersLab's to give; a guess would make every passkey and Origin check wrong.
  if (mode === 'homerslab' && !env.SHELF_ORIGIN) throw new Error('SHELF_ORIGIN must be set in homerslab mode');
  if (mode === 'homerslab' && env.SHELF_EDGE_IDENTITY !== EDGE_IDENTITY) {
    throw new Error(`homerslab mode needs an edge that strips and sets the X-HomersLab-* headers (HomersLab #236): SHELF_EDGE_IDENTITY=${EDGE_IDENTITY}`);
  }
  if (mode === 'homerslab' && !env.SHELF_TRUSTED_PROXY) throw new Error('SHELF_TRUSTED_PROXY must be set in homerslab mode');
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
    sealingKey: env.SHELF_SEALING_KEY ? { value: env.SHELF_SEALING_KEY }
      : env.SHELF_SEALING_KEY_FILE ? { file: env.SHELF_SEALING_KEY_FILE, create: false }
      : mode === 'standalone' ? { file: join(dataDir, 'sealing.key'), create: true } : null,
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
