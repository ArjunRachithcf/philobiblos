// XOAUTH2 for the mailbox (philobiblos#27, mail/oauth.ts) against a fake OAuth provider made here: an https server on
// 127.0.0.1 with the tests' own certificate (fixtures/tls, *.test names), which checks PKCE, the redirect URI and the
// client the way a real provider does, and rotates refresh tokens when told to. Nothing here reaches a real provider.
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, logUrl, type BuiltApp } from '../src/app';
import { createSession } from '../src/auth/sessions';
import { loadConfig, type Config } from '../src/config';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { refreshMail } from '../src/mail/job';
import { MailOAuth, OAUTH_SEALED, OAuthError, PENDING_MS, REDIRECT_PATH, mailView, oauthEgressRules } from '../src/mail/oauth';
import type { MailboxConfig } from '../src/net/imap';
import { isSealed, unseal } from '../src/household/sealed';
import { ORIGIN, TEST_SEALING_KEY, household, sessionCookie } from './helpers';
import { CONNECTORS, enableShop, fakeBox } from './mailkit';

const tls = (f: string) => readFileSync(new URL(`./fixtures/tls/${f}`, import.meta.url), 'utf8');
const CA = tls('cert.pem');
const KEY = Buffer.from(TEST_SEALING_KEY, 'base64');
const CLIENT_ID = 'philobiblos-test-client';
const CLIENT_SECRET = 'test-client-secret-not-real';
const USER = 'shelf@shelf.test';

/** The fake provider: what it was asked, the codes it issued, the refresh tokens it honours. */
const provider = {
  requests: [] as { path: string; form: URLSearchParams }[],
  codes: new Map<string, { challenge: string; redirect: string }>(),
  refresh: new Set<string>(),
  rotate: false,
  /** The next answers of the token endpoint, before its own logic (a status and a body). */
  next: [] as { status: number; body: unknown }[],
  n: 0,
  revokeStatus: 200,
  /** While set, a refresh is answered only once it resolves (a refresh held in flight). */
  gate: null as Promise<void> | null,
};
const b64url = (b: Buffer) => b.toString('base64url');
let server: https.Server, port = 0;
beforeAll(async () => {
  server = https.createServer({ key: tls('key.pem'), cert: CA }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      provider.requests.push({ path: req.url ?? '', form });
      const send = (status: number, body: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
      if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') return send(400, { error: 'invalid_request' });
      if (req.url === '/revoke') { res.statusCode = provider.revokeStatus; return res.end(); }
      if (req.url !== '/token') return send(404, {});
      const forced = provider.next.shift();
      if (forced) return send(forced.status, forced.body);
      if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) return send(401, { error: 'invalid_client' });
      const issue = () => {
        const n = ++provider.n;
        const refresh = `rt-${n}-${'r'.repeat(20)}`;
        provider.refresh.add(refresh);
        return { access_token: `at-${n}-${'a'.repeat(20)}`, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600 };
      };
      if (form.get('grant_type') === 'authorization_code') {
        const c = provider.codes.get(form.get('code') ?? '');
        provider.codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (!c || c.redirect !== form.get('redirect_uri') || b64url(createHash('sha256').update(verifier).digest()) !== c.challenge) {
          return send(400, { error: 'invalid_grant', error_description: `the words of the provider ${verifier}` });
        }
        return send(200, issue());
      }
      if (form.get('grant_type') === 'refresh_token' && provider.gate) {
        const gate = provider.gate;
        provider.gate = null;
        // Recorded as held until it is let through; then it is answered (and recorded) as any other.
        provider.requests.pop();
        provider.requests.push({ path: 'held', form });
        void gate.then(() => { provider.requests.splice(provider.requests.findIndex((r) => r.path === 'held'), 1); req.emit('end'); });
        return;
      }
      if (form.get('grant_type') === 'refresh_token') {
        const r = form.get('refresh_token') ?? '';
        if (!provider.refresh.has(r)) return send(400, { error: 'invalid_grant', error_description: `unknown ${r}` });
        const answer = issue();
        if (provider.rotate) { provider.refresh.delete(r); return send(200, answer); }
        provider.refresh.delete(answer.refresh_token);
        const { refresh_token: _r, ...keep } = answer;
        return send(200, keep);
      }
      return send(400, { error: 'unsupported_grant_type' });
    });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
});
afterAll(() => { server.close(); });
beforeEach(() => {
  Object.assign(provider, { requests: [], rotate: false, next: [], revokeStatus: 200, n: 0, gate: null });
  provider.codes.clear();
  provider.refresh.clear();
});

