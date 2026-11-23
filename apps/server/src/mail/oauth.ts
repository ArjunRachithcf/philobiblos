// XOAUTH2 for the Philobiblos-only mailbox (philobiblos#27, docs/mail-providers.md): for a provider that refuses app
// passwords over IMAP. Philobiblos ships no OAuth client: the admin registers one with the provider and names it in the
// environment (config.ts OAuthClient), endpoints included, so no provider is built in. The mailbox is then connected in
// Settings by an admin, having read what connecting allows, with a sign-in of the last few minutes (as for enabling a
// bookshop); disconnecting only narrows and needs an admin alone.
//
// - Authorization code with PKCE (S256) and a state: both 256 random bits, kept in this process for 10 minutes, used once,
//   bound to the admin's session that started it. The redirect URI is always this Philobiblos's own origin
//   (PHILOBIBLOS_ORIGIN + REDIRECT_PATH), never anything a request says.
// - The refresh and access tokens are sealed like the delivery address (household/sealed.ts: AES-256-GCM, a key outside
//   the database, the row's name bound to it), with the fingerprint of the client and mailbox they were given for: when
//   either changes in the environment, the tokens are not used and never sent to the new endpoints.
// - A refresh happens only when the access token has less than a minute left, one at a time; a new refresh token in the
//   answer replaces the old one (rotation). A refusal of the refresh token itself (invalid_grant) forgets the tokens.
// - Disconnecting forgets the tokens first, then revokes the refresh token at the provider (RFC 7009) when it has an
//   endpoint for that. A refresh in flight that loses to it revokes the refresh token it was rotated to as well.
// - No token, code or verifier is ever in an answer, a log or job_run; the provider's own words are never shown, only
//   its RFC 6749 error code. The token client reaches the token and revocation endpoints and nothing else.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Config, ImapSettings, OAuthClient } from '../config';
import type { Db } from '../db/open';
import { SealError, forget, isSealed, keyProblem, seal, sealingKey, unseal } from '../household/sealed';
import { EgressError, createEgress, type EgressOptions, type FormEgress, type Response, type Rule } from '../net/egress';

/** The sealed row of the tokens. */
export const OAUTH_SEALED = 'imap_oauth';
/** Where the provider sends the admin back: a page of the web app (Settings), on this Philobiblos's own origin. */
export const REDIRECT_PATH = '/settings/mail-oauth';
/** How long a started connection waits for its finish. */
export const PENDING_MS = 10 * 60_000;
/** An access token with less than this left is refreshed first. */
export const REFRESH_EARLY_MS = 60_000;
/** At most this many connections started and not finished; the oldest goes first. */
export const MAX_PENDING = 8;
/** The longest an access token is believed to live, whatever the provider says. */
const MAX_LIFETIME_S = 24 * 3600;

/** RFC 6749 5.2 and 4.1.2.1: the only words of a provider's refusal that Philobiblos repeats. */
const OAUTH_ERRORS = new Set(['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'access_denied', 'unsupported_response_type', 'server_error', 'temporarily_unavailable', 'interaction_required', 'consent_required', 'login_required']);
const errorCode = (v: unknown) => (typeof v === 'string' && OAUTH_ERRORS.has(v) ? v : 'error');

/** A token, an authorization code: printable ASCII without spaces (RFC 6749 A.11, A.12, A.17). */
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const STATE = /^[A-Za-z0-9_-]{43}$/;

export class OAuthError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'OAuthError'; }
}

interface Stored { v: 1; client: string; refresh: string; access: string | null; expiresAt: string | null; at: string }

export const redirectUri = (origin: string) => `${origin}${REDIRECT_PATH}`;
const b64url = (b: Buffer) => b.toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest();

/**
 * The client and the mailbox the tokens are for. Tokens sealed for another (an endpoint, the client, the scope, the
 * mailbox changed in the environment) are never used or sent anywhere.
 */
export function fingerprint(imap: ImapSettings & { oauth: OAuthClient }, origin: string): string {
  const o = imap.oauth;
  return sha256(JSON.stringify([o.clientId, o.authorizeUrl, o.tokenUrl, o.revokeUrl, o.scope, imap.host, imap.port ?? 993, imap.user, redirectUri(origin)])).toString('hex');
}

const host = (u: string) => new URL(u).host;

