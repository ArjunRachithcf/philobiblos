// The mail-domain rule, standalone (ADR 0011, philobiblos#34 slice 4a): SMTP and the 6-digit code. The code is random,
// bound to the request that asked for it, kept only as an HMAC keyed by HKDF-SHA-256 of the sealing key (info
// "join-code"), 10 minutes, 5 tries, one live code an address; sends are limited per address, link and household, and
// every request gets the same answer whether a mail went out or not. Codes go to a capture here, or to the local SMTP
// server (smtpd.ts); no mail leaves this machine. Every name, address and domain is invented.
import { createHmac, hkdfSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { JOIN_CODE, askCode, checkCode, codeKey, pruneCodes, requestHash, takeVerified } from '../src/household/join-code';
import { approve, decline, lapseWaiting } from '../src/household/waiting';
import { WAITING } from '../src/household/waiting-rows';
import { egressRules } from '../src/net/egress';
import type { Surroundings } from '../src/net/networks';
import { NOT_HERE, WRONG_CODE } from '../src/routes/join';
import { ORIGIN, TEST_SEALING_KEY, fakeWebAuthn, household, nowherePush, sessionCookie } from './helpers';
import { SMTPD_CA, SMTPD_HOST, SMTPD_PASS, SMTPD_USER, smtpd, type Smtpd } from './smtpd';

const SMTP = { PHILOBIBLOS_SMTP_HOST: SMTPD_HOST, PHILOBIBLOS_SMTP_USER: SMTPD_USER, PHILOBIBLOS_SMTP_PASSWORD: SMTPD_PASS, PHILOBIBLOS_SMTP_FROM: 'codes@example.org' };
const base = { PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY };
const withSmtp = (more: Record<string, string> = {}) => loadConfig({ ...base, ...SMTP, ...more });
const noSmtp = () => loadConfig(base);

const HOME = '10.20.0.0/16';
const IN_HOME = '10.20.1.5';
const DOMAIN = 'example.org';
const HOST: Surroundings = { container: false, known: true, hops: [], onLink: [] };

interface Sent { to: string; code: string }
let open: (BuiltApp | Smtpd)[] = [];
afterEach(async () => { for (const b of open) await ('app' in b ? b.app.close() : b.close()); open = []; });

async function app(cfg: Config = withSmtp(), db = household(), send?: (to: string, code: string) => Promise<void>) {
  const sent: Sent[] = [];
  const b = await buildApp(cfg, db, { webauthn: fakeWebAuthn(), push: nowherePush, joinFloorMs: 0, surroundings: HOST, sendCode: send ?? (async (to, code) => { sent.push({ to, code }); }) });
  await b.app.ready();
  open.push(b);
  db.insert(t.homeNetwork).values({ cidr: HOME, addedBy: 'p_alex', addedAt: new Date().toISOString() }).run();
  return { ...b, db, sent };
}
type From = { remote?: string; cookie?: string };
const post = (a: BuiltApp['app'], url: string, payload: object, o: From = {}) => a.inject({
  method: 'POST', url, payload, remoteAddress: o.remote ?? IN_HOME, headers: { origin: ORIGIN, ...(o.cookie ? { cookie: o.cookie } : {}) },
});
async function makeLink(a: BuiltApp['app'], db: Db, body: object = { accept: 'automatic', mailDomain: DOMAIN }) {
  const res = await post(a, '/api/people/join-links', body, { cookie: sessionCookie(db, 'p_alex') });
  expect(res.statusCode, res.body).toBe(201);
  const { id, url } = res.json() as { id: string; url: string };
  return { id, token: url.split('#')[1]! };
}
const ask = (a: BuiltApp['app'], token: string, address: string, from: From = {}) => post(a, '/api/join/code', { token, address }, from);
const tryCode = (a: BuiltApp['app'], request: string, code: string, from: From = {}) => post(a, '/api/join/code/check', { request, code }, from);
async function join(a: BuiltApp['app'], token: string, name: string, request?: string, from: From = {}) {
  const o = await post(a, '/api/join/options', { token, name, ...(request ? { request } : {}) }, from);
  if (o.statusCode !== 200) return o;
  const s = o.json() as { challengeId: string; options: { challenge: string } };
  return post(a, '/api/join/verify', { challengeId: s.challengeId, response: { id: `cred-${name}-${Math.random()}`, challenge: s.options.challenge }, label: 'Phone' }, from);
}
/** Asks, then proves the code that was sent: the request token. */
async function prove(b: Awaited<ReturnType<typeof app>>, token: string, address: string, from: From = {}) {
  const r = await ask(b.app, token, address, from);
  expect(r.statusCode).toBe(200);
  const sent = b.sent.at(-1)!;
  expect(sent.to).toBe(address);
  expect((await tryCode(b.app, r.json().request, sent.code, from)).statusCode).toBe(204);
  return r.json().request as string;
}
/** Every text and blob in the database, for "it is nowhere". */
function everything(db: Db): string {
  const tables = (db as unknown as { $client: { prepare(s: string): { all(): Record<string, unknown>[] } } }).$client
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name));
  return tables.map((n) => JSON.stringify((db as unknown as { $client: { prepare(s: string): { all(): unknown[] } } }).$client.prepare(`SELECT * FROM "${n}"`).all(),
    (_k, v) => (v && typeof v === 'object' && (v as { type?: string }).type === 'Buffer' ? Buffer.from((v as { data: number[] }).data).toString('latin1') : v))).join('\n');
}
const sameAnswer = (res: { statusCode: number; json(): unknown }) => {
  expect(res.statusCode).toBe(200);
  expect(Object.keys(res.json() as object)).toEqual(['request']);
  expect((res.json() as { request: string }).request).toMatch(/^[A-Za-z0-9_-]{43}$/);
};

