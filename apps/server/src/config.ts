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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.SHELF_MODE ?? 'standalone';
  if (mode !== 'homerslab' && mode !== 'standalone') throw new Error(`SHELF_MODE must be homerslab or standalone, not ${mode}`);
  const dataDir = resolve(env.SHELF_DATA_DIR ?? './data');
  return {
    mode,
    dataDir,
    dbFile: env.SHELF_DB_FILE ?? join(dataDir, 'shelf.sqlite'),
    // Standalone binds to localhost unless told otherwise (ADR 0009); the container sets SHELF_HOST=0.0.0.0 and
    // publishes the port on 127.0.0.1 only.
    host: env.SHELF_HOST ?? '127.0.0.1',
    port: Number(env.SHELF_PORT ?? 8080),
    timezone: env.SHELF_TZ ?? 'Europe/Zurich',
    trustedProxy: env.SHELF_TRUSTED_PROXY || null,
    webDir: env.SHELF_WEB_DIR ?? null,
  };
}
