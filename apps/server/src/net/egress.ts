// The one HTTP client of the whole app (ADR 0009, docs/security.md). Nothing else in apps/server or packages opens a
// connection (test/egress.test.ts keeps it so): every outgoing request names a host on the allowlist below, and the
// answer is held to a size, a time and a content type before anyone reads it.
//
// - Only allowlisted hosts, by name; https only, unless a rule says otherwise (Ollama on the home network).
// - The name is resolved here and the connection goes to the address that was checked (no second lookup a DNS
//   rebinding could change); a public host must resolve to public addresses only, so a poisoned or hostile DNS
//   answer cannot point Shelf at the router, the HomersLab edge or a container next to it.
// - Redirects: at most 3, to the same host, or to a host the rule names as a redirect target (covers only); never to
//   another scheme.
// - No compression (a decompression bomb is not possible), a byte limit counted as the body arrives, one deadline for
//   the whole exchange including redirects, and the content type checked against what the caller expects.
// - No cookies, no credentials, a User-Agent that says what Shelf is and nothing about the household.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { VERSION } from '../version';

export interface Rule {
  host: string;
  /** Default https. */
  scheme?: 'https' | 'http';
  port?: number;
  /** True only for a host the household runs itself (Ollama): it may be a private address. */
  privateOk?: boolean;
  /**
   * Other hosts a redirect from this one may go to: exact names, or a pattern anchored on both ends. https only, each
   * hop checked again (allowlist, public addresses), and no more than `crossHost` such hops (default 0: none).
   */
  redirectTo?: (string | RegExp)[];
  crossHost?: number;
}

export type Want = 'json' | 'html' | 'image';
export const LIMITS: Record<Want, number> = { json: 1 << 20, html: 1 << 20, image: 5 << 20 };
export const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const TYPES: Record<Want, RegExp> = { json: /^application\/(?:[a-z.+-]*\+)?json$/, html: /^text\/html$/, image: /^image\/(?:jpeg|png|webp|gif)$/ };
export const USER_AGENT = `Shelf/${VERSION} (self-hosted household reading app; https://github.com/ArjunRachithcf/shelf)`;

export interface Response { status: number; type: string; body: Buffer; url: string }

/** Why a request did not happen or was cut off. `status` is the answer's when there was one. */
export class EgressError extends Error {
  constructor(readonly reason: 'off' | 'not-allowed' | 'private-address' | 'redirect' | 'too-large' | 'timeout' | 'type' | 'encoding' | 'status' | 'network', message: string, readonly status?: number) {
    super(message);
    this.name = 'EgressError';
  }
}

export interface Egress {
  get(url: string, want: Want, opts?: { headers?: Record<string, string> }): Promise<Response>;
  /**
   * A JSON request to an AI provider (Ollama, Claude): never redirected (a redirect is refused), the request body at
   * most POST_MAX bytes, the answer JSON within LIMITS.json, and its own deadline (a local model may take minutes).
   */
  post(url: string, body: Buffer, opts: { headers?: Record<string, string>; timeoutMs: number }): Promise<Response>;
}

/** The largest request body Shelf sends (an AI job's images, base64, with its prompt). */
export const POST_MAX = 32 << 20;

/** What may be reached: the manifest's egress list (contracts/homerslab-app.yaml), Ollama if configured, Claude on opt-in. */
export function egressRules(o: { ollamaUrl?: string | null; claude?: boolean }): Rule[] {
  const rules: Rule[] = [
    { host: 'www.orellfuessli.ch' },
    { host: 'openlibrary.org' },
    // Cover images are kept by the Internet Archive: covers.openlibrary.org redirects to archive.org, which redirects
    // to the data node holding the file (ia<number>.us.archive.org). Those two, nothing else under archive.org.
    { host: 'covers.openlibrary.org', redirectTo: ['archive.org', ARCHIVE_NODE], crossHost: 2 },
  ];
  if (o.ollamaUrl) {
    const u = new URL(o.ollamaUrl);
    rules.push({ host: u.hostname, scheme: u.protocol === 'http:' ? 'http' : 'https', port: u.port ? Number(u.port) : undefined, privateOk: true });
  }
  if (o.claude) rules.push({ host: 'api.anthropic.com' });
  return rules;
}

/**
 * The whole allowlist of an AI job's own client: the household's Ollama, or Claude's API after the opt-in, and nothing
 * else. An AI request can never reach a book site, nor one provider's data the other.
 */