describe('PHILOBIBLOS_SMTP_*: off by default, TLS only, the password from the environment or a file', () => {
  it('unset: no SMTP, and no list read', () => {
    expect(noSmtp().smtp).toBeNull();
    expect(noSmtp().publicMailDomains.size).toBe(0);
  });

  it('set: every part, port 465 by default, the public providers\' list that ships', () => {
    const c = withSmtp();
    expect(c.smtp).toEqual({ host: SMTPD_HOST, port: 465, user: SMTPD_USER, password: { value: SMTPD_PASS }, from: 'codes@example.org', caFile: null });
    expect(withSmtp({ PHILOBIBLOS_SMTP_PORT: '2465', PHILOBIBLOS_SMTP_PASSWORD: '', PHILOBIBLOS_SMTP_PASSWORD_FILE: '/run/secrets/smtp' }).smtp).toMatchObject({ port: 2465, password: { file: '/run/secrets/smtp' } });
    // The list is data (mail-providers/public-domains.txt), never code: the core names no provider.
    expect(c.publicMailDomains.size).toBeGreaterThan(30);
  });

  it('a part without the host, a missing part, both passwords, a display name, or under HomersLab: Philobiblos does not start', () => {
    expect(() => loadConfig({ ...base, PHILOBIBLOS_SMTP_USER: 'x' })).toThrow(/PHILOBIBLOS_SMTP_HOST is not/);
    expect(() => withSmtp({ PHILOBIBLOS_SMTP_FROM: '' })).toThrow(/PHILOBIBLOS_SMTP_FROM/);
    expect(() => withSmtp({ PHILOBIBLOS_SMTP_PASSWORD_FILE: '/x' })).toThrow(/not both/);
    expect(() => withSmtp({ PHILOBIBLOS_SMTP_PASSWORD: '' })).toThrow(/PHILOBIBLOS_SMTP_PASSWORD/);
    for (const from of ['Codes <codes@example.org>', 'codes@example.org, x@example.org', 'codes@example.org\r\nBcc: x@example.org']) expect(() => withSmtp({ PHILOBIBLOS_SMTP_FROM: from }), from).toThrow(/one plain address/);
    expect(() => withSmtp({ PHILOBIBLOS_SMTP_HOST: 'smtp://smtp.example.org' })).toThrow(/host name/);
    expect(() => withSmtp({ PHILOBIBLOS_SMTP_PORT: '0' })).toThrow(/PHILOBIBLOS_SMTP_PORT/);
    expect(() => loadConfig({ ...base, ...SMTP, PHILOBIBLOS_MODE: 'homerslab', PHILOBIBLOS_EDGE_IDENTITY: 'homerslab-v1', PHILOBIBLOS_TRUSTED_PROXY: '127.0.0.1', PHILOBIBLOS_ORIGIN: ORIGIN })).toThrow(/standalone join codes only/);
  });

  it('a list of public providers that cannot be read, or names none, stops it (the rule would let anyone in)', () => {
    expect(() => withSmtp({ PHILOBIBLOS_PUBLIC_MAIL_DOMAINS_FILE: '/nonexistent/list.txt' })).toThrow(/cannot read/);
    const dir = mkdtempSync(pathJoin(tmpdir(), 'pb-list-'));
    writeFileSync(pathJoin(dir, 'empty.txt'), '# nothing\n\n');
    expect(() => withSmtp({ PHILOBIBLOS_PUBLIC_MAIL_DOMAINS_FILE: pathJoin(dir, 'empty.txt') })).toThrow(/names no domain/);
    writeFileSync(pathJoin(dir, 'own.txt'), 'Mail.Example.NET # ours\n');
    expect([...withSmtp({ PHILOBIBLOS_PUBLIC_MAIL_DOMAINS_FILE: pathJoin(dir, 'own.txt') }).publicMailDomains]).toEqual(['mail.example.net']);
  });
});