/** What connecting allows, as Settings shows it before an admin connects. */
export function oauthAllows(imap: ImapSettings & { oauth: OAuthClient }, origin: string): string[] {
  const o = imap.oauth;
  return [
    `Philobiblos signs in to ${imap.host}:${imap.port ?? 993} as ${imap.user} with a token instead of a password, and still only reads the folder ${imap.folder}, read-only`,
    `You sign in at ${host(o.authorizeUrl)} and allow the scope ${o.scope}: what it reaches is the provider's to say (often the whole mailbox), so connect only the Philobiblos-only mailbox`,
    `The provider sends you back to ${redirectUri(origin)}`,
    `Its tokens go only to ${host(o.tokenUrl)}${o.revokeUrl && host(o.revokeUrl) !== host(o.tokenUrl) ? ` (and ${host(o.revokeUrl)} when you disconnect)` : ''}, and are sealed here with the key outside the database`,
    o.revokeUrl ? 'Disconnecting revokes the token at the provider' : 'The provider has no revocation endpoint here: after disconnecting, also remove Philobiblos from the account\'s connected apps',
  ];
}

export const allowsVersion = (lines: string[]) => sha256(JSON.stringify(lines)).toString('hex');

/** The token client's whole allowlist: the token endpoint and the revocation endpoint, https, public addresses. */
export function oauthEgressRules(o: OAuthClient): Rule[] {
  return [...new Set([o.tokenUrl, ...(o.revokeUrl ? [o.revokeUrl] : [])].map((u) => new URL(u).host))].map((h) => {
    const u = new URL(`https://${h}`);
    return { host: u.hostname, ...(u.port ? { port: Number(u.port) } : {}) };
  });
}

const isOAuth = (imap: ImapSettings | null): imap is ImapSettings & { oauth: OAuthClient } => Boolean(imap?.oauth);

function readStored(db: Db, key: Buffer | null): Stored | null {
  const v = unseal(db, key, OAUTH_SEALED);
  if (v === null) return null;
  const s = JSON.parse(v) as Stored;
  if (s.v !== 1 || typeof s.refresh !== 'string') throw new SealError('the sealed tokens do not read');
  return s;
}

export interface MailView {
  host: string; port: number; user: string; folder: string; configured: boolean; auth: 'password' | 'xoauth2';
  oauth?: { redirectUri: string; allows: string[]; allowsVersion: string; connected: boolean; connectedAt?: string; needsReconnect: boolean; revocable: boolean; connectBlocked?: string };
}

/** Settings.mail: the mailbox as configured, and with XOAUTH2 what connecting allows and whether it is connected. */
export function mailView(db: Db, cfg: Pick<Config, 'imap' | 'origin' | 'sealingKey' | 'mode'>): MailView {
  const imap = cfg.imap;
  const base: MailView = { host: imap?.host ?? '', port: imap?.port ?? 993, user: imap?.user ?? '', folder: imap?.folder ?? 'INBOX', configured: imap != null, auth: isOAuth(imap) ? 'xoauth2' : 'password' };
  if (!isOAuth(imap)) return base;
  const lines = oauthAllows(imap, cfg.origin);
  const problem = keyProblem(cfg);
  let stored: Stored | null = null, unreadable = false;
  if (!problem && isSealed(db, OAUTH_SEALED)) {
    try { stored = readStored(db, sealingKey(cfg)); } catch (e) { if (!(e instanceof SealError) && !(e instanceof SyntaxError)) throw e; unreadable = true; }
  }
  const current = stored?.client === fingerprint(imap, cfg.origin);
  const blocked = problem ? `the sealing key is ${problem}: fix PHILOBIBLOS_SEALING_KEY on the server, nothing can be sealed`
    : cfg.mode === 'homerslab' ? 'connecting needs a recent sign-in, which HomersLab does not tell Philobiblos yet' : null;
  return {
    ...base,
    oauth: {
      redirectUri: redirectUri(cfg.origin),
      allows: lines,
      allowsVersion: allowsVersion(lines),
      connected: Boolean(stored && current),
      ...(stored && current ? { connectedAt: stored.at } : {}),
      // Tokens are kept that are not used: for another client or mailbox, or sealed under another key.
      // A key problem hides whether they are current; they can still be forgotten (Disconnect needs no key).
      needsReconnect: unreadable || Boolean(stored && !current) || (problem !== null && isSealed(db, OAUTH_SEALED)),
      revocable: imap.oauth.revokeUrl !== null,
      ...(blocked ? { connectBlocked: blocked } : {}),
    },
  };
}

