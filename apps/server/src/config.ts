// Settings from the environment (contracts/homerslab-app.yaml, docker-compose.yml). Secrets are read here and
// nowhere else, and never logged.
import { join, resolve } from 'node:path';
import { resolveEnv } from '@philobiblos/contracts/env';
import { DEFAULT_PUSH_HOSTS, PUSH_HOST_ENTRY, wildcardTooBroad } from './push/hosts';
import { validTimeZone } from './jobs/zone';

export type Mode = 'homerslab' | 'standalone';

export interface Config {
  mode: Mode;
  dataDir: string;
  dbFile: string;
  host: string;
  port: number;
  /** PHILOBIBLOS_TZ: only the zone the household starts with (its settings row, made at the first start); never read after. */
  timezone: string;
  /** homerslab: the only address whose X-HomersLab-Person header is trusted. */
  trustedProxy: string | null;
  webDir: string | null;
  /** The address people open (scheme, host, port): WebAuthn's origin and relying party, and the Origin requests must carry. */
  origin: string;
  rpId: string;
  /**
   * Where the key that seals the delivery address and the bookshop's address comes from (never the database):
   * PHILOBIBLOS_SEALING_KEY (base64, 32 bytes) or PHILOBIBLOS_SEALING_KEY_FILE; standalone falls back to a file it makes in
   * PHILOBIBLOS_KEYS_DIR (default ./keys; /keys in the image): its own folder, never the data folder a backup copies.
   * null: nothing can be sealed (homerslab mode without the secret).
   */
  sealingKey: { value: string } | { file: string; create: boolean } | null;
  /** The folder shared with the media worker (ADR 0009); null: no worker, media jobs are unavailable. */
  workDir: string | null;
  /** false: nothing leaves the server (PHILOBIBLOS_EGRESS=off); prices and metadata then stay as they are. */
  egress: boolean;
  /** The household's Ollama (OLLAMA_URL), the one AI host Philobiblos may reach without an opt-in; from the environment only. */
  ollamaUrl: string | null;
  /**
   * The Philobiblos-only mailbox (ADR 0007): IMAP over TLS on 993, read-only. The password is a secret from the environment
   * (PHILOBIBLOS_IMAP_PASSWORD or PHILOBIBLOS_IMAP_PASSWORD_FILE), never in the database, the API or a log. null: not set up.
   */
  imap: { host: string; user: string; password: { value: string } | { file: string }; folder: string } | null;
  /** Mail providers whose ARC seal Philobiblos trusts for a forward that broke the bookshop's DKIM (PHILOBIBLOS_MAIL_ARC_SEALERS). */
  arcSealers: string[];
  /**
   * The push services a device's subscription may name (PHILOBIBLOS_PUSH_HOSTS, comma-separated host names or `*.domain`;
   * default the browsers' own, push/push.ts DEFAULT_PUSH_HOSTS). Every send still goes to public addresses over https only.
   */
  pushHosts: string[];
  /** The household's addresses the bookshop writes to (PHILOBIBLOS_MAIL_RECIPIENTS); a mail to anyone else is not taken. */
  mailRecipients: string[];
}

/**
 * What HomersLab's edge must promise before Philobiblos trusts its identity headers (HomersLab #236): it deletes every
 * X-HomersLab-* header a client sends and sets X-HomersLab-Person, -Name and -Role itself. HomersLab sets
 * PHILOBIBLOS_EDGE_IDENTITY to this value once its edge does that; until then homerslab mode does not start.
 */
export const EDGE_IDENTITY = 'homerslab-v1';