describe('with SMTP unset the rule is not offered', () => {
  it('no mailCodes, a link with a mail domain is refused, the code routes answer 404, a link opens as before', async () => {
    const b = await app(noSmtp());
    const nets = await b.app.inject({ url: '/api/people/home-networks', remoteAddress: IN_HOME, headers: { cookie: sessionCookie(b.db, 'p_alex') } });
    expect(nets.json().mailCodes).toBeNull();
    const refused = await post(b.app, '/api/people/join-links', { mailDomain: DOMAIN }, { cookie: sessionCookie(b.db, 'p_alex') });
    expect([refused.statusCode, refused.json().error]).toEqual([400, expect.stringMatching(/needs outgoing SMTP/)]);
    const { token } = await makeLink(b.app, b.db, {});
    expect((await post(b.app, '/api/join/open', { token })).statusCode).toBe(204);
    expect((await ask(b.app, token, `jordan@${DOMAIN}`)).statusCode).toBe(404);
    expect((await tryCode(b.app, 'x'.repeat(43), '123456')).statusCode).toBe(404);
    expect(b.sent).toEqual([]);
  });

  it('a stored mail rule with SMTP gone never matches (fail closed): the person waits', async () => {
    const b = await app(noSmtp());
    const { id, token } = await makeLink(b.app, b.db, { accept: 'automatic' });
    b.db.update(t.joinLink).set({ mailDomain: DOMAIN }).where(eq(t.joinLink.id, id)).run();
    expect((await join(b.app, token, 'Jordan')).json()).toMatchObject({ waiting: true });
    // and a link that takes only matches opens for no one: nobody can verify an address now
    const strict = await makeLink(b.app, b.db, { accept: 'automatic', nonMatches: 'refuse' });
    b.db.update(t.joinLink).set({ mailDomain: DOMAIN }).where(eq(t.joinLink.id, strict.id)).run();
    const o = await post(b.app, '/api/join/open', { token: strict.token });
    expect([o.statusCode, o.json()]).toEqual([404, NOT_HERE]);
  });
});

describe('what leaves: the SMTP host, only when set', () => {
  it('named for the admin who sets the rule; never on the book client\'s list', async () => {
    const b = await app();
    const nets = await b.app.inject({ url: '/api/people/home-networks', remoteAddress: IN_HOME, headers: { cookie: sessionCookie(b.db, 'p_alex') } });
    expect(nets.json().mailCodes).toEqual({ host: SMTPD_HOST });
    // The SMTP server is reached by net/smtp.ts alone, never over HTTP.
    expect(egressRules({}).map((r) => r.host)).not.toContain(SMTPD_HOST);
  });
});