interface Pending { verifier: string; personId: string; sessionId: string; client: string; expires: number }
export interface Caller { personId: string; sessionId: string }

export interface MailOAuthOptions {
  /** The token client (tests: their own server); default one of its own (oauthEgressRules). */
  egress?: FormEgress;
  /** Tests only: how the default client resolves and trusts their server. */
  egressOptions?: Pick<EgressOptions, 'resolve' | 'test'>;
  now?: () => Date;
}

/** The OAuth side of the mailbox: connecting, the tokens, disconnecting. One per server (its pending connections are its own). */
export class MailOAuth {
  private readonly pending = new Map<string, Pending>();
  /** The refresh in flight, and the refresh token it uses: only a caller holding the same tokens waits for it. */
  private refreshing: { refresh: string; token: Promise<string> } | null = null;
  /** Disconnects so far, and connections started (start) by the latest one: what a refresh that lost a race was lost to. */
  private disconnects = 0;
  private starts = 0;
  private startsAtDisconnect = 0;
  private readonly egress: FormEgress | null;
  private readonly now: () => Date;

  constructor(private readonly db: Db, private readonly cfg: Pick<Config, 'imap' | 'origin' | 'sealingKey' | 'mode' | 'egress'>, o: MailOAuthOptions = {}) {
    this.now = o.now ?? (() => new Date());
    const imap = cfg.imap;
    this.egress = o.egress ?? (isOAuth(imap) ? createEgress({ rules: oauthEgressRules(imap.oauth), enabled: cfg.egress, ...o.egressOptions }) : null);
  }

  private client(): ImapSettings & { oauth: OAuthClient } {
    const imap = this.cfg.imap;
    if (!isOAuth(imap)) throw new OAuthError(409, 'the mailbox signs in with a password (PHILOBIBLOS_IMAP_AUTH is not xoauth2)');
    return imap;
  }

  private key(): Buffer {
    const problem = keyProblem(this.cfg);
    if (problem) throw new OAuthError(409, `the sealing key is ${problem}: fix PHILOBIBLOS_SEALING_KEY on the server`);
    return sealingKey(this.cfg)!;
  }

  /** The client's own credentials in a token or revocation request (client_secret_post, or the id alone for a public client). */
  private credentials(o: OAuthClient): Record<string, string> {
    if (!o.clientSecret) return { client_id: o.clientId };
    let secret: string;
    try { secret = 'value' in o.clientSecret ? o.clientSecret.value : readFileSync(o.clientSecret.file, 'utf8').trim(); } catch {
      throw new OAuthError(409, 'cannot read PHILOBIBLOS_IMAP_OAUTH_CLIENT_SECRET_FILE');
    }
    return { client_id: o.clientId, client_secret: secret };
  }

  private async post(url: string, params: Record<string, string>): Promise<Response> {
    if (!this.egress) throw new OAuthError(409, 'no OAuth client is configured');
    try { return await this.egress.form(url, new URLSearchParams(params)); } catch (e) {
      // The client's words only: never the answer's, never the request's.
      if (e instanceof EgressError) throw new OAuthError(502, `cannot reach ${new URL(url).host} (${e.reason})`);
      throw e;
    }
  }

  /** POST /mail/oauth/start: the provider's authorization URL to send the admin to. The caller checked the admin and the fresh sign-in. */
  start(by: Caller, body: unknown): { authorizeUrl: string } {
    const imap = this.client();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError(400, 'a JSON object is needed');
    const b = body as Record<string, unknown>;
    for (const k of Object.keys(b)) if (k !== 'accept') throw new OAuthError(400, `${k.slice(0, 40)} is not one of its fields`);
    this.key();
    if (typeof b.accept !== 'string' || b.accept !== allowsVersion(oauthAllows(imap, this.cfg.origin))) throw new OAuthError(409, 'what connecting allows changed since Settings showed it: read it again');
    this.starts++;
    const now = this.now().getTime();
    for (const [k, p] of this.pending) if (p.expires <= now) this.pending.delete(k);
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const state = b64url(randomBytes(32)), verifier = b64url(randomBytes(32));
    this.pending.set(sha256(state).toString('hex'), { verifier, personId: by.personId, sessionId: by.sessionId, client: fingerprint(imap, this.cfg.origin), expires: now + PENDING_MS });
    const u = new URL(imap.oauth.authorizeUrl);
    const q: Record<string, string> = {
      response_type: 'code', client_id: imap.oauth.clientId, redirect_uri: redirectUri(this.cfg.origin), scope: imap.oauth.scope, state,
      code_challenge: b64url(sha256(verifier)), code_challenge_method: 'S256',
      // Which account to sign in with: the mailbox's own (a hint; the mailbox refuses a token for another anyway).
      ...(imap.user.includes('@') ? { login_hint: imap.user } : {}),
    };
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return { authorizeUrl: u.toString() };
  }

