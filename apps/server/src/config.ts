// Settings from the environment (contracts/homerslab-app.yaml, docker-compose.yml). Secrets are read here and
// nowhere else, and never logged.
import { join, resolve } from 'node:path';
import { DEFAULT_PUSH_HOSTS, PUSH_HOST_ENTRY } from './push/hosts';

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
   * SHELF_SEALING_KEY (base64, 32 bytes) or SHELF_SEALING_KEY_FILE; standalone falls back to a file it makes in
   * SHELF_KEYS_DIR (default ./keys; /keys in the image): its own folder, never the data folder a backup copies.
   * null: nothing can be sealed (homerslab mode without the secret).
   */
  sealingKey: { value: string } | { file: string; create: boolean } | null;
  /** The folder shared with the media worker (ADR 0009); null: no worker, media jobs are unavailable. */
  workDir: string | null;
  /** false: nothing leaves the server (SHELF_EGRESS=off); prices and metadata then stay as they are. */
  egress: boolean;
  /** The household's Ollama (OLLAMA_URL), the one AI host Shelf may reach without an opt-in; from the environment only. */
  ollamaUrl: string | null;
  /**
   * The Shelf-only mailbox (ADR 0007): IMAP over TLS on 993, read-only. The password is a secret from the environment
   * (SHELF_IMAP_PASSWORD or SHELF_IMAP_PASSWORD_FILE), never in the database, the API or a log. null: not set up.
   */
  imap: { host: string; user: string; password: { value: string } | { file: string }; folder: string } | null;
  /** Mail providers whose ARC seal Shelf trusts for a forward that broke the bookshop's DKIM (SHELF_MAIL_ARC_SEALERS). */
  arcSealers: string[];
  /**
   * The push services a device's subscription may name (SHELF_PUSH_HOSTS, comma-separated host names or `*.domain`;
   * default the browsers' own, push/push.ts DEFAULT_PUSH_HOSTS). Every send still goes to public addresses over https only.
   */
  pushHosts: string[];
  /** The household's addresses the bookshop writes to (SHELF_MAIL_RECIPIENTS); a mail to anyone else is not taken. */
  mailRecipients: string[];
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
      : mode === 'standalone' ? { file: join(resolve(env.SHELF_KEYS_DIR ?? './keys'), 'sealing.key'), create: true } : null,
    workDir: env.SHELF_WORK_DIR ? resolve(env.SHELF_WORK_DIR) : null,
    egress: env.SHELF_EGRESS !== 'off',
    ollamaUrl: env.OLLAMA_URL ? parseOllama(env.OLLAMA_URL) : null,
    imap: env.SHELF_IMAP_HOST && env.SHELF_IMAP_USER && (env.SHELF_IMAP_PASSWORD || env.SHELF_IMAP_PASSWORD_FILE) ? {
      host: parseHost(env.SHELF_IMAP_HOST),
      user: env.SHELF_IMAP_USER,
      password: env.SHELF_IMAP_PASSWORD ? { value: env.SHELF_IMAP_PASSWORD } : { file: env.SHELF_IMAP_PASSWORD_FILE! },
      folder: env.SHELF_IMAP_FOLDER || 'INBOX',
    } : null,
    mailRecipients: (env.SHELF_MAIL_RECIPIENTS ?? '').split(',').map((d) => d.trim().toLowerCase()).filter((d) => /^[^@\s]+@[^@\s]+$/.test(d)),
    pushHosts: parsePushHosts(env.SHELF_PUSH_HOSTS),
    arcSealers: (env.SHELF_MAIL_ARC_SEALERS ?? 'google.com').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
  };
}

function parsePushHosts(v: string | undefined): string[] {
  if (v === undefined || !v.trim()) return [...DEFAULT_PUSH_HOSTS];
  const hosts = v.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  for (const h of hosts) if (!PUSH_HOST_ENTRY.test(h)) throw new Error(`SHELF_PUSH_HOSTS: host names or *.domain, comma-separated, not ${h.slice(0, 80)}`);
  return hosts;
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

function parseOllama(v: string): string {
  const u = new URL(v);
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) throw new Error(`OLLAMA_URL must be http(s)://host[:port] without credentials`);
  return u.origin;
}

/** A host name only (no scheme, port or path): the IMAP port is always 993. */
function parseHost(v: string): string {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(v)) throw new Error('SHELF_IMAP_HOST must be a host name, e.g. imap.gmail.com (the port is always 993)');
  return v.toLowerCase();
}
