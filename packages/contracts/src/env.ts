// The environment, read under the app's name (philobiblos#30). The app was called Shelf; its settings were SHELF_*.
// For one release (every 0.1.x; gone in 0.2.0, test/env.test.ts holds that date) a SHELF_* name is still read as its
// PHILOBIBLOS_* name, with one warning per process that names the old variables (never their values: some are secrets).
// When both are set, the PHILOBIBLOS_* one wins and the warning says the old one was ignored.
//
// The image's own defaults (the folders, the address it listens on) are applied here, after the old names, and not
// with the Dockerfile's ENV: an ENV PHILOBIBLOS_DATA_DIR would win over a household's SHELF_DATA_DIR and open an empty
// database somewhere else, and data must never move silently.

export const ENV_PREFIX = 'PHILOBIBLOS_';
export const LEGACY_ENV_PREFIX = 'SHELF_';
/** The last version that still reads SHELF_* (and the shelf_session cookie, and the `shelf` command in the image). */
export const LEGACY_NAMES_UNTIL = '0.1';

/** Set by the Dockerfile only: the image's defaults below apply. */
export const IN_IMAGE = 'PHILOBIBLOS_IN_IMAGE';
export const IMAGE_DEFAULTS: Readonly<Record<string, string>> = {
  PHILOBIBLOS_HOST: '0.0.0.0',
  PHILOBIBLOS_PORT: '8080',
  PHILOBIBLOS_DATA_DIR: '/data',
  PHILOBIBLOS_KEYS_DIR: '/keys',
  PHILOBIBLOS_WORK_DIR: '/work',
  PHILOBIBLOS_WEB_DIR: '/app/web',
  PHILOBIBLOS_MIGRATIONS_DIR: '/app/drizzle',
};

type Env = Record<string, string | undefined>;
type Warn = (message: string) => void;

let warned = false;
const defaultWarn: Warn = (m) => process.emitWarning(m, { type: 'DeprecationWarning', code: 'PHILOBIBLOS_LEGACY_ENV' });

/**
 * A copy of `env` in which every SHELF_X is also PHILOBIBLOS_X (unless that is set), then the image's defaults for what
 * is still unset. The first call in a process that sees a SHELF_* name warns once; `warn` is for tests.
 */
export function resolveEnv(env: Env = process.env, warn: Warn = defaultWarn): Env {
  const out: Env = { ...env };
  const read: string[] = [], ignored: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(LEGACY_ENV_PREFIX) || v === undefined) continue;
    const name = ENV_PREFIX + k.slice(LEGACY_ENV_PREFIX.length);
    if (env[name] === undefined) { out[name] = v; read.push(k); } else ignored.push(k);
  }
  if (env[IN_IMAGE] === '1') for (const [k, v] of Object.entries(IMAGE_DEFAULTS)) if (out[k] === undefined) out[k] = v;
  if ((read.length || ignored.length) && !warned) {
    warned = true;
    const parts = [
      read.length ? `read ${read.sort().join(', ')} as ${read.map((k) => ENV_PREFIX + k.slice(LEGACY_ENV_PREFIX.length)).join(', ')}` : '',
      ignored.length ? `ignored ${ignored.sort().join(', ')} (the ${ENV_PREFIX}* name is set too, and wins)` : '',
    ].filter(Boolean);
    warn(`Shelf is now Philobiblos: rename the SHELF_* settings to PHILOBIBLOS_* (${parts.join('; ')}). SHELF_* is read until version ${LEGACY_NAMES_UNTIL}.x only.`);
  }
  return out;
}

/** For tests: the next call warns again. */
export function resetLegacyEnvWarning(): void {
  warned = false;
}