  /**
   * POST /mail/oauth/finish: the code the provider sent back, for a state this server started for this very session
   * (once, within 10 minutes). The tokens are sealed; the answer is Settings.mail. The caller checked the admin.
   */
  async finish(by: Caller, body: unknown): Promise<MailView> {
    const imap = this.client();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError(400, 'a JSON object is needed');
    const b = body as Record<string, unknown>;
    for (const k of Object.keys(b)) if (k !== 'state' && k !== 'code' && k !== 'error') throw new OAuthError(400, `${k.slice(0, 40)} is not one of its fields`);
    if (typeof b.state !== 'string' || !STATE.test(b.state)) throw new OAuthError(400, 'state: the one the provider sent back');
    const id = sha256(b.state).toString('hex');
    const p = this.pending.get(id);
    // Used once, whatever happens next.
    this.pending.delete(id);
    const gone = 'this sign-in with the provider is not one Philobiblos started for you, or it took more than 10 minutes: connect again';
    if (!p || p.expires <= this.now().getTime() || p.personId !== by.personId || p.sessionId !== by.sessionId) throw new OAuthError(400, gone);
    if (b.error !== undefined) throw new OAuthError(400, `the provider did not allow it (${errorCode(b.error)})`);
    if (typeof b.code !== 'string' || !TOKEN.test(b.code) || b.code.length > 4096) throw new OAuthError(400, 'code: the one the provider sent back');
    const key = this.key();
    const r = await this.post(imap.oauth.tokenUrl, {
      grant_type: 'authorization_code', code: b.code, redirect_uri: redirectUri(this.cfg.origin), code_verifier: p.verifier, ...this.credentials(imap.oauth),
    });
    const t = tokens(r);
    if ('error' in t) throw new OAuthError(502, `the provider refused the code (${t.error})`);
    if (!t.refresh) throw new OAuthError(502, 'the provider gave no refresh token: its authorization URL must ask for offline access (docs/mail-providers.md)');
    const now = this.now();
    const s: Stored = { v: 1, client: p.client, refresh: t.refresh, access: t.access, expiresAt: new Date(now.getTime() + t.expiresIn * 1000).toISOString(), at: now.toISOString() };
    // A connection made again replaces the one before (not revoked: at some providers that would revoke the new grant too).
    seal(this.db, key, OAUTH_SEALED, JSON.stringify(s), now);
    return mailView(this.db, this.cfg);
  }

  /** The access token for the mailbox, refreshed first when it is (nearly) out of date. */
  async accessToken(): Promise<string> {
    const imap = this.client();
    const key = this.key();
    let s: Stored | null;
    try { s = readStored(this.db, key); } catch { throw new OAuthError(409, 'the sealed tokens do not open (the sealing key changed?): an admin connects the mailbox again in Settings'); }
    if (!s) throw new OAuthError(409, 'the mailbox is not connected: an admin connects it in Settings (Mailbox)');
    if (s.client !== fingerprint(imap, this.cfg.origin)) throw new OAuthError(409, 'the OAuth client or the mailbox changed on the server since it was connected: an admin connects it again in Settings');
    if (s.access && s.expiresAt && new Date(s.expiresAt).getTime() - this.now().getTime() > REFRESH_EARLY_MS) return s.access;
    if (this.refreshing?.refresh !== s.refresh) {
      const mine = { refresh: s.refresh, token: this.refresh(imap, key, s).finally(() => { if (this.refreshing === mine) this.refreshing = null; }) };
      this.refreshing = mine;
    }
    return this.refreshing.token;
  }

