// Settings from the environment (contracts/homerslab-app.yaml, docker-compose.yml). Secrets are read here and
// nowhere else, and never logged.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEnv } from '@philobiblos/contracts/env';
import { DEFAULT_PUSH_HOSTS, PUSH_HOST_ENTRY, wildcardTooBroad } from './push/hosts';
import { validTimeZone } from './jobs/zone';
import { validCurrency } from './household/currency';
import { parseLocale } from './household/locale';
import type { MailboxPlace, Secret } from './net/imap';
import type { Cidr } from './net/networks';
import { edgeAddress, parseTrustedProxy } from './net/proxy';

export type Mode = 'homerslab' | 'standalone';

/**
 * The OAuth client an admin registered with the mailbox's provider for XOAUTH2 (PHILOBIBLOS_IMAP_AUTH=xoauth2;
 * docs/mail-providers.md): Philobiblos ships none of its own. Its endpoints are the provider's, from the environment
 * only (https); the client secret is a secret like the IMAP password (null: a public client, PKCE alone).
 */
export interface OAuthClient {
  clientId: string;
  clientSecret: Secret | null;
  /** The provider's authorization endpoint, with any parameters of the provider's own it needs (never ours). */
  authorizeUrl: string;
  tokenUrl: string;
  /** RFC 7009 revocation; null when the provider has none (disconnecting then only forgets the tokens). */
  revokeUrl: string | null;
  scope: string;
}

/** The mailbox: where it is, and how Philobiblos signs in (an app password, or a token from the admin's OAuth client). */
export type ImapSettings = MailboxPlace & ({ password: Secret; oauth?: undefined } | { oauth: OAuthClient; password?: undefined });

export interface Config {
  mode: Mode;
  dataDir: string;
  dbFile: string;
  host: string;
  port: number;
  /** PHILOBIBLOS_TZ: only the zone the household starts with (its settings row, made at the first start); never read after. */
  timezone: string;
  /**
   * PHILOBIBLOS_CURRENCY (ISO 4217): the currency of a household that has none yet, at a start (household/money.ts
   * initCurrency); one it has is never replaced. null: none is assumed, an admin chooses it in Settings.
   */
  currency: string | null;
  /**
   * PHILOBIBLOS_LOCALE (BCP 47, such as en-GB or de-CH): the household's locale, read at every start (household/locale.ts):
   * the order letter's language when the shop's connector names none Philobiblos has, and the delivery-address
   * filter's common words. null: English.
   */
  locale: string | null;
  /**
   * PHILOBIBLOS_TRUSTED_PROXY (net/proxy.ts): the proxy's addresses or ranges, checked at start. Under HomersLab the only
   * sender whose X-HomersLab-* headers are trusted; in both modes the only one whose X-Forwarded-For names the client
   * (net/proxy.ts clientAddress). null: none, every client is the connection's address.
   */
  trustedProxy: Cidr[] | null;
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
   * The Philobiblos-only mailbox (ADR 0007): IMAP over TLS from the first byte (port 993 unless PHILOBIBLOS_IMAP_PORT
   * says otherwise), read-only. It signs in with an app password, a secret from the environment
   * (PHILOBIBLOS_IMAP_PASSWORD or PHILOBIBLOS_IMAP_PASSWORD_FILE), or with XOAUTH2 (PHILOBIBLOS_IMAP_AUTH=xoauth2): a token
   * from the admin's OAuth client, connected in Settings and sealed (mail/oauth.ts). Neither is ever in the API or a log.
   * null: not set up.
   */
  imap: ImapSettings | null;
  /**
   * Mail providers whose ARC seal Philobiblos trusts for a forward that broke the bookshop's DKIM
   * (PHILOBIBLOS_MAIL_ARC_SEALERS): none unless the household names its own (no provider is assumed, philobiblos#27).
   */
  arcSealers: string[];
  /**
   * Where the bookshop connectors are read from (connectors/load.ts): the folder that ships with Philobiblos
   * (PHILOBIBLOS_BUILTIN_CONNECTORS_DIR; the repository's connectors/, /app/connectors in the image) and the
   * household's own (PHILOBIBLOS_CONNECTORS_DIR, none by default). Each connector still waits for an admin to enable it.
   */
  connectorDirs: { builtin: string | null; local: string | null };
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
  const trustedProxy = parseTrustedProxy(env.PHILOBIBLOS_TRUSTED_PROXY);
  if (mode === 'homerslab' && !trustedProxy) throw new Error('PHILOBIBLOS_TRUSTED_PROXY must be set in homerslab mode');
  // Under HomersLab it names who may send X-HomersLab-Person: the edge's one address, never a range a neighbour is in.
  if (mode === 'homerslab' && !edgeAddress(trustedProxy)) throw new Error('PHILOBIBLOS_TRUSTED_PROXY must be the edge\'s one address in homerslab mode (no range, no list)');
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
    currency: parseCurrency(env.PHILOBIBLOS_CURRENCY),
    locale: parseLocaleEnv(env.PHILOBIBLOS_LOCALE),
    trustedProxy,
    webDir: env.PHILOBIBLOS_WEB_DIR ?? null,
    origin: origin.origin,
    rpId: origin.hostname,
    sealingKey: env.PHILOBIBLOS_SEALING_KEY ? { value: env.PHILOBIBLOS_SEALING_KEY }
      : env.PHILOBIBLOS_SEALING_KEY_FILE ? { file: env.PHILOBIBLOS_SEALING_KEY_FILE, create: false }
      : mode === 'standalone' ? { file: join(resolve(env.PHILOBIBLOS_KEYS_DIR ?? './keys'), 'sealing.key'), create: true } : null,
    workDir: env.PHILOBIBLOS_WORK_DIR ? resolve(env.PHILOBIBLOS_WORK_DIR) : null,
    egress: env.PHILOBIBLOS_EGRESS !== 'off',
    ollamaUrl: env.OLLAMA_URL ? parseOllama(env.OLLAMA_URL) : null,
    imap: parseImap(env),
    mailRecipients: (env.PHILOBIBLOS_MAIL_RECIPIENTS ?? '').split(',').map((d) => d.trim().toLowerCase()).filter((d) => /^[^@\s]+@[^@\s]+$/.test(d)),
    pushHosts: parsePushHosts(env.PHILOBIBLOS_PUSH_HOSTS),
    arcSealers: (env.PHILOBIBLOS_MAIL_ARC_SEALERS ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    connectorDirs: {
      builtin: env.PHILOBIBLOS_BUILTIN_CONNECTORS_DIR === 'none' ? null : resolve(env.PHILOBIBLOS_BUILTIN_CONNECTORS_DIR || fileURLToPath(new URL('../../../connectors', import.meta.url))),
      local: env.PHILOBIBLOS_CONNECTORS_DIR ? resolve(env.PHILOBIBLOS_CONNECTORS_DIR) : null,
    },
  };
}