describe('a link with the mail-domain rule', () => {
  it('opens asking for an address (never naming the domain); a code goes to it; the right code lets in an adult, keeping only the domain', async () => {
    const b = await app();
    const { id, token } = await makeLink(b.app, b.db);
    const opened = await post(b.app, '/api/join/open', { token });
    expect([opened.statusCode, opened.json()]).toEqual([200, { askAddress: true }]);
    expect(opened.body).not.toContain(DOMAIN);
    const request = await prove(b, token, `jordan@${DOMAIN}`);
    expect(b.sent[0]!.code).toMatch(/^\d{6}$/);
    const v = await join(b.app, token, 'Jordan', request);
    expect(v.json()).toMatchObject({ waiting: false, person: { role: 'adult' } });
    const p = b.db.select().from(t.person).where(eq(t.person.name, 'Jordan')).get()!;
    expect(p).toMatchObject({ state: 'active', role: 'adult', admittedLink: id, admittedDomain: DOMAIN });
    // The address is nowhere: not on the person, not in a request, not in the send log.
    expect(everything(b.db)).not.toContain(`jordan@${DOMAIN}`);
    expect(b.db.select().from(t.joinCode).all()).toEqual([]);
    const me = await b.app.inject({ url: '/api/me', headers: { cookie: sessionCookie(b.db, 'p_alex') } });
    expect(me.json().household.find((x: { name: string }) => x.name === 'Jordan').letInByLink).toMatchObject({ linkId: id, domain: DOMAIN });
  });

  it('without a verified address no one matches: they wait, or are refused when the link refuses non-matches', async () => {
    const b = await app();
    const { token } = await makeLink(b.app, b.db);
    expect((await join(b.app, token, 'Jordan')).json()).toMatchObject({ waiting: true });
    const strict = await makeLink(b.app, b.db, { accept: 'automatic', nonMatches: 'refuse', mailDomain: DOMAIN });
    // it opens (someone who verifies would match), but without a verified address the enrolment is refused
    expect((await post(b.app, '/api/join/open', { token: strict.token })).statusCode).toBe(200);
    const o = await post(b.app, '/api/join/options', { token: strict.token, name: 'Riley' });
    expect([o.statusCode, o.json()]).toEqual([404, NOT_HERE]);
  });

  it('a match is an adult, never an admin, whatever the body says', async () => {
    const b = await app();
    const { token } = await makeLink(b.app, b.db);
    const r = await post(b.app, '/api/join/code', { token, address: `jordan@${DOMAIN}`, role: 'admin' });
    expect(r.statusCode).toBe(200);
    await tryCode(b.app, r.json().request, b.sent[0]!.code);
    const o = await post(b.app, '/api/join/options', { token, name: 'Jordan', request: r.json().request, role: 'admin' });
    const s = o.json();
    const v = await post(b.app, '/api/join/verify', { challengeId: s.challengeId, response: { id: 'cred-j', challenge: s.options.challenge }, role: 'admin' });
    expect(v.json().person.role).toBe('adult');
  });
});

describe('the code is bound to the request that asked for it', () => {
  it('another request\'s code, the code on another link, or another browser (no request): no match', async () => {
    const b = await app();
    const one = await makeLink(b.app, b.db);
    const two = await makeLink(b.app, b.db);
    const a1 = await ask(b.app, one.token, `jordan@${DOMAIN}`);
    const a2 = await ask(b.app, one.token, `riley@${DOMAIN}`);
    // Riley's code for Jordan's request: wrong
    expect((await tryCode(b.app, a1.json().request, b.sent[1]!.code)).json()).toEqual(WRONG_CODE);
    expect((await tryCode(b.app, a2.json().request, b.sent[1]!.code)).statusCode).toBe(204);
    // Riley's verified request on the other link: it counts for nothing there
    expect((await join(b.app, two.token, 'Riley', a2.json().request)).json()).toMatchObject({ waiting: true });
    // and a browser without the request (the code alone is no proof)
    expect((await join(b.app, one.token, 'Riley')).json()).toMatchObject({ waiting: true });
    expect(b.db.select().from(t.person).where(eq(t.person.state, 'active')).all().map((p) => p.name)).not.toContain('Riley');
  });

  it('stored only as an HMAC keyed by HKDF-SHA-256 of the sealing key (info "join-code"), over its request\'s id', async () => {
    const b = await app();
    const { token } = await makeLink(b.app, b.db);
    await ask(b.app, token, `jordan@${DOMAIN}`);
    const code = b.sent[0]!.code;
    const row = b.db.select().from(t.joinCode).get()!;
    const sealing = Buffer.from(TEST_SEALING_KEY, 'base64');
    const key = Buffer.from(hkdfSync('sha256', sealing, Buffer.alloc(0), 'join-code', 32));
    expect(codeKey(sealing)).toEqual(key);
    expect(row.mac).toEqual(createHmac('sha256', key).update(`code\n${row.id}\n${code}`).digest());
    // never the sealing key itself as the HMAC key, never the code in the clear, never a plain hash of it
    expect(row.mac).not.toEqual(createHmac('sha256', sealing).update(`code\n${row.id}\n${code}`).digest());
    expect(everything(b.db)).not.toContain(code);
  });

  it('compared in constant time: an HMAC of the given code against the stored one, with timingSafeEqual', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/household/join-code.ts', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('export function checkCode'), src.indexOf('\n}\n', src.indexOf('export function checkCode')));
    expect(fn).toMatch(/timingSafeEqual\(given, stored\)/);
    // no other comparison of the code or the MAC
    const compares = fn.replace(/typeof \w+ === '\w+'/g, '').replace(/ [!=]== null\b/g, '');
    expect(compares).not.toMatch(/(?:mac|code|given|stored)\s*[!=]=|[!=]=\s*(?:row\.mac|given|stored)\b(?!\.length)|\.equals\(|Buffer\.compare/);
  });
});