const ENV = {
  PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY,
  PHILOBIBLOS_IMAP_HOST: 'imap.test', PHILOBIBLOS_IMAP_USER: USER, PHILOBIBLOS_IMAP_AUTH: 'xoauth2',
  PHILOBIBLOS_IMAP_OAUTH_CLIENT_ID: CLIENT_ID, PHILOBIBLOS_IMAP_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
  PHILOBIBLOS_IMAP_OAUTH_AUTHORIZE_URL: 'https://other.test/authorize?access_type=offline',
  PHILOBIBLOS_IMAP_OAUTH_TOKEN_URL: 'https://other.test/token', PHILOBIBLOS_IMAP_OAUTH_REVOKE_URL: 'https://other.test/revoke',
  PHILOBIBLOS_IMAP_OAUTH_SCOPE: 'mail.read offline_access',
};
const config = (over: Record<string, string | undefined> = {}) => loadConfig({ ...ENV, ...over });
const egressOptions = () => ({ resolve: async () => [{ address: '127.0.0.1', family: 4 }], test: { ca: CA, isPublic: () => true, httpsPort: port } });

let clock = new Date('2026-11-20T10:00:00Z');
const oauthOf = (db: Db, cfg: Config = config()) => new MailOAuth(db, cfg, { egressOptions: egressOptions(), now: () => clock });

/** The browser's part: the provider signs the admin in and sends them back with a code for this very authorization request. */
function consent(authorizeUrl: string): { code: string; state: string } {
  const u = new URL(authorizeUrl);
  const code = `code-${provider.codes.size + 1}-${'c'.repeat(16)}`;
  provider.codes.set(code, { challenge: u.searchParams.get('code_challenge')!, redirect: u.searchParams.get('redirect_uri')! });
  return { code, state: u.searchParams.get('state')! };
}

/** Settings' view of the connection, as an admin reads it before connecting. */
const oauthView = (db: Db, cfg: Config = config()) => mailView(db, cfg).oauth!;

const ME = { personId: 'p_alex', sessionId: 's-alex' };

/** Connected through MailOAuth directly: the tokens are sealed. */
async function connected(db: Db, o = oauthOf(db), cfg = config()) {
  const { authorizeUrl } = o.start(ME, { accept: oauthView(db, cfg).allowsVersion });
  await o.finish(ME, consent(authorizeUrl));
  return o;
}
const sealedJson = (db: Db) => JSON.parse(unseal(db, KEY, OAUTH_SEALED)!) as { refresh: string; access: string; expiresAt: string };
const tokenRequests = () => provider.requests.filter((r) => r.path === '/token');