/** PHILOBIBLOS_TZ: the household's zone at the first start only (jobs/schedule.ts initHousehold); Settings has it after. */
function parseTimeZone(v: string | undefined): string {
  if (v === undefined || !v.trim()) return 'Europe/Zurich';
  const tz = v.trim();
  if (!validTimeZone(tz)) throw new Error(`PHILOBIBLOS_TZ: a time zone such as Europe/Zurich, not ${v.trim().slice(0, 80)}`);
  return tz;
}

/** PHILOBIBLOS_LOCALE: a BCP 47 tag, canonical (de-ch is de-CH); empty or unset is none. */
function parseLocaleEnv(v: string | undefined): string | null {
  if (v === undefined || !v.trim()) return null;
  const l = parseLocale(v);
  if (!l) throw new Error(`PHILOBIBLOS_LOCALE: a language tag such as en-GB or de-CH, not ${v.trim().slice(0, 20)}`);
  return l.tag;
}

/** PHILOBIBLOS_CURRENCY: an ISO 4217 code this server knows, any case; empty or unset is none. */
function parseCurrency(v: string | undefined): string | null {
  if (v === undefined || !v.trim()) return null;
  const code = v.trim().toUpperCase();
  if (!validCurrency(code)) throw new Error(`PHILOBIBLOS_CURRENCY: an ISO 4217 code this server knows, not ${v.trim().slice(0, 20)}`);
  return code;
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

/** A host name only (no scheme, port or path): the port is PHILOBIBLOS_IMAP_PORT's. */
function parseHost(v: string): string {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(v)) throw new Error('PHILOBIBLOS_IMAP_HOST must be a host name, e.g. imap.example.org (the port is PHILOBIBLOS_IMAP_PORT, default 993)');
  return v.toLowerCase();
}

/**
 * The mailbox, or null while it is not set up. PHILOBIBLOS_IMAP_AUTH is `password` (the default: an app password) or
 * `xoauth2` (the admin's OAuth client, each part named, and then no password: one way to sign in, never a fallback).
 */
