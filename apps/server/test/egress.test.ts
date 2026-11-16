// The one HTTP client (ADR 0009) against hostile servers: local ones here, made by the test (fixtures/tls is a
// certificate for *.test names only, made for these tests). Nothing in this file reaches the internet.
import { once } from 'node:events';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_HOSTS } from '../src/push/push';
import { ARCHIVE_NODE, EgressError, LIMITS, USER_AGENT, createEgress, egressRules, isPublicAddress, type Rule } from '../src/net/egress';

const tls = (f: string) => readFileSync(new URL(`./fixtures/tls/${f}`, import.meta.url), 'utf8');
const CA = tls('cert.pem');

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let routes: Record<string, Handler> = {};
let seen: { host: string; url: string; headers: http.IncomingHttpHeaders }[] = [];
const handler: Handler = (req, res) => {
  seen.push({ host: String(req.headers.host), url: req.url ?? '', headers: req.headers });
  const h = routes[`${String(req.headers.host).split(':')[0]}${req.url}`] ?? routes[req.url ?? ''];
  if (h) h(req, res); else { res.statusCode = 404; res.end(); }
};
let plain: http.Server, secure: https.Server, hport = 0, sport = 0;
beforeAll(async () => {
  plain = http.createServer(handler).listen(0, '127.0.0.1');
  secure = https.createServer({ key: tls('key.pem'), cert: CA }, handler).listen(0, '127.0.0.1');
  await Promise.all([once(plain, 'listening'), once(secure, 'listening')]);
  hport = (plain.address() as AddressInfo).port;
  sport = (secure.address() as AddressInfo).port;
});
afterAll(() => { plain.close(); secure.close(); });
const reset = (r: Record<string, Handler>) => { routes = r; seen = []; };

const local = async () => [{ address: '127.0.0.1', family: 4 }];
/** A household host (Ollama-like): plain http, private address allowed. */
const books = (): Rule => ({ host: 'books.test', scheme: 'http', port: hport, privateOk: true });
const client = (rules: Rule[], extra: Parameters<typeof createEgress>[0]['test'] = {}, timeoutMs?: number) =>
  createEgress({ rules, resolve: local, timeoutMs, test: { ca: CA, ...extra } });
const json = (body: unknown, type = 'application/json'): Handler => (_q, r) => { r.setHeader('content-type', type); r.end(JSON.stringify(body)); };
const redirect = (to: string): Handler => (_q, r) => { r.statusCode = 302; r.setHeader('location', to); r.end(); };
const fails = async (p: Promise<unknown>, reason: EgressError['reason']) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e, `expected ${reason}`).toBeInstanceOf(EgressError);
  expect((e as EgressError).reason).toBe(reason);
  return e as EgressError;
};