export function aiEgressRules(provider: 'ollama' | 'claude', ollamaUrl: string | null): Rule[] {
  if (provider === 'claude') return [{ host: 'api.anthropic.com' }];
  return ollamaUrl ? egressRules({ ollamaUrl }).filter((r) => r.privateOk === true) : [];
}

// Addresses that are not the public internet (IANA special-purpose registries).
const blocked = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(net, bits, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
// IANA's IPv6 special-purpose registry within 2000::/3: the IETF protocol assignments (2001::/23: Teredo, benchmarking
// 2001:2::/48, ORCHID, AMT, …), documentation (2001:db8::/32 and 3fff::/20, RFC 9637) and 6to4 (2002::/16).
for (const [net, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blockedV6.addSubnet(net, bits, 'ipv6');

/** True for an address on the public internet. IPv6 must be global unicast; a v4-mapped address counts as its v4. */
export function isPublicAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) return !blocked.check(addr, 'ipv4');
  if (v !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) return isPublicAddress(mapped[1]!);
  return globalV6.check(addr, 'ipv6') && !blockedV6.check(addr, 'ipv6');
}

/** The Internet Archive's data nodes, where a cover's bytes are. */
export const ARCHIVE_NODE = /^ia\d{3,8}\.us\.archive\.org$/;
const hostMatches = (pattern: string | RegExp, host: string) => (typeof pattern === 'string' ? host === pattern : pattern.test(host));

export type Resolve = (host: string) => Promise<LookupAddress[]>;
const systemResolve: Resolve = (host) => new Promise((ok, fail) => dnsLookup(host, { all: true, verbatim: true }, (e, a) => (e ? fail(e) : ok(a))));

export interface EgressOptions {
  rules: Rule[];
  /** false: nothing leaves (SHELF_EGRESS=off). */
  enabled?: boolean;
  resolve?: Resolve;
  timeoutMs?: number;
  /** The longest a POST may take, whatever its caller asks (default POST_TIMEOUT_MAX_MS). */
  postMaxMs?: number;
  /** Tests only: a CA to trust besides the system's, and who counts as public (their servers are on 127.0.0.1). */
  test?: { ca?: string; isPublic?: (addr: string) => boolean; httpsPort?: number };
}

export function createEgress(o: EgressOptions): Egress {
  const resolve = o.resolve ?? systemResolve;
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  const isPublic = o.test?.isPublic ?? isPublicAddress;

  function ruleFor(u: URL): Rule | null {
    const scheme = u.protocol.slice(0, -1);
    return o.rules.find((r) => r.host === u.hostname && (r.scheme ?? 'https') === scheme && (r.port == null ? u.port === '' : Number(u.port || (scheme === 'https' ? 443 : 80)) === r.port)) ?? null;
  }

  async function addressFor(host: string, privateOk: boolean, signal: AbortSignal): Promise<LookupAddress> {
    let all: LookupAddress[];
    // The lookup is inside the deadline too: a resolver that never answers is cut off with the rest.
    const aborted = new Promise<never>((_, fail) => {
      if (signal.aborted) fail(new EgressError('timeout', `${host} took too long`));
      signal.addEventListener('abort', () => fail(new EgressError('timeout', `${host} took too long`)), { once: true });
    });
    aborted.catch(() => {});
    try { all = await Promise.race([resolve(host), aborted]); } catch (e) { throw e instanceof EgressError ? e : new EgressError('network', `cannot resolve ${host}`); }
    if (!all.length) throw new EgressError('network', `cannot resolve ${host}`);
    // Every answer must be public, not just the first: a mixed answer is a rebinding attempt.
    if (!privateOk && all.some((a) => !isPublic(a.address))) throw new EgressError('private-address', `${host} resolves to a private address`);
    return all[0]!;
  }

  function once(u: URL, rule: Rule, want: Want, headers: Record<string, string>, signal: AbortSignal, body?: Buffer): Promise<{ res: http.IncomingMessage; addr: LookupAddress }> {
    return addressFor(u.hostname, rule.privateOk === true, signal).then((addr) => new Promise((ok, fail) => {
      // The connection goes to the address checked above; the name stays for TLS (SNI and the certificate).
      const lookup: LookupFunction = (_h, opts, cb) => {
        if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, [addr]);
        else cb(null, addr.address, addr.family);
      };
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(u, {
        ...(o.test?.httpsPort && u.protocol === 'https:' && !u.port ? { port: o.test.httpsPort } : {}),
        method: body ? 'POST' : 'GET', lookup, signal, agent: false, ...(o.test?.ca ? { ca: o.test.ca } : {}),
        headers: {
          ...headers, 'user-agent': USER_AGENT, accept: want === 'json' ? 'application/json' : want === 'html' ? 'text/html' : 'image/*', 'accept-encoding': 'identity',
          ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}),
        },
      }, (res) => ok({ res, addr }));
      req.on('error', (e) => fail(signal.aborted ? new EgressError('timeout', `${u.hostname} took too long`) : new EgressError('network', `${u.hostname}: ${(e as NodeJS.ErrnoException).code ?? 'request failed'}`)));
      req.end(body);
    }));
  }

  async function exchange(url: string, want: Want, headers: Record<string, string>, deadline: number, body?: Buffer): Promise<Response> {
      if (o.enabled === false) throw new EgressError('off', 'outgoing requests are turned off (SHELF_EGRESS=off)');
      let u = new URL(url);
      const first = ruleFor(u);
      if (!first || u.username || u.password) throw new EgressError('not-allowed', `${u.protocol}//${u.host} is not on the egress allowlist`);
      if (body && body.length > POST_MAX) throw new EgressError('too-large', `a request body over ${POST_MAX} bytes is not sent`);
      let rule = first;
      let crossed = 0;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), deadline);
      try {
        for (let hop = 0; ; hop++) {
          const { res } = await once(u, rule, want, headers, ctl.signal, body);
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            // Never read a body nobody wants: the connection is closed, not drained.
            res.destroy();
            // A request with a body is never sent on to another address, the same host's included.
            if (body) throw new EgressError('redirect', 'a redirect of a request with a body is refused');
            if (hop >= MAX_REDIRECTS) throw new EgressError('redirect', `more than ${MAX_REDIRECTS} redirects`);
            const next = new URL(res.headers.location, u);
            const sameHost = next.hostname === u.hostname && next.protocol === u.protocol && next.port === u.port;
            const allowedTarget = next.protocol === 'https:' && !next.port && crossed < (first.crossHost ?? 0) && (first.redirectTo ?? []).some((p) => hostMatches(p, next.hostname));
            if ((!sameHost && !allowedTarget) || next.username || next.password) throw new EgressError('redirect', `redirect to ${next.protocol}//${next.host} refused`);
            if (!sameHost) { rule = { host: next.hostname }; crossed++; }
            u = next;
            continue;
          }
          const encoding = String(res.headers['content-encoding'] ?? 'identity').toLowerCase();
          if (encoding !== 'identity') { res.destroy(); throw new EgressError('encoding', `${u.hostname} sent ${encoding} content`); }
          const type = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
          if (status < 200 || status >= 300) { res.destroy(); throw new EgressError('status', `${u.hostname} answered ${status}`, status); }
          if (!TYPES[want].test(type)) { res.destroy(); throw new EgressError('type', `${u.hostname} sent ${type || 'no content type'}, not ${want}`); }
          const limit = LIMITS[want];
          if (Number(res.headers['content-length'] ?? 0) > limit) { res.destroy(); throw new EgressError('too-large', `${u.hostname} sent more than ${limit} bytes`); }
          const chunks: Buffer[] = [];
          let size = 0;
          try {
            for await (const c of res as AsyncIterable<Buffer>) {
              size += c.length;
              if (size > limit) { res.destroy(); throw new EgressError('too-large', `${u.hostname} sent more than ${limit} bytes`); }
              chunks.push(c);
            }
          } catch (e) {
            if (e instanceof EgressError) throw e;
            throw ctl.signal.aborted ? new EgressError('timeout', `${u.hostname} took too long`) : new EgressError('network', `${u.hostname}: the answer broke off`);
          }
          return { status, type, body: Buffer.concat(chunks), url: u.toString() };
        }
      } finally {
        clearTimeout(timer);
      }
  }

  return {
    get: (url, want, opts = {}) => exchange(url, want, opts.headers ?? {}, timeoutMs),
    post: (url, body, opts) => exchange(url, 'json', opts.headers ?? {}, Math.min(opts.timeoutMs, o.postMaxMs ?? POST_TIMEOUT_MAX_MS), body),
  };
}

/** No AI request waits longer than this, whatever its caller asks. */
export const POST_TIMEOUT_MAX_MS = 300_000;