function parseImap(env: NodeJS.ProcessEnv): ImapSettings | null {
  const auth = env.PHILOBIBLOS_IMAP_AUTH?.trim() || 'password';
  if (auth !== 'password' && auth !== 'xoauth2') throw new Error('PHILOBIBLOS_IMAP_AUTH must be password or xoauth2');
  const oauthKeys = Object.keys(env).filter((k) => k.startsWith('PHILOBIBLOS_IMAP_OAUTH_') && env[k]);
  if (auth === 'password') {
    if (oauthKeys.length) throw new Error(`${oauthKeys[0]} is set, but PHILOBIBLOS_IMAP_AUTH is not xoauth2`);
    if (!(env.PHILOBIBLOS_IMAP_HOST && env.PHILOBIBLOS_IMAP_USER && (env.PHILOBIBLOS_IMAP_PASSWORD || env.PHILOBIBLOS_IMAP_PASSWORD_FILE))) return null;
    return { ...place(env), password: env.PHILOBIBLOS_IMAP_PASSWORD ? { value: env.PHILOBIBLOS_IMAP_PASSWORD } : { file: env.PHILOBIBLOS_IMAP_PASSWORD_FILE! } };
  }
  if (env.PHILOBIBLOS_IMAP_PASSWORD || env.PHILOBIBLOS_IMAP_PASSWORD_FILE) throw new Error('PHILOBIBLOS_IMAP_AUTH=xoauth2 signs in with a token: leave PHILOBIBLOS_IMAP_PASSWORD out');
  for (const k of ['PHILOBIBLOS_IMAP_HOST', 'PHILOBIBLOS_IMAP_USER', 'PHILOBIBLOS_IMAP_OAUTH_CLIENT_ID', 'PHILOBIBLOS_IMAP_OAUTH_AUTHORIZE_URL', 'PHILOBIBLOS_IMAP_OAUTH_TOKEN_URL', 'PHILOBIBLOS_IMAP_OAUTH_SCOPE']) {
    if (!env[k]?.trim()) throw new Error(`PHILOBIBLOS_IMAP_AUTH=xoauth2 needs ${k} (docs/mail-providers.md)`);
  }
  const clientId = env.PHILOBIBLOS_IMAP_OAUTH_CLIENT_ID!.trim();
  if (!/^[\x21-\x7e]{1,512}$/.test(clientId)) throw new Error('PHILOBIBLOS_IMAP_OAUTH_CLIENT_ID: printable characters without spaces, at most 512');
  const scope = env.PHILOBIBLOS_IMAP_OAUTH_SCOPE!.trim().split(/\s+/).join(' ');
  // RFC 6749 3.3: scope tokens are printable ASCII without space, " or \.
  if (scope.length > 1024 || !scope.split(' ').every((w) => /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(w))) throw new Error('PHILOBIBLOS_IMAP_OAUTH_SCOPE: the scopes, separated by spaces');
  return {
    ...place(env),
    oauth: {
      clientId,
      clientSecret: env.PHILOBIBLOS_IMAP_OAUTH_CLIENT_SECRET ? { value: env.PHILOBIBLOS_IMAP_OAUTH_CLIENT_SECRET } : env.PHILOBIBLOS_IMAP_OAUTH_CLIENT_SECRET_FILE ? { file: env.PHILOBIBLOS_IMAP_OAUTH_CLIENT_SECRET_FILE } : null,
      authorizeUrl: oauthUrl('PHILOBIBLOS_IMAP_OAUTH_AUTHORIZE_URL', env.PHILOBIBLOS_IMAP_OAUTH_AUTHORIZE_URL!, true),
      tokenUrl: oauthUrl('PHILOBIBLOS_IMAP_OAUTH_TOKEN_URL', env.PHILOBIBLOS_IMAP_OAUTH_TOKEN_URL!, false),
      revokeUrl: env.PHILOBIBLOS_IMAP_OAUTH_REVOKE_URL?.trim() ? oauthUrl('PHILOBIBLOS_IMAP_OAUTH_REVOKE_URL', env.PHILOBIBLOS_IMAP_OAUTH_REVOKE_URL, false) : null,
      scope,
    },
  };
}

function place(env: NodeJS.ProcessEnv): MailboxPlace {
  const port = env.PHILOBIBLOS_IMAP_PORT?.trim() ? Number(env.PHILOBIBLOS_IMAP_PORT.trim()) : 993;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PHILOBIBLOS_IMAP_PORT: a port from 1 to 65535 (TLS from the first byte on it, always)');
  return { host: parseHost(env.PHILOBIBLOS_IMAP_HOST!), port, user: env.PHILOBIBLOS_IMAP_USER!, folder: env.PHILOBIBLOS_IMAP_FOLDER || 'INBOX', caFile: env.PHILOBIBLOS_IMAP_CA_FILE?.trim() || null };
}

/** Parameters Philobiblos sets on the authorization request itself; an admin's authorize URL may not carry them. */
// response_mode too: the code must come back in the query, which is where the web app reads it; request and request_uri
// would carry parameters Philobiblos did not set.
export const OAUTH_OWN_PARAMS = ['response_type', 'response_mode', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'login_hint', 'request', 'request_uri'];

/** An OAuth endpoint: https, no credentials or fragment; only the authorization endpoint may carry query parameters. */
function oauthUrl(name: string, v: string, query: boolean): string {
  let u: URL;
  try { u = new URL(v.trim()); } catch { throw new Error(`${name}: an https URL`); }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) throw new Error(`${name}: an https URL without credentials or #fragment`);
  if (!query && u.search) throw new Error(`${name}: no query parameters (they go in the request's body)`);
  const own = OAUTH_OWN_PARAMS.find((p) => u.searchParams.has(p));
  if (own) throw new Error(`${name}: ${own} is Philobiblos's to set, leave it out`);
  return u.toString();
}