describe('10 minutes, 5 tries, one live code an address', () => {
  const key = codeKey(Buffer.from(TEST_SEALING_KEY, 'base64'));
  const setup = () => {
    const db = household();
    db.insert(t.joinLink).values({ id: 'l1', tokenHash: 'h1', createdBy: 'p_alex', createdAt: '2026-11-24T08:00:00.000Z', expiresAt: '2026-12-01T08:00:00.000Z', mailDomain: DOMAIN }).run();
    return db;
  };
  const at = (min: number) => new Date(Date.parse('2026-11-24T10:00:00.000Z') + min * 60_000);

  it('the code works for 10 minutes, then not', () => {
    const db = setup();
    const a = askCode(db, key, { linkId: 'l1', to: `jordan@${DOMAIN}` }, at(0));
    expect(checkCode(db, key, requestHash(a.request), a.send!.code, at(10.01))).toBe(false);
    const b = askCode(db, key, { linkId: 'l1', to: `riley@${DOMAIN}` }, at(0));
    expect(checkCode(db, key, requestHash(b.request), b.send!.code, at(9.9))).toBe(true);
  });

  it('5 tries: after five wrong ones the right one no longer works; the right one is spent', () => {
    const db = setup();
    const a = askCode(db, key, { linkId: 'l1', to: `jordan@${DOMAIN}` }, at(0));
    const wrong = a.send!.code === '000000' ? '000001' : '000000';
    for (let i = 0; i < JOIN_CODE.tries; i++) expect(checkCode(db, key, requestHash(a.request), wrong, at(1))).toBe(false);
    expect(checkCode(db, key, requestHash(a.request), a.send!.code, at(1))).toBe(false);
    const b = askCode(db, key, { linkId: 'l1', to: `riley@${DOMAIN}` }, at(2));
    for (let i = 0; i < JOIN_CODE.tries - 1; i++) checkCode(db, key, requestHash(b.request), wrong, at(3));
    expect(checkCode(db, key, requestHash(b.request), b.send!.code, at(3))).toBe(true);
    expect(checkCode(db, key, requestHash(b.request), b.send!.code, at(3))).toBe(false);
  });

  it('a new code for an address ends the one before', () => {
    const db = setup();
    const first = askCode(db, key, { linkId: 'l1', to: `jordan@${DOMAIN}` }, at(0));
    const second = askCode(db, key, { linkId: 'l1', to: `jordan@${DOMAIN}` }, at(1));
    expect(checkCode(db, key, requestHash(first.request), first.send!.code, at(2))).toBe(false);
    expect(checkCode(db, key, requestHash(second.request), second.send!.code, at(2))).toBe(true);
  });

  it('random: a thousand codes are spread over the million', () => {
    const db = setup();
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      db.delete(t.joinCodeSent).run();
      codes.add(askCode(db, key, { linkId: 'l1', to: `p${i}@${DOMAIN}` }, at(0)).send!.code);
    }
    expect(codes.size).toBeGreaterThan(990);
  });

  it('a request is kept at most 30 minutes, its address with it; a verified one is taken at the enrolment', () => {
    const db = setup();
    const a = askCode(db, key, { linkId: 'l1', to: `jordan@${DOMAIN}` }, at(0));
    checkCode(db, key, requestHash(a.request), a.send!.code, at(1));
    expect(takeVerified(db, requestHash(a.request), 'l1', at(31))).toBeNull();
    const b = askCode(db, key, { linkId: 'l1', to: `riley@${DOMAIN}` }, at(40));
    pruneCodes(db, at(71));
    expect(db.select().from(t.joinCode).all()).toEqual([]);
    expect(everything(db)).not.toContain(`riley@${DOMAIN}`);
    expect(b.send).not.toBeNull();
  });
});