  private async refresh(imap: ImapSettings & { oauth: OAuthClient }, key: Buffer, s: Stored): Promise<string> {
    const disconnects = this.disconnects;
    const r = await this.post(imap.oauth.tokenUrl, { grant_type: 'refresh_token', refresh_token: s.refresh, ...this.credentials(imap.oauth) });
    const t = tokens(r);
    // Written only over the very tokens this refresh used: a disconnect or a new connection meanwhile stays as it is.
    const same = () => { try { return readStored(this.db, key)?.refresh === s.refresh; } catch { return false; } };
    if ('error' in t) {
      if (t.error === 'invalid_grant') {
        if (same()) forget(this.db, OAUTH_SEALED);
        throw new OAuthError(409, 'the provider no longer accepts this connection (revoked or expired): an admin connects the mailbox again in Settings');
      }
      throw new OAuthError(502, `the provider refused to refresh the token (${t.error})`);
    }
    if (!same()) {
      // Lost to a disconnect (one during this refresh, and no connection started since): the refresh token the provider
      // rotated to is revoked as well, so none outlives Disconnect (philobiblos#49). Lost to a new connection, made or
      // being made: not revoked, as finish does not revoke the one it replaces (at some providers that would end the new
      // grant too); the dropped token is never sent again. The revocation is waited for (bounded by the token client's
      // deadline), so it is done when the caller hears of the race.
      const lostToDisconnect = this.disconnects !== disconnects && this.starts === this.startsAtDisconnect;
      if (t.refresh && t.refresh !== s.refresh && lostToDisconnect) await this.revoke(imap.oauth, t.refresh);
      throw new OAuthError(409, 'the mailbox was disconnected or connected again meanwhile');
    }
    const now = this.now();
    // Rotation: a new refresh token replaces the old one, which is never sent again.
    const next: Stored = { ...s, refresh: t.refresh ?? s.refresh, access: t.access, expiresAt: new Date(now.getTime() + t.expiresIn * 1000).toISOString() };
    seal(this.db, key, OAUTH_SEALED, JSON.stringify(next), now);
    return t.access;
  }

  /**
   * DELETE /mail/oauth: the tokens are forgotten, then the refresh token revoked at the provider when it has an endpoint
   * for that (revoked null: it has none; false: it did not confirm). Tokens for another client are only forgotten.
   */
  async disconnect(): Promise<{ revoked: boolean | null }> {
    const imap = this.client();
    this.disconnects++;
    this.startsAtDisconnect = this.starts;
    let s: Stored | null = null;
    try { s = readStored(this.db, sealingKey(this.cfg)); } catch { /* unreadable: forgotten all the same */ }
    // Forgotten even when the key cannot open them.
    forget(this.db, OAUTH_SEALED);
    if (!imap.oauth.revokeUrl) return { revoked: null };
    if (!s || s.client !== fingerprint(imap, this.cfg.origin)) return { revoked: false };
    return { revoked: await this.revoke(imap.oauth, s.refresh) };
  }

  /** A refresh token revoked at the provider (RFC 7009): whether it confirmed; null when it has no endpoint for that. */
  private async revoke(o: OAuthClient, token: string): Promise<boolean | null> {
    if (!o.revokeUrl) return null;
    try {
      const r = await this.post(o.revokeUrl, { token, token_type_hint: 'refresh_token', ...this.credentials(o) });
      return r.status >= 200 && r.status < 300;
    } catch (e) { if (e instanceof OAuthError) return false; throw e; }
  }
}

/** A token endpoint's answer: the tokens, or the RFC 6749 error code of its refusal (nothing else of it). */
function tokens(r: Response): { access: string; refresh: string | null; expiresIn: number } | { error: string } {
  let j: Record<string, unknown>;
  try { const v = JSON.parse(r.body.toString('utf8')) as unknown; j = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return { error: 'error' }; }
  if (r.status !== 200) return { error: errorCode(j.error) };
  if (typeof j.access_token !== 'string' || !TOKEN.test(j.access_token)) return { error: 'error' };
  if (typeof j.token_type !== 'string' || j.token_type.toLowerCase() !== 'bearer') return { error: 'error' };
  if (j.refresh_token !== undefined && (typeof j.refresh_token !== 'string' || !TOKEN.test(j.refresh_token))) return { error: 'error' };
  const e = typeof j.expires_in === 'number' ? j.expires_in : typeof j.expires_in === 'string' && /^\d{1,9}$/.test(j.expires_in) ? Number(j.expires_in) : 3600;
  return { access: j.access_token, refresh: (j.refresh_token as string | undefined) ?? null, expiresIn: Math.max(0, Math.min(MAX_LIFETIME_S, Math.floor(e))) };
}