export function loadConfig(given: NodeJS.ProcessEnv = process.env): Config {
  // SHELF_* is still read for one release, and the image's defaults apply here (packages/contracts/src/env.ts).
  const env = resolveEnv(given);
  const mode = env.PHILOBIBLOS_MODE ?? 'standalone';
  if (mode !== 'homerslab' && mode !== 'standalone') throw new Error(`PHILOBIBLOS_MODE must be homerslab or standalone, not ${mode}`);
  // Empty is a mistake, never a place: resolve('') is the working folder, and better-sqlite3 opens '' in memory.
  for (const k of ['PHILOBIBLOS_DATA_DIR', 'PHILOBIBLOS_DB_FILE', 'PHILOBIBLOS_KEYS_DIR']) if (env[k] === '') throw new Error(`${k} is set but empty: leave it out, or name the folder or file`);
  const dataDir = resolve(env.PHILOBIBLOS_DATA_DIR ?? './data');
  const port = Number(env.PHILOBIBLOS_PORT ?? 8080);
  // Under HomersLab the address is HomersLab's to give; a guess would make every passkey and Origin check wrong.
  if (mode === 'homerslab' && !env.PHILOBIBLOS_ORIGIN) throw new Error('PHILOBIBLOS_ORIGIN must be set in homerslab mode');
  if (mode === 'homerslab' && env.PHILOBIBLOS_EDGE_IDENTITY !== EDGE_IDENTITY) {
    throw new Error(`homerslab mode needs an edge that strips and sets the X-HomersLab-* headers (HomersLab #236): PHILOBIBLOS_EDGE_IDENTITY=${EDGE_IDENTITY}`);
  }
  if (mode === 'homerslab' && !env.PHILOBIBLOS_TRUSTED_PROXY) throw new Error('PHILOBIBLOS_TRUSTED_PROXY must be set in homerslab mode');
  const origin = parseOrigin(env.PHILOBIBLOS_ORIGIN ?? `http://localhost:${port}`);
  return {
    mode,
    dataDir,
    dbFile: env.PHILOBIBLOS_DB_FILE ?? join(dataDir, 'shelf.sqlite'),
    // Standalone binds to localhost unless told otherwise (ADR 0009); the container sets PHILOBIBLOS_HOST=0.0.0.0 and
    // publishes the port on 127.0.0.1 only.
    host: env.PHILOBIBLOS_HOST ?? '127.0.0.1',
    port,
    timezone: parseTimeZone(env.PHILOBIBLOS_TZ),
    trustedProxy: env.PHILOBIBLOS_TRUSTED_PROXY || null,
    webDir: env.PHILOBIBLOS_WEB_DIR ?? null,
    origin: origin.origin,
    rpId: origin.hostname,
    sealingKey: env.PHILOBIBLOS_SEALING_KEY ? { value: env.PHILOBIBLOS_SEALING_KEY }
      : env.PHILOBIBLOS_SEALING_KEY_FILE ? { file: env.PHILOBIBLOS_SEALING_KEY_FILE, create: false }
      : mode === 'standalone' ? { file: join(resolve(env.PHILOBIBLOS_KEYS_DIR ?? './keys'), 'sealing.key'), create: true } : null,
    workDir: env.PHILOBIBLOS_WORK_DIR ? resolve(env.PHILOBIBLOS_WORK_DIR) : null,
    egress: env.PHILOBIBLOS_EGRESS !== 'off',
    ollamaUrl: env.OLLAMA_URL ? parseOllama(env.OLLAMA_URL) : null,
    imap: env.PHILOBIBLOS_IMAP_HOST && env.PHILOBIBLOS_IMAP_USER && (env.PHILOBIBLOS_IMAP_PASSWORD || env.PHILOBIBLOS_IMAP_PASSWORD_FILE) ? {
      host: parseHost(env.PHILOBIBLOS_IMAP_HOST),
      user: env.PHILOBIBLOS_IMAP_USER,
      password: env.PHILOBIBLOS_IMAP_PASSWORD ? { value: env.PHILOBIBLOS_IMAP_PASSWORD } : { file: env.PHILOBIBLOS_IMAP_PASSWORD_FILE! },
      folder: env.PHILOBIBLOS_IMAP_FOLDER || 'INBOX',
    } : null,
    mailRecipients: (env.PHILOBIBLOS_MAIL_RECIPIENTS ?? '').split(',').map((d) => d.trim().toLowerCase()).filter((d) => /^[^@\s]+@[^@\s]+$/.test(d)),
    pushHosts: parsePushHosts(env.PHILOBIBLOS_PUSH_HOSTS),
    arcSealers: (env.PHILOBIBLOS_MAIL_ARC_SEALERS ?? 'google.com').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
  };
}

/** PHILOBIBLOS_TZ: the household's zone at the first start only (jobs/schedule.ts initHousehold); Settings has it after. */
function parseTimeZone(v: string | undefined): string {
  if (v === undefined || !v.trim()) return 'Europe/Zurich';
  const tz = v.trim();
  if (!validTimeZone(tz)) throw new Error(`PHILOBIBLOS_TZ: a time zone such as Europe/Zurich, not ${v.trim().slice(0, 80)}`);
  return tz;
}

function parsePushHosts(v: string | undefined): string[] {
  if (v === undefined || !v.trim()) return [...DEFAULT_PUSH_HOSTS];
  const hosts = v.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  for (const h of hosts) if (!PUSH_HOST_ENTRY.test(h) || wildcardTooBroad(h)) throw new Error(`PHILOBIBLOS_PUSH_HOSTS: host names or *.domain (at least three labels after *.), comma-separated, not ${h.slice(0, 80)}`);
  return hosts;
}

function parseOrigin(v: string): URL {
  const u = new URL(v);
  if (u.pathname !== '/' || u.search || u.hash || u.username) throw new Error(`PHILOBIBLOS_ORIGIN must be scheme://host[:port], not ${v}`);
  // WebAuthn needs a secure context: https, or http only on localhost.
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) {
    throw new Error(`PHILOBIBLOS_ORIGIN must be https (or http://localhost), not ${v}`);
  }
  return u;
}

function parseOllama(v: string): string {
  const u = new URL(v);
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) throw new Error(`OLLAMA_URL must be http(s)://host[:port] without credentials`);
  return u.origin;
}

/** A host name only (no scheme, port or path): the IMAP port is always 993. */
function parseHost(v: string): string {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(v)) throw new Error('PHILOBIBLOS_IMAP_HOST must be a host name, e.g. imap.gmail.com (the port is always 993)');
  return v.toLowerCase();
}