describe('configuration: the admin\'s own OAuth client, from the environment', () => {
  it('an app password stays the default', () => {
    const c = loadConfig({ PHILOBIBLOS_IMAP_HOST: 'imap.test', PHILOBIBLOS_IMAP_USER: USER, PHILOBIBLOS_IMAP_PASSWORD: 'pw' });
    expect(c.imap).toMatchObject({ host: 'imap.test', port: 993, password: { value: 'pw' } });
    expect(c.imap!.oauth).toBeUndefined();
  });

  it('xoauth2 takes the client, its endpoints and the scope, and no password', () => {
    expect(config().imap!.oauth).toEqual({
      clientId: CLIENT_ID, clientSecret: { value: CLIENT_SECRET }, authorizeUrl: 'https://other.test/authorize?access_type=offline',
      tokenUrl: 'https://other.test/token', revokeUrl: 'https://other.test/revoke', scope: 'mail.read offline_access',
    });
    expect(config().imap!.password).toBeUndefined();
    expect(config({ PHILOBIBLOS_IMAP_OAUTH_CLIENT_SECRET: undefined, PHILOBIBLOS_IMAP_OAUTH_REVOKE_URL: undefined }).imap!.oauth).toMatchObject({ clientSecret: null, revokeUrl: null });
  });

  it.each([
    [{ PHILOBIBLOS_IMAP_AUTH: 'oauth' }, /password or xoauth2/],
    [{ PHILOBIBLOS_IMAP_PASSWORD: 'pw' }, /leave PHILOBIBLOS_IMAP_PASSWORD out/],
    [{ PHILOBIBLOS_IMAP_OAUTH_CLIENT_ID: undefined }, /needs PHILOBIBLOS_IMAP_OAUTH_CLIENT_ID/],
    [{ PHILOBIBLOS_IMAP_OAUTH_TOKEN_URL: undefined }, /needs PHILOBIBLOS_IMAP_OAUTH_TOKEN_URL/],
    [{ PHILOBIBLOS_IMAP_OAUTH_SCOPE: '' }, /needs PHILOBIBLOS_IMAP_OAUTH_SCOPE/],
    [{ PHILOBIBLOS_IMAP_OAUTH_TOKEN_URL: 'http://other.test/token' }, /https URL/],
    [{ PHILOBIBLOS_IMAP_OAUTH_AUTHORIZE_URL: 'https://user:pw@other.test/authorize' }, /without credentials/],
    [{ PHILOBIBLOS_IMAP_OAUTH_TOKEN_URL: 'https://other.test/token?client_secret=x' }, /no query parameters/],
    [{ PHILOBIBLOS_IMAP_OAUTH_AUTHORIZE_URL: 'https://other.test/authorize?redirect_uri=https://evil.example/' }, /redirect_uri is Philobiblos's to set/],
    [{ PHILOBIBLOS_IMAP_OAUTH_AUTHORIZE_URL: 'https://other.test/authorize?state=fixed' }, /state is Philobiblos's to set/],
    [{ PHILOBIBLOS_IMAP_OAUTH_AUTHORIZE_URL: 'https://other.test/authorize?response_mode=form_post' }, /response_mode is Philobiblos's to set/],
    [{ PHILOBIBLOS_IMAP_OAUTH_SCOPE: 'mail "read' }, /SCOPE/],
    [{ PHILOBIBLOS_IMAP_AUTH: undefined }, /PHILOBIBLOS_IMAP_OAUTH_CLIENT_ID is set, but PHILOBIBLOS_IMAP_AUTH is not xoauth2/],
  ])('%j is refused at start', (over, msg) => {
    expect(() => config(over)).toThrow(msg);
  });

  it('the port and the certificate of a self-hosted server or a local bridge: TLS from the first byte whatever the port', () => {
    const c = loadConfig({ PHILOBIBLOS_IMAP_HOST: '127.0.0.1', PHILOBIBLOS_IMAP_USER: USER, PHILOBIBLOS_IMAP_PASSWORD: 'pw', PHILOBIBLOS_IMAP_PORT: '1143', PHILOBIBLOS_IMAP_CA_FILE: '/run/secrets/bridge.pem' });
    expect(c.imap).toMatchObject({ host: '127.0.0.1', port: 1143, caFile: '/run/secrets/bridge.pem' });
    for (const p of ['0', '65536', '99x', '1.5']) expect(() => loadConfig({ PHILOBIBLOS_IMAP_HOST: 'imap.test', PHILOBIBLOS_IMAP_USER: USER, PHILOBIBLOS_IMAP_PASSWORD: 'pw', PHILOBIBLOS_IMAP_PORT: p })).toThrow(/PHILOBIBLOS_IMAP_PORT/);
  });

  it('the token client reaches the token and revocation endpoints and nothing else', () => {
    expect(oauthEgressRules(config().imap!.oauth!)).toEqual([{ host: 'other.test' }]);
    expect(oauthEgressRules({ ...config().imap!.oauth!, tokenUrl: 'https://token.test:8443/t', revokeUrl: 'https://revoke.test/r' })).toEqual([{ host: 'token.test', port: 8443 }, { host: 'revoke.test' }]);
  });
});

describe('connecting: authorization code with PKCE and a state, back to this Philobiblos only', () => {
  it('the authorization URL: the admin\'s endpoint and its own parameters, ours set by Philobiblos, the redirect on its own origin', () => {
    const db = household();
    const o = oauthOf(db);
    const view = oauthView(db);
    const u = new URL(o.start(ME, { accept: view.allowsVersion }).authorizeUrl);
    expect(`${u.origin}${u.pathname}`).toBe('https://other.test/authorize');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      access_type: 'offline', response_type: 'code', client_id: CLIENT_ID, redirect_uri: `${ORIGIN}${REDIRECT_PATH}`,
      scope: 'mail.read offline_access', code_challenge_method: 'S256', login_hint: USER,
    });
    expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The client secret never goes to the browser.
    expect(u.toString()).not.toContain(CLIENT_SECRET);
    // Each start its own state and verifier.
    const again = new URL(o.start(ME, { accept: view.allowsVersion }).authorizeUrl);
    expect(again.searchParams.get('state')).not.toBe(u.searchParams.get('state'));
    expect(again.searchParams.get('code_challenge')).not.toBe(u.searchParams.get('code_challenge'));
  });

  it('start needs the version of what Settings showed', () => {
    const db = household();
    const o = oauthOf(db);
    expect(() => o.start(ME, { accept: '0'.repeat(64) })).toThrow(/changed since Settings showed it/);
    expect(() => o.start(ME, {})).toThrow(OAuthError);
    expect(() => o.start(ME, { accept: oauthView(db).allowsVersion, redirectUri: 'https://evil.example/' })).toThrow(/redirectUri is not one of its fields/);
  });

  it('finish: the code for its verifier, sealed tokens, and nothing of them in the answer', async () => {
    const db = household();
    const o = oauthOf(db);
    const { authorizeUrl } = o.start(ME, { accept: oauthView(db).allowsVersion });
    const answer = await o.finish(ME, consent(authorizeUrl));
    expect(answer.oauth).toMatchObject({ connected: true, connectedAt: clock.toISOString(), needsReconnect: false });
    const asked = tokenRequests()[0]!.form;
    expect(Object.fromEntries(asked)).toMatchObject({ grant_type: 'authorization_code', redirect_uri: `${ORIGIN}${REDIRECT_PATH}`, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    expect(asked.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sealedJson(db)).toMatchObject({ refresh: 'rt-1-' + 'r'.repeat(20), access: 'at-1-' + 'a'.repeat(20) });
    // At rest, sealed: neither token is in the row's bytes.
    const row = db.select().from(t.sealedSecret).all().find((r) => r.key === OAUTH_SEALED)!;
    expect(row.ciphertext.toString('latin1')).not.toMatch(/rt-1|at-1/);
    expect(JSON.stringify(answer)).not.toMatch(/rt-1|at-1|code-1/);
  });

  it('a state is used once, only by the session that started it, within 10 minutes', async () => {
    const db = household();
    const o = oauthOf(db);
    const accept = oauthView(db).allowsVersion;
    const first = consent(o.start(ME, { accept }).authorizeUrl);
    await o.finish(ME, first);
    await expect(o.finish(ME, first)).rejects.toThrow(/not one Philobiblos started for you/);
    // Another admin's session, or another session of the same admin.
    const other = consent(o.start(ME, { accept }).authorizeUrl);
    await expect(o.finish({ personId: 'p_sam', sessionId: 's-sam' }, other)).rejects.toThrow(/not one Philobiblos started/);
    const named = consent(o.start(ME, { accept }).authorizeUrl);
    await expect(o.finish({ personId: 'p_sam', sessionId: ME.sessionId }, named)).rejects.toThrow(/not one Philobiblos started/);
    const mine = consent(o.start(ME, { accept }).authorizeUrl);
    await expect(o.finish({ ...ME, sessionId: 's-other' }, mine)).rejects.toThrow(/not one Philobiblos started/);
    // And the one that was tried by someone else is gone for its owner too.
    await expect(o.finish(ME, other)).rejects.toThrow(/not one Philobiblos started/);
    const late = consent(o.start(ME, { accept }).authorizeUrl);
    clock = new Date(clock.getTime() + PENDING_MS + 1);
    await expect(o.finish(ME, late)).rejects.toThrow(/more than 10 minutes/);
    // A state nobody made, in the right shape.
    await expect(o.finish(ME, { state: 'A'.repeat(43), code: 'x' })).rejects.toThrow(/not one Philobiblos started/);
    // Only the one exchange that was allowed reached the provider.
    expect(tokenRequests()).toHaveLength(1);
  });

  it('a code that is not for this verifier is refused by the provider, and its words are not repeated', async () => {
    const db = household();
    const o = oauthOf(db);
    const { authorizeUrl } = o.start(ME, { accept: oauthView(db).allowsVersion });
    const { state } = consent(authorizeUrl);
    // Another authorization request's code (its own challenge): the verifier does not match it.
    provider.codes.set('stolen-code', { challenge: 'x'.repeat(43), redirect: `${ORIGIN}${REDIRECT_PATH}` });
    const e = (await o.finish(ME, { state, code: 'stolen-code' }).then(() => null, (x: unknown) => x)) as OAuthError;
    expect(e).toBeInstanceOf(OAuthError);
    expect(e.message).toBe('the provider refused the code (invalid_grant)');
    expect(isSealed(db, OAUTH_SEALED)).toBe(false);
  });

  it('the provider\'s refusal comes back as an error: nothing is asked of its token endpoint', async () => {
    const db = household();
    const o = oauthOf(db);
    const { state } = consent(o.start(ME, { accept: oauthView(db).allowsVersion }).authorizeUrl);
    await expect(o.finish(ME, { state, error: 'access_denied' })).rejects.toThrow('the provider did not allow it (access_denied)');
    const s2 = consent(o.start(ME, { accept: oauthView(db).allowsVersion }).authorizeUrl).state;
    await expect(o.finish(ME, { state: s2, error: '<script>words of its own</script>' })).rejects.toThrow('the provider did not allow it (error)');
    expect(tokenRequests()).toHaveLength(0);
  });

  it('no refresh token (offline access not asked for): not connected', async () => {
    const db = household();
    const o = oauthOf(db);
    const { authorizeUrl } = o.start(ME, { accept: oauthView(db).allowsVersion });
    provider.next.push({ status: 200, body: { access_token: 'at-only', token_type: 'Bearer', expires_in: 3600 } });
    await expect(o.finish(ME, consent(authorizeUrl))).rejects.toThrow(/no refresh token/);
    expect(isSealed(db, OAUTH_SEALED)).toBe(false);
  });

  it.each([
    [{ access_token: 'at x', token_type: 'Bearer', refresh_token: 'rt' }],
    [{ access_token: 'at\u0001auth=Bearer y', token_type: 'Bearer', refresh_token: 'rt' }],
    [{ access_token: 'at', token_type: 'mac', refresh_token: 'rt' }],
    [{ access_token: 'at', token_type: 'Bearer', refresh_token: 42 }],
    [['not', 'an', 'object']],
  ])('an answer that is not a bearer token is refused: %j', async (body) => {
    const db = household();
    const o = oauthOf(db);
    const { authorizeUrl } = o.start(ME, { accept: oauthView(db).allowsVersion });
    provider.next.push({ status: 200, body });
    await expect(o.finish(ME, consent(authorizeUrl))).rejects.toThrow('the provider refused the code (error)');
    expect(isSealed(db, OAUTH_SEALED)).toBe(false);
  });
});

describe('the tokens: used, refreshed and rotated, never sent where they were not given', () => {
  it('the mail job signs in with the access token (XOAUTH2), never a password', async () => {
    const db = enableShop(household());
    const o = await connected(db);
    const opened: MailboxConfig[] = [];
    const out = await refreshMail(db, { ...config(), connectors: CONNECTORS }, { open: async (c) => { opened.push(c); return fakeBox([]); }, token: () => o.accessToken() });
    expect(out.status).toBe('done');
    expect(opened[0]).toMatchObject({ host: 'imap.test', user: USER, accessToken: 'at-1-' + 'a'.repeat(20) });
    expect(opened[0]!.password).toBeUndefined();
    // Still fresh: no refresh asked for.
    expect(tokenRequests()).toHaveLength(1);
  });

  it('an access token with less than a minute left is refreshed first; without rotation the refresh token stays', async () => {
    const db = household();
    const o = await connected(db);
    clock = new Date(clock.getTime() + 3600_000 - 59_000);
    expect(await o.accessToken()).toBe('at-2-' + 'a'.repeat(20));
    const asked = tokenRequests()[1]!.form;
    expect(Object.fromEntries(asked)).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt-1-' + 'r'.repeat(20), client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    expect(sealedJson(db)).toMatchObject({ refresh: 'rt-1-' + 'r'.repeat(20), access: 'at-2-' + 'a'.repeat(20) });
    // The new one is used until it too is nearly out of date.
    expect(await o.accessToken()).toBe('at-2-' + 'a'.repeat(20));
    expect(tokenRequests()).toHaveLength(2);
  });

  it('rotation: a new refresh token replaces the old one, which is never sent again', async () => {
    const db = household();
    const o = await connected(db);
    provider.rotate = true;
    clock = new Date(clock.getTime() + 3600_000);
    await o.accessToken();
    expect(sealedJson(db).refresh).toBe('rt-2-' + 'r'.repeat(20));
    clock = new Date(clock.getTime() + 3600_000);
    expect(await o.accessToken()).toBe('at-3-' + 'a'.repeat(20));
    expect(tokenRequests().slice(1).map((r) => r.form.get('refresh_token'))).toEqual(['rt-1-' + 'r'.repeat(20), 'rt-2-' + 'r'.repeat(20)]);
  });

  it('two at once: one refresh', async () => {
    const db = household();
    const o = await connected(db);
    provider.rotate = true;
    clock = new Date(clock.getTime() + 3600_000);
    const [a, b] = await Promise.all([o.accessToken(), o.accessToken()]);
    expect(a).toBe(b);
    expect(tokenRequests()).toHaveLength(2);
  });

  it('a refresh token the provider no longer accepts: forgotten, and the mail job says to connect again', async () => {
    const db = enableShop(household());
    const o = await connected(db);
    provider.refresh.clear();
    clock = new Date(clock.getTime() + 3600_000);
    const out = await refreshMail(db, { ...config(), connectors: CONNECTORS }, { open: async () => fakeBox([]), token: () => o.accessToken() });
    expect(out).toEqual({ status: 'blocked', detail: 'the provider no longer accepts this connection (revoked or expired): an admin connects the mailbox again in Settings' });
    expect(isSealed(db, OAUTH_SEALED)).toBe(false);
    // The provider's words (which named the token) are nowhere.
    expect(JSON.stringify(out)).not.toContain('rt-1');
  });

  it('another refusal keeps the tokens (the provider may be down); an unreachable endpoint fails the job', async () => {
    const db = enableShop(household());
    const o = await connected(db);
    clock = new Date(clock.getTime() + 3600_000);
    provider.next.push({ status: 401, body: { error: 'invalid_client', error_description: 'rt-1 words' } });
    await expect(o.accessToken()).rejects.toThrow('the provider refused to refresh the token (invalid_client)');
    expect(isSealed(db, OAUTH_SEALED)).toBe(true);
    const off = new MailOAuth(db, { ...config(), egress: false }, { now: () => clock });
    const out = await refreshMail(db, { ...config(), connectors: CONNECTORS }, { open: async () => fakeBox([]), token: () => off.accessToken() });
    expect(out).toEqual({ status: 'failed', detail: 'cannot reach other.test (off)' });
  });

  it('a client or mailbox changed in the environment: the tokens are not used, and never sent to its endpoints', async () => {
    for (const over of [
      { PHILOBIBLOS_IMAP_OAUTH_TOKEN_URL: 'https://books.test/token' },
      { PHILOBIBLOS_IMAP_OAUTH_CLIENT_ID: 'another-client' },
      { PHILOBIBLOS_IMAP_USER: 'someone-else@shelf.test' },
      { PHILOBIBLOS_IMAP_OAUTH_SCOPE: 'mail.read mail.send offline_access' },
    ]) {
      const db = household();
      await connected(db);
      const cfg = config(over);
      const o = oauthOf(db, cfg);
      clock = new Date(clock.getTime() + 7200_000);
      await expect(o.accessToken()).rejects.toThrow(/changed on the server since it was connected/);
      expect(mailView(db, cfg).oauth).toMatchObject({ connected: false, needsReconnect: true });
      // Disconnecting forgets them without revoking anywhere.
      expect(await o.disconnect()).toEqual({ revoked: false });
      expect(isSealed(db, OAUTH_SEALED)).toBe(false);
    }
    // Each connection's one exchange, and nothing after.
    expect(tokenRequests()).toHaveLength(4);
    expect(provider.requests.filter((r) => r.path === '/revoke')).toHaveLength(0);
  });

  it('a reconnect while an old refresh is in flight: the new tokens get their own refresh', async () => {
    const db = household();
    const o = await connected(db);
    clock = new Date(clock.getTime() + 3600_000);
    let release!: () => void;
    provider.gate = new Promise((ok) => { release = ok; });
    const old = o.accessToken().then(() => null, (e: unknown) => e as Error);
    await expect.poll(() => provider.requests.some((r) => r.path === 'held')).toBe(true);
    // Connected again meanwhile, with an access token that is already out of date.
    provider.next.push({ status: 200, body: { access_token: 'at-new', refresh_token: 'rt-new', token_type: 'Bearer', expires_in: 0 } });
    await o.finish(ME, consent(o.start(ME, { accept: oauthView(db).allowsVersion }).authorizeUrl));
    provider.refresh.add('rt-new');
    const fresh = o.accessToken();
    release();
    expect(await fresh).toMatch(/^at-\d+-a+$/);
    expect((await old)?.message).toMatch(/connected again meanwhile/);
    expect(tokenRequests().map((r) => r.form.get('refresh_token')).filter(Boolean).sort()).toEqual(['rt-1-' + 'r'.repeat(20), 'rt-new']);
  });

  it('a client secret file that cannot be read: said so, nothing sent', async () => {
    const db = enableShop(household());
    await connected(db);
    const cfg = config({ PHILOBIBLOS_IMAP_OAUTH_CLIENT_SECRET: undefined, PHILOBIBLOS_IMAP_OAUTH_CLIENT_SECRET_FILE: '/nonexistent/secret' });
    const o = oauthOf(db, cfg);
    const out = await refreshMail(db, { ...cfg, connectors: CONNECTORS }, { open: async () => fakeBox([]), token: () => o.accessToken() });
    // The fingerprint holds no secret: the same client, its secret now from a file.
    clock = new Date(clock.getTime() + 3600_000);
    expect(out.status).toBe('done');
    const out2 = await refreshMail(db, { ...cfg, connectors: CONNECTORS }, { open: async () => fakeBox([]), token: () => o.accessToken() });
    expect(out2).toEqual({ status: 'blocked', detail: 'cannot read PHILOBIBLOS_IMAP_OAUTH_CLIENT_SECRET_FILE' });
    expect(tokenRequests()).toHaveLength(1);
  });

  it('a sealing key that is wrong: Settings offers to disconnect, which forgets without a key', async () => {
    const db = household();
    await connected(db);
    const cfg = config({ PHILOBIBLOS_SEALING_KEY: 'not base64 of 32 bytes' });
    expect(mailView(db, cfg).oauth).toMatchObject({ connected: false, needsReconnect: true });
    expect(mailView(db, cfg).oauth!.connectBlocked).toMatch(/sealing key/);
    expect(await oauthOf(db, cfg).disconnect()).toEqual({ revoked: false });
    expect(isSealed(db, OAUTH_SEALED)).toBe(false);
  });

  it('not connected: the mail job waits for an admin', async () => {
    const db = enableShop(household());
    const o = oauthOf(db);
    const out = await refreshMail(db, { ...config(), connectors: CONNECTORS }, { open: async () => fakeBox([]), token: () => o.accessToken() });
    expect(out).toEqual({ status: 'blocked', detail: 'the mailbox is not connected: an admin connects it in Settings (Mailbox)' });
  });
});

describe('disconnecting', () => {
  it('forgets the tokens and revokes the refresh token at the provider', async () => {
    const db = household();
    const o = await connected(db);
    expect(await o.disconnect()).toEqual({ revoked: true });
    expect(isSealed(db, OAUTH_SEALED)).toBe(false);
    const revoke = provider.requests.find((r) => r.path === '/revoke')!.form;
    expect(Object.fromEntries(revoke)).toEqual({ token: 'rt-1-' + 'r'.repeat(20), token_type_hint: 'refresh_token', client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    await expect(o.accessToken()).rejects.toThrow(/not connected/);
  });

  it('a revocation that fails still forgets; a provider without an endpoint only forgets', async () => {
    const db = household();
    const o = await connected(db);
    provider.revokeStatus = 503;
    expect(await o.disconnect()).toEqual({ revoked: false });
    expect(isSealed(db, OAUTH_SEALED)).toBe(false);
    const cfg = config({ PHILOBIBLOS_IMAP_OAUTH_REVOKE_URL: undefined });
    const db2 = household();
    const o2 = await connected(db2, oauthOf(db2, cfg), cfg);
    provider.requests = [];
    expect(await o2.disconnect()).toEqual({ revoked: null });
    expect(isSealed(db2, OAUTH_SEALED)).toBe(false);
    expect(provider.requests).toHaveLength(0);
  });

  it('a refresh that finishes after a disconnect writes nothing back', async () => {
    const db = household();
    const o = await connected(db);
    provider.rotate = true;
    clock = new Date(clock.getTime() + 3600_000);
    const pending = o.accessToken().then(() => null, (e: unknown) => e as Error);
    await o.disconnect();
    expect((await pending)?.message).toMatch(/disconnected or connected again meanwhile/);
    expect(isSealed(db, OAUTH_SEALED)).toBe(false);
  });
});

describe('logs', () => {
  it('the provider\'s return is logged without its code and state', () => {
    expect(logUrl('/settings/mail-oauth?code=c-123&state=s-456')).toBe('/settings/mail-oauth');
    expect(logUrl('/settings/mail-oauth/?error=access_denied&state=s')).toBe('/settings/mail-oauth');
    expect(logUrl('/api/month?x=1')).toBe('/api/month?x=1');
  });

  it('the server\'s own log lines of that request hold neither', async () => {
    const web = mkdtempSync(join(tmpdir(), 'philobiblos-web-'));
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>Philobiblos</title>');
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => { lines.push(String(c)); return true; }) as typeof process.stdout.write;
    try {
      const { app } = await buildApp({ ...config(), webDir: web }, household(), { logger: true });
      const r = await app.inject({ url: '/settings/mail-oauth?code=code-in-the-url&state=state-in-the-url' });
      expect(r.statusCode).toBe(200);
      await app.close();
    } finally { process.stdout.write = write; rmSync(web, { recursive: true, force: true }); }
    expect(lines.join('')).toContain('"url":"/settings/mail-oauth"');
    expect(lines.join('')).not.toMatch(/code-in-the-url|state-in-the-url/);
  });
});

describe('the routes: admins, a fresh sign-in to connect, Settings shows what connecting allows', () => {
  let built: BuiltApp, db: Db, admin: string;
  const h = (cookie: string) => ({ cookie, origin: ORIGIN });
  beforeAll(async () => {
    db = household();
    built = await buildApp(config(), db, { mailOAuth: { egressOptions: egressOptions(), now: () => clock } });
    admin = sessionCookie(db, 'p_alex');
  });
  afterAll(() => built.app.close());

  it('Settings: the mailbox, what connecting allows, its version, the redirect URI to register', async () => {
    const s = (await built.app.inject({ url: '/api/settings', headers: { cookie: admin } })).json();
    expect(s.mail).toMatchObject({ host: 'imap.test', port: 993, user: USER, auth: 'xoauth2', configured: true });
    expect(s.mail.oauth).toMatchObject({ redirectUri: `${ORIGIN}${REDIRECT_PATH}`, connected: false, revocable: true, needsReconnect: false });
    expect(s.mail.oauth.allows.join('\n')).toContain('other.test');
    expect(s.mail.oauth.allows.join('\n')).toContain('mail.read offline_access');
    expect(JSON.stringify(s)).not.toContain(CLIENT_SECRET);
  });

  it('connecting through the API; an adult may not; an old sign-in may not start it', async () => {
    const accept = (await built.app.inject({ url: '/api/settings', headers: { cookie: admin } })).json().mail.oauth.allowsVersion;
    const adult = sessionCookie(db, 'p_sam');
    expect((await built.app.inject({ method: 'POST', url: '/api/mail/oauth/start', headers: h(adult), payload: { accept } })).statusCode).toBe(403);
    const old = `philobiblos_session=${createSession(db, 'p_alex', null, new Date(Date.now() - 11 * 60_000)).token}`;
    const stale = await built.app.inject({ method: 'POST', url: '/api/mail/oauth/start', headers: h(old), payload: { accept } });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error).toBe('sign in again to do this');
    // Origin is checked for every change: the redirect cannot be pointed elsewhere by a request.
    const started = await built.app.inject({ method: 'POST', url: '/api/mail/oauth/start', headers: { ...h(admin), host: 'evil.example', 'x-forwarded-host': 'evil.example' }, payload: { accept } });
    expect(started.statusCode).toBe(200);
    const { authorizeUrl } = started.json();
    expect(new URL(authorizeUrl).searchParams.get('redirect_uri')).toBe(`${ORIGIN}${REDIRECT_PATH}`);
    // An adult cannot finish it: refused before the state is even read, so it still works for the admin.
    const early = consent(authorizeUrl);
    expect((await built.app.inject({ method: 'POST', url: '/api/mail/oauth/finish', headers: h(adult), payload: early })).statusCode).toBe(403);
    // The finish from another admin's session is refused (and uses the state up).
    const back = early;
    const otherAdmin = sessionCookie(db, 'p_alex');
    expect((await built.app.inject({ method: 'POST', url: '/api/mail/oauth/finish', headers: h(otherAdmin), payload: back })).statusCode).toBe(400);
    const again = consent((await built.app.inject({ method: 'POST', url: '/api/mail/oauth/start', headers: h(admin), payload: { accept } })).json().authorizeUrl);
    const done = await built.app.inject({ method: 'POST', url: '/api/mail/oauth/finish', headers: h(admin), payload: again });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().oauth.connected).toBe(true);
    expect(done.body).not.toMatch(/rt-|at-|code-/);
    // Disconnecting needs only an admin, never a fresh sign-in.
    expect((await built.app.inject({ method: 'DELETE', url: '/api/mail/oauth', headers: h(adult) })).statusCode).toBe(403);
    const off = await built.app.inject({ method: 'DELETE', url: '/api/mail/oauth', headers: h(old) });
    expect(off.json()).toEqual({ revoked: true });
  });

  it('with an app password, connecting has nothing to do', async () => {
    const d = household();
    const app = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY, PHILOBIBLOS_IMAP_HOST: 'imap.test', PHILOBIBLOS_IMAP_USER: USER, PHILOBIBLOS_IMAP_PASSWORD: 'pw' }), d);
    const c = sessionCookie(d, 'p_alex');
    const s = (await app.app.inject({ url: '/api/settings', headers: { cookie: c } })).json();
    expect(s.mail).toEqual({ host: 'imap.test', port: 993, user: USER, folder: 'INBOX', configured: true, auth: 'password' });
    expect((await app.app.inject({ method: 'POST', url: '/api/mail/oauth/start', headers: h(c), payload: { accept: 'x' } })).statusCode).toBe(409);
    await app.app.close();
  });

  it('under HomersLab connecting waits for the edge\'s recent sign-in (Settings says so)', async () => {
    const cfg = config({ PHILOBIBLOS_MODE: 'homerslab', PHILOBIBLOS_EDGE_IDENTITY: 'homerslab-v1', PHILOBIBLOS_TRUSTED_PROXY: '127.0.0.1', PHILOBIBLOS_ORIGIN: ORIGIN });
    const app = await buildApp(cfg, household(), { mailOAuth: { egressOptions: egressOptions() } });
    const hl = { 'x-homerslab-person': 'hl-alex', 'x-homerslab-name': 'Alex', 'x-homerslab-role': 'admin', origin: ORIGIN };
    const s = (await app.app.inject({ url: '/api/settings', headers: hl })).json();
    expect(s.mail.oauth.connectBlocked).toMatch(/recent sign-in/);
    expect((await app.app.inject({ method: 'POST', url: '/api/mail/oauth/start', headers: hl, payload: { accept: s.mail.oauth.allowsVersion } })).statusCode).toBe(403);
    await app.app.close();
  });
});