describe('send limits: 3 an hour and 10 a day an address, 10 a day a link, 30 a day the household', () => {
  const key = codeKey(Buffer.from(TEST_SEALING_KEY, 'base64'));
  const at = (h: number) => new Date(Date.parse('2026-11-24T00:00:00.000Z') + h * 3_600_000);
  const setup = () => {
    const db = household();
    for (const id of ['l1', 'l2', 'l3', 'l4']) db.insert(t.joinLink).values({ id, tokenHash: id, createdBy: 'p_alex', createdAt: at(0).toISOString(), expiresAt: at(200).toISOString(), mailDomain: DOMAIN }).run();
    return db;
  };

  it('an address: the 4th code in an hour and the 11th in a day are not sent', () => {
    const db = setup();
    const to = `jordan@${DOMAIN}`;
    const sends = (h: number) => askCode(db, key, { linkId: 'l1', to }, at(h)).send !== null;
    expect([sends(0), sends(0.1), sends(0.2), sends(0.3)]).toEqual([true, true, true, false]);
    // spread over the day: 10, then no more until the first is a day old
    const db2 = setup();
    const out = Array.from({ length: 11 }, (_, i) => askCode(db2, key, { linkId: `l${(i % 4) + 1}`, to }, at(i * 2)).send !== null);
    expect(out).toEqual([...Array(10).fill(true), false]);
    expect(askCode(db2, key, { linkId: 'l1', to }, at(24.01)).send).not.toBeNull();
  });

  it('the send log keeps an HMAC of the address, never the address', () => {
    const db = setup();
    askCode(db, key, { linkId: 'l1', to: `jordan@${DOMAIN}` }, at(0));
    const row = db.select().from(t.joinCodeSent).get()!;
    expect(row.addressMac).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(db.select().from(t.joinCodeSent).all())).not.toContain('jordan');
  });

  it('through the routes: the 11th code of a day on one link, and the 31st in the household, made-up addresses at the domain, get the same answer as a sent one', async () => {
    const b = await app();
    const links = [await makeLink(b.app, b.db), await makeLink(b.app, b.db), await makeLink(b.app, b.db), await makeLink(b.app, b.db)];
    const from = (i: number) => ({ remote: `10.20.${Math.floor(i / 10) + 2}.${(i % 10) + 1}` });
    const answers = [];
    for (let i = 0; i < 11; i++) answers.push(await ask(b.app, links[0]!.token, `made-up-${i}@${DOMAIN}`, from(i)));
    answers.forEach(sameAnswer);
    expect(b.sent.map((s) => s.to)).toEqual(Array.from({ length: 10 }, (_, i) => `made-up-${i}@${DOMAIN}`));
    // the refused one's request answers its code tries like a wrong code
    expect((await tryCode(b.app, answers[10]!.json().request, '123456')).json()).toEqual(WRONG_CODE);
    for (let i = 11; i < 31; i++) sameAnswer(await ask(b.app, links[1 + ((i - 11) % 3)]!.token, `made-up-${i}@${DOMAIN}`, from(i)));
    expect(b.sent).toHaveLength(30);
    const last = await ask(b.app, links[3]!.token, `made-up-31@${DOMAIN}`, from(31));
    sameAnswer(last);
    expect(b.sent).toHaveLength(30);
  });

  it('asking is limited per client address and per link too (429), above the send limits', async () => {
    const b = await app();
    const { token } = await makeLink(b.app, b.db);
    const codes = [];
    for (let i = 0; i < 21; i++) codes.push((await ask(b.app, token, `p${i}@${DOMAIN}`)).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes[20]).toBe(429);
  });
});