describe('what may be reached', () => {
  it('the manifest\'s hosts; Ollama only when configured; Claude only on the opt-in', () => {
    expect(egressRules({}).map((r) => r.host)).toEqual(['www.orellfuessli.ch', 'openlibrary.org', 'covers.openlibrary.org']);
    expect(egressRules({ ollamaUrl: 'http://ollama:11434' }).at(-1)).toEqual({ host: 'ollama', scheme: 'http', port: 11434, privateOk: true });
    expect(egressRules({ claude: true }).map((r) => r.host)).toContain('api.anthropic.com');
    expect(egressRules({}).filter((r) => r.privateOk || r.redirectTo).map((r) => r.host)).toEqual(['covers.openlibrary.org']);
  });

  it('the manifest names the same hosts', () => {
    const manifest = readFileSync(new URL('../../../contracts/homerslab-app.yaml', import.meta.url), 'utf8');
    for (const h of egressRules({}).map((r) => r.host)) expect(manifest).toContain(h);
    expect(manifest).toMatch(/egress_redirects: \[archive\.org, 'ia<number>\.us\.archive\.org'\]/);
    // The push client's default hosts (push/hosts.ts) are named too, and nothing more.
    const push = /push_egress: \[([^\]]*)\]/.exec(manifest)![1]!.split(',').map((h) => h.trim().replace(/'/g, ''));
    expect(push).toEqual(DEFAULT_PUSH_HOSTS);
  });

  it.each([
    ['93.184.215.14', true], ['2606:4700::1111', true], ['10.1.2.3', false], ['127.0.0.1', false], ['169.254.169.254', false],
    ['172.21.1.11', false], ['192.168.1.1', false], ['100.64.0.1', false], ['0.0.0.0', false], ['224.0.0.1', false],
    ['::1', false], ['fe80::1', false], ['fd00::1', false], ['::ffff:10.0.0.1', false], ['::ffff:93.184.215.14', true], ['2001:db8::1', false],
    ['2002:a00:1::', false], ['3fff::1', false], ['2001:2::1', false], ['2001:0:4136:e378::1', false], ['2001:20::1', false], ['not an address', false],
  ])('%s public: %s', (a, want) => expect(isPublicAddress(a)).toBe(want));

  it('a host not on the list, another scheme or port, credentials in the URL: refused before any lookup', async () => {
    const c = client([books()]);
    await fails(c.get('http://other.test/', 'json'), 'not-allowed');
    await fails(c.get(`https://books.test:${hport}/`, 'json'), 'not-allowed');
    await fails(c.get('http://books.test:1/', 'json'), 'not-allowed');
    await fails(c.get(`http://u:p@books.test:${hport}/`, 'json'), 'not-allowed');
    await fails(createEgress({ rules: [books()], enabled: false }).get(`http://books.test:${hport}/`, 'json'), 'off');
  });

  it('a public host that resolves to a private address (or to a mix) is never connected to', async () => {
    reset({ '/': json({}) });
    const rule: Rule = { host: 'books.test', port: sport };
    for (const answer of [[{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.1', family: 4 }]]) {
      const c = createEgress({ rules: [rule], resolve: async () => answer, test: { ca: CA } });
      await fails(c.get(`https://books.test:${sport}/`, 'json'), 'private-address');
    }
    expect(seen).toEqual([]);
  });
});

describe('answers are held to limits', () => {
  it('JSON comes back, with Philobiblos\'s User-Agent, no cookies and no compression asked for', async () => {
    reset({ '/a': json({ ok: 1 }, 'application/json; charset=utf-8') });
    const r = await client([books()]).get(`http://books.test:${hport}/a`, 'json');
    expect(JSON.parse(r.body.toString())).toEqual({ ok: 1 });
    expect(seen[0]!.headers['user-agent']).toBe(USER_AGENT);
    expect(seen[0]!.headers['accept-encoding']).toBe('identity');
    expect(seen[0]!.headers.cookie).toBeUndefined();
    expect(USER_AGENT).toMatch(/^Philobiblos\/\d/);
  });

  it('the wrong content type is refused (a page where JSON was asked for, an SVG for an image)', async () => {
    reset({ '/page': json({}, 'text/html'), '/svg': (_q, r) => { r.setHeader('content-type', 'image/svg+xml'); r.end('<svg/>'); } });
    await fails(client([books()]).get(`http://books.test:${hport}/page`, 'json'), 'type');
    await fails(client([books()]).get(`http://books.test:${hport}/svg`, 'image'), 'type');
  });

  it('too large: by its header, or as it streams without one', async () => {
    reset({
      '/big': (_q, r) => { r.setHeader('content-type', 'application/json'); r.setHeader('content-length', String(LIMITS.json + 1)); r.end(); },
      '/stream': (_q, r) => { r.setHeader('content-type', 'application/json'); const chunk = Buffer.alloc(64 * 1024, 0x20); const send = () => { if (r.write(chunk)) setImmediate(send); else r.once('drain', send); }; send(); },
    });
    await fails(client([books()]).get(`http://books.test:${hport}/big`, 'json'), 'too-large');
    await fails(client([books()]).get(`http://books.test:${hport}/stream`, 'json'), 'too-large');
  });

  it('compressed content is refused (no decompression bombs)', async () => {
    reset({ '/gz': (_q, r) => { r.setHeader('content-type', 'application/json'); r.setHeader('content-encoding', 'gzip'); r.end('x'); } });
    await fails(client([books()]).get(`http://books.test:${hport}/gz`, 'json'), 'encoding');
  });

  it('one deadline for the whole exchange: a server that trickles is cut off', async () => {
    reset({ '/slow': (_q, r) => { r.setHeader('content-type', 'application/json'); r.write('['); const t = setInterval(() => r.write(' '), 50); r.on('close', () => clearInterval(t)); } });
    const t = Date.now();
    await fails(client([books()], {}, 300).get(`http://books.test:${hport}/slow`, 'json'), 'timeout');
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('an error status is an error, with the status', async () => {
    reset({ '/no': (_q, r) => { r.statusCode = 403; r.end(); } });
    expect((await fails(client([books()]).get(`http://books.test:${hport}/no`, 'html'), 'status')).status).toBe(403);
  });
});

describe('bodies nobody wants are never read', () => {
  /** A server that answers `status` and then sends forever; how much it sent, and whether the connection closed. */
  const endless = (status: number, headers: Record<string, string> = {}) => {
    const st = { sent: 0, closed: false };
    const h: Handler = (_q, r) => {
      r.writeHead(status, { 'content-type': 'text/html', ...headers });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const send = () => { if (r.destroyed) return; st.sent += chunk.length; if (r.write(chunk)) setImmediate(send); else r.once('drain', send); };
      r.on('close', () => { st.closed = true; });
      send();
    };
    return { st, h };
  };

  it.each([
    ['an error status (the bookshop\'s 403)', () => endless(403)],
    ['a redirect off the host', () => endless(302, { location: 'http://other.test/' })],
  ])('%s with an endless body: the connection is closed, not drained', async (_n, make) => {
    const { st, h } = make();
    reset({ '/e': h });
    await client([books()]).get(`http://books.test:${hport}/e`, 'html').catch(() => null);
    await new Promise((r) => setTimeout(r, 300));
    expect(st.closed).toBe(true);
    const at = st.sent;
    await new Promise((r) => setTimeout(r, 300));
    expect(st.sent).toBe(at);
    expect(st.sent).toBeLessThan(16 << 20);
  });

  it('a lookup that never answers is cut off by the same deadline', async () => {
    const c = createEgress({ rules: [books()], resolve: () => new Promise(() => {}), timeoutMs: 200 });
    const t = Date.now();
    await fails(c.get(`http://books.test:${hport}/`, 'json'), 'timeout');
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe('a push message (Web Push)', () => {
  const pushRule = (): Rule => ({ host: 'other.test' });
  const pusher = (timeoutMs?: number) => client([pushRule()], { isPublic: () => true, httpsPort: sport }, timeoutMs);
  it('its bytes as application/octet-stream; only the status comes back, the body is never read', async () => {
    reset({ '/p': (q, r) => { let n = 0; q.on('data', (c: Buffer) => { n += c.length; }); q.on('end', () => { r.statusCode = 201; r.setHeader('x-got', String(n)); r.end('x'.repeat(5 << 20)); }); } });
    const res = await pusher().push('https://other.test/p', Buffer.from('cipher'), { headers: { ttl: '60' } });
    expect(res).toMatchObject({ status: 201, body: Buffer.alloc(0) });
    expect(seen[0]!.headers).toMatchObject({ 'content-type': 'application/octet-stream', 'content-length': '6', ttl: '60', 'user-agent': USER_AGENT });
  });
  it('an error status carries its status (404, 410: the device is gone); a redirect is refused', async () => {
    reset({ '/gone': (_q, r) => { r.statusCode = 410; r.end(); }, '/moved': redirect('https://other.test/p') });
    expect((await fails(pusher().push('https://other.test/gone', Buffer.from('x'), { headers: {} }), 'status')).status).toBe(410);
    await fails(pusher().push('https://other.test/moved', Buffer.from('x'), { headers: {} }), 'redirect');
  });
  it('the same deadline as a GET: a push service that never answers is cut off', async () => {
    reset({ '/hang': () => {} });
    const t = Date.now();
    await fails(pusher(300).push('https://other.test/hang', Buffer.from('x'), { headers: {} }), 'timeout');
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('redirects', () => {
  it('on the same host: followed, at most 3', async () => {
    reset({ '/1': redirect('/2'), '/2': json({ at: 2 }), '/r0': redirect('/r1'), '/r1': redirect('/r2'), '/r2': redirect('/r3'), '/r3': redirect('/r4'), '/r4': json({}) });
    expect(JSON.parse((await client([books()]).get(`http://books.test:${hport}/1`, 'json')).body.toString())).toEqual({ at: 2 });
    await fails(client([books()]).get(`http://books.test:${hport}/r0`, 'json'), 'redirect');
  });

  it('to another host, even one on the list: refused', async () => {
    reset({ '/away': redirect(`http://other.test:${hport}/`) });
    await fails(client([books(), { host: 'other.test', scheme: 'http', port: hport, privateOk: true }]).get(`http://books.test:${hport}/away`, 'json'), 'redirect');
    expect(seen.map((s) => s.host.split(':')[0])).toEqual(['books.test']);
  });

  const covers = (): Rule => ({ host: 'covers.test', redirectTo: ['archive.test', /^ia\d{3,8}\.us\.archive\.test$/], crossHost: 2 });
  const img: Handler = (_q, r) => { r.setHeader('content-type', 'image/jpeg'); r.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); };
  // The test's TLS server stands in for every *.test host on 443; all count as public.
  const cc = () => createEgress({ rules: [covers()], resolve: local, test: { ca: CA, isPublic: () => true, httpsPort: sport } });

  it('covers: to the archive, then its data node, https only, each hop looked up and checked again', async () => {
    reset({ 'covers.test/b/id/1-L.jpg': redirect('https://archive.test/download/x.jpg'), 'archive.test/download/x.jpg': redirect('https://ia123.us.archive.test/view?f=x.jpg'), 'ia123.us.archive.test/view?f=x.jpg': img });
    const r = await cc().get('https://covers.test/b/id/1-L.jpg', 'image');
    expect(r.url).toBe('https://ia123.us.archive.test/view?f=x.jpg');
    expect(seen.map((x) => x.host.split(':')[0])).toEqual(['covers.test', 'archive.test', 'ia123.us.archive.test']);
  });

  it.each([
    ['a host off the list', { 'covers.test/c': redirect('https://other.test/x') }],
    ['over http', { 'covers.test/c': redirect(`http://archive.test:${hport}/x`) }],
    ['over http on its default port', { 'covers.test/c': redirect('http://archive.test/x') }],
    ['on another port', { 'covers.test/c': redirect(`https://archive.test:${sport}/x`) }],
    ['a third host', { 'covers.test/c': redirect('https://archive.test/a'), 'archive.test/a': redirect('https://ia123.us.archive.test/b'), 'ia123.us.archive.test/b': redirect('https://archive.test/c') }],
  ])('covers: %s is refused', async (_n, r) => {
    reset({ ...r, '/x': img });
    await fails(cc().get('https://covers.test/c', 'image'), 'redirect');
  });

  it('covers: a hop that resolves to a private address is refused', async () => {
    reset({ 'covers.test/c': redirect('https://archive.test/x'), 'archive.test/x': img });
    const resolve = async (h: string) => [{ address: h === 'archive.test' ? '10.0.0.1' : '127.0.0.1', family: 4 }];
    const c = createEgress({ rules: [covers()], resolve, test: { ca: CA, isPublic: (a) => a === '127.0.0.1', httpsPort: sport } });
    await fails(c.get('https://covers.test/c', 'image'), 'private-address');
    expect(seen.map((x) => x.host.split(':')[0])).toEqual(['covers.test']);
  });

  it('covers: a target off the list, over http, or a third hop is refused', () => {
    const rule = egressRules({}).find((r) => r.host === 'covers.openlibrary.org')!;
    expect(rule.crossHost).toBe(2);
    expect(rule.redirectTo).toEqual(['archive.org', ARCHIVE_NODE]);
    for (const h of ['ia902809.us.archive.org', 'ia800.us.archive.org']) expect(ARCHIVE_NODE.test(h)).toBe(true);
    for (const h of ['evil.archive.org', 'ia1.us.archive.org.evil.test', 'ia123.us.archive.org.evil.test', 'xia902809.us.archive.org', 'ia902809.eu.archive.org', 'web.archive.org']) expect(ARCHIVE_NODE.test(h), h).toBe(false);
  });
});

describe('the egress boundary (architecture)', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'node_modules' || f === 'dist' ? [] : files(p);
    return /\.(ts|mjs|js)$/.test(f) ? [p] : [];
  });
  it('nothing outside src/net opens a connection: no fetch, http(s), net or tls client, no undici', () => {
    const src = [join(root, 'apps/server/src'), ...readdirSync(join(root, 'packages')).map((d) => join(root, 'packages', d, 'src'))].flatMap((d) => { try { return files(d); } catch { return []; } });
    expect(src.length).toBeGreaterThan(30);
    const re = /\bfetch\s*\(|from\s+['"](?:node:)?(?:http|https|net|tls|http2|dgram)['"]|require\(\s*['"](?:node:)?(?:http|https|net|tls)['"]|from\s+['"](?:undici|axios|got|node-fetch)['"]|import\(\s*['"](?:node:)?(?:http|https|net|tls)['"]/;
    const offenders = src.filter((f) => !f.startsWith(join(root, 'apps/server/src/net/')) && re.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f));
    expect(offenders).toEqual([]);
  });
});