describe('the same answer whether or not a mail went out', () => {
  it('another domain, a subdomain, a public provider\'s domain, a link that does not open, a full list, a member\'s address', async () => {
    const b = await app();
    const auto = await makeLink(b.app, b.db);
    const approval = await makeLink(b.app, b.db, { mailDomain: DOMAIN });
    const plain = await makeLink(b.app, b.db, {});
    const sentBefore = () => b.sent.length;
    for (const [token, address] of [[auto.token, 'jordan@example.net'], [auto.token, `jordan@mail.${DOMAIN}`], [plain.token, `jordan@${DOMAIN}`], ['n'.repeat(43), `jordan@${DOMAIN}`]] as const) {
      const n = sentBefore();
      sameAnswer(await ask(b.app, token, address));
      expect(b.sent.length, address).toBe(n);
    }
    // from outside the home network
    sameAnswer(await ask(b.app, auto.token, `jordan@${DOMAIN}`, { remote: '198.51.100.7' }));
    expect(b.sent).toHaveLength(0);
    // a member's address (someone the rule let in): the same answer; Philobiblos does not know members' addresses
    const proved = await prove(b, auto.token, `casey@${DOMAIN}`);
    expect((await join(b.app, auto.token, 'Casey', proved)).json()).toMatchObject({ waiting: false });
    const n0 = b.sent.length;
    sameAnswer(await ask(b.app, auto.token, `casey@${DOMAIN}`));
    expect(b.sent.length).toBe(n0 + 1);
    sameAnswer(await ask(b.app, auto.token, `sam@${DOMAIN}`));
    // a full list: whoever would wait cannot, so no mail; the answer is the same
    for (let i = 0; i < WAITING.max; i++) b.db.insert(t.person).values({ id: `w${i}`, name: `W${i}`, role: 'adult', state: 'waiting', arrivedAt: new Date().toISOString() }).run();
    const n = b.sent.length;
    sameAnswer(await ask(b.app, approval.token, `kim@${DOMAIN}`));
    expect(b.sent.length).toBe(n);
  });

  it('a public mail provider\'s domain: a link cannot be made with it, and a stored one never sends nor matches', async () => {
    const b = await app();
    for (const d of ['gmail.com', 'GMAIL.com', '@outlook.com']) {
      const r = await post(b.app, '/api/people/join-links', { accept: 'automatic', mailDomain: d }, { cookie: sessionCookie(b.db, 'p_alex') });
      expect([r.statusCode, r.json().error], d).toEqual([400, expect.stringMatching(/public mail provider/)]);
    }
    const { id, token } = await makeLink(b.app, b.db);
    b.db.update(t.joinLink).set({ mailDomain: 'gmail.com' }).where(eq(t.joinLink.id, id)).run();
    sameAnswer(await ask(b.app, token, 'jordan@gmail.com'));
    expect(b.sent).toEqual([]);
    expect((await join(b.app, token, 'Jordan')).json()).toMatchObject({ waiting: true });
  });

  it('a request that sent nothing is tried like one that did: the link\'s limit counts both (no telling the domain by its 429)', async () => {
    const b = await app();
    const { token } = await makeLink(b.app, b.db);
    const real = (await ask(b.app, token, `jordan@${DOMAIN}`)).json().request;
    const none = (await ask(b.app, token, 'jordan@example.net', { remote: '10.20.9.9' })).json().request;
    expect(b.sent).toHaveLength(1);
    const tries = [];
    for (let i = 0; i < 5; i++) tries.push((await tryCode(b.app, real, '000000', { remote: `10.20.3.${i + 1}` })).statusCode);
    for (let i = 0; i < 6; i++) tries.push((await tryCode(b.app, none, '000000', { remote: `10.20.4.${i + 1}` })).statusCode);
    // ten tries a link in ten minutes, whichever of its requests they were for
    expect(tries).toEqual([...Array(10).fill(400), 429]);
  });

  it('the mail is sent after the answer: a server that never answers does not hold it back', async () => {
    const b = await app(withSmtp(), household(), () => new Promise(() => {}));
    const { token } = await makeLink(b.app, b.db);
    const t0 = Date.now();
    sameAnswer(await ask(b.app, token, `jordan@${DOMAIN}`));
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('one plain address, the only recipient', () => {
  it('a display name, a line break, a comma or a second address: 400, nothing sent, nothing stored', async () => {
    const b = await app();
    const { token } = await makeLink(b.app, b.db);
    for (const address of [`Jordan <jordan@${DOMAIN}>`, `jordan@${DOMAIN}\r\nBcc: x@${DOMAIN}`, `jordan@${DOMAIN}\n`, `a@${DOMAIN},b@${DOMAIN}`, `a@${DOMAIN} b@${DOMAIN}`, `"a"@${DOMAIN}`, 42]) {
      const r = await post(b.app, '/api/join/code', { token, address });
      expect(r.statusCode, String(address)).toBe(400);
    }
    expect(b.sent).toEqual([]);
    expect(b.db.select().from(t.joinCode).all()).toEqual([]);
  });
});

describe('the address is kept on the join request only', () => {
  it('a waiting person\'s verified address is shown to admins, and gone once they are approved, declined or lapse', async () => {
    for (const end of ['approve', 'decline', 'lapse'] as const) {
      const b = await app();
      const { token } = await makeLink(b.app, b.db, { mailDomain: DOMAIN });
      const request = await prove(b, token, `jordan@${DOMAIN}`);
      expect((await join(b.app, token, 'Jordan', request)).json()).toMatchObject({ waiting: true });
      const waiting = await b.app.inject({ url: '/api/people/waiting', headers: { cookie: sessionCookie(b.db, 'p_alex') } });
      expect(waiting.json()[0]).toMatchObject({ name: 'Jordan', verifiedAddress: `jordan@${DOMAIN}`, matchesRules: true });
      expect(b.db.select().from(t.joinCode).all()).toEqual([]);
      const p = b.db.select().from(t.person).where(eq(t.person.name, 'Jordan')).get()!;
      if (end === 'approve') approve(b.db, p.id, 'adult');
      else if (end === 'decline') decline(b.db, p.id);
      else { b.db.update(t.person).set({ arrivedAt: '2026-01-01T00:00:00.000Z' }).where(eq(t.person.id, p.id)).run(); lapseWaiting(b.db); }
      expect(everything(b.db), end).not.toContain(`jordan@${DOMAIN}`);
      if (end === 'approve') expect(b.db.select().from(t.person).where(eq(t.person.id, p.id)).get()!.admittedDomain).toBeNull();
    }
  });
});

describe('through the local SMTP server (TLS, certificate verified)', () => {
  async function real(test: { ca?: string; connectTo: string }) {
    const s = await smtpd();
    open.push(s);
    const cfg = withSmtp({ PHILOBIBLOS_SMTP_PORT: String(s.port) });
    cfg.smtp!.test = test;
    const db = household();
    const b = await buildApp(cfg, db, { webauthn: fakeWebAuthn(), push: nowherePush, joinFloorMs: 0, surroundings: HOST });
    await b.app.ready();
    open.push(b);
    db.insert(t.homeNetwork).values({ cidr: HOME, addedBy: 'p_alex', addedAt: new Date().toISOString() }).run();
    return { s, b, db };
  }
  const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };

  it('one mail, to the one recipient, fixed text holding the code alone: nothing of the household', async () => {
    const { s, b, db } = await real({ ca: SMTPD_CA, connectTo: '127.0.0.1' });
    const { token, url } = await (async () => { const r = await post(b.app, '/api/people/join-links', { accept: 'automatic', mailDomain: DOMAIN }, { cookie: sessionCookie(db, 'p_alex') }); return { token: r.json().url.split('#')[1], url: r.json().url as string }; })();
    const r = await ask(b.app, token, `jordan@${DOMAIN}`);
    await until(() => s.received[0]?.data != null);
    const got = s.received[0]!;
    expect(got.to).toEqual([`RCPT TO:<jordan@${DOMAIN}>`]);
    const code = /Your code to join: (\d{6})/.exec(got.data!)![1]!;
    for (const word of ['Alex', 'Sam', 'Robin', 'Kid 1', 'localhost', url, token, 'http']) expect(got.data, word).not.toContain(word);
    expect((await tryCode(b.app, r.json().request, code)).statusCode).toBe(204);
  });

  it('a certificate the client does not trust: nothing is sent, the password never, and the answer is the same', async () => {
    const { s, b, db } = await real({ connectTo: '127.0.0.1' });
    const r = await post(b.app, '/api/people/join-links', { accept: 'automatic', mailDomain: DOMAIN }, { cookie: sessionCookie(db, 'p_alex') });
    sameAnswer(await ask(b.app, r.json().url.split('#')[1], `jordan@${DOMAIN}`));
    await until(() => s.received.length > 0);
    await new Promise((res) => setTimeout(res, 100));
    expect(s.received.every((x) => x.auth === null && x.data === null)).toBe(true);
  });
});

describe('under HomersLab', () => {
  it('no code route opens (404), and SMTP cannot be set', async () => {
    const cfg = loadConfig({ PHILOBIBLOS_MODE: 'homerslab', PHILOBIBLOS_EDGE_IDENTITY: 'homerslab-v1', PHILOBIBLOS_TRUSTED_PROXY: '127.0.0.1', PHILOBIBLOS_ORIGIN: ORIGIN, PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY });
    const db = household();
    const b = await buildApp(cfg, db, { webauthn: fakeWebAuthn(), push: nowherePush, joinFloorMs: 0, surroundings: HOST });
    await b.app.ready();
    open.push(b);
    for (const url of ['/api/join/code', '/api/join/code/check']) expect((await b.app.inject({ method: 'POST', url, payload: {}, remoteAddress: '127.0.0.1', headers: { origin: ORIGIN } })).statusCode, url).toBe(404);
  });
});
