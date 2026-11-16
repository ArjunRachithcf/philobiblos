// Bookshops are data (philobiblos#27): connectors/<id>/connector.yaml, read strictly, matched in linear time, and
// counting for nothing until an admin enables one (with a fresh sign-in) for the version of its file they read. Every
// connector and mail here is invented. Each guard has a test that fails when the guard is removed.
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { ConnectorError, enabledConnectors, orderAddress, setConnector, shopHosts } from '../src/connectors/enabled';
import { CONNECTOR_LIMITS, loadConnectors, readConnector, registry, type LoadedConnector } from '../src/connectors/load';
import { alternation, amountFinder, contains, startsWith, subjectMatcher } from '../src/connectors/text';
import { openDb } from '../src/db/open';
import * as t from '../src/db/schema';
import { refreshMail } from '../src/mail/job';
import { mailRules, classify } from '../src/mail/parse';
import { createEgress, egressRules, EgressError } from '../src/net/egress';
import { ORIGIN, TEST_SEALING_KEY, household, sessionCookie } from './helpers';
import { CFG, CONNECTORS, HOUSEHOLD, SEALERS, fakeBox, message, resolver, signed } from './mailkit';
import { verifyBookshopMail } from '../src/mail/verify';

const EXAMPLE = readFileSync(new URL('../../../connectors/quillmere/connector.yaml', import.meta.url), 'utf8');
const read = (text: string, folder = 'quillmere') => readConnector(Buffer.from(text), folder);
const problemOf = (text: string, folder?: string) => { const r = read(text, folder); return 'problem' in r ? r.problem : null; };
/** The example with one line replaced (the line must be there). */
const edited = (from: string, to: string) => { expect(EXAMPLE).toContain(from); return EXAMPLE.replace(from, to); };

describe('a connector is data, read strictly', () => {
  it('the example that ships is sound', () => {
    expect(read(EXAMPLE)).toHaveProperty('connector.id', 'quillmere');
    expect(CONNECTORS.get('quillmere')).toMatchObject({ origin: 'builtin', problem: null });
    expect(CONNECTORS.get('quillmere')!.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    // A connector cannot carry a setting the core does not have, at any level.
    ['a key the schema does not name, at the top', () => `${EXAMPLE}allow_unsigned_mail: true\n`, /schema/],
    ['a key the schema does not name, in mail', () => edited('mail:\n', 'mail:\n  private_hosts_ok: true\n'), /schema/],
    ['a key the schema does not name, in prices', () => edited('prices:\n', 'prices:\n  redirect_to: [evil.example]\n'), /schema/],
    // Domains and hosts are exact names.
    ['a wildcard domain', () => edited('domains: [quillmere.example]', "domains: ['*.quillmere.example']"), /schema/],
    ['an address for a domain', () => edited('domains: [quillmere.example]', 'domains: [192.0.2.7]'), /schema/],
    ['a domain in capitals', () => edited('domains: [quillmere.example]', 'domains: [Quillmere.example]'), /schema/],
    ['a domain with a trailing dot', () => edited('domains: [quillmere.example]', 'domains: [quillmere.example.]'), /schema/],
    ['a single-label domain', () => edited('domains: [quillmere.example]', 'domains: [localhost]'), /schema/],
    ['a price URL over http', () => edited('url: https://www', 'url: http://www'), /schema/],
    ['a price URL with a port', () => edited('quillmere.example/suche', 'quillmere.example:8443/suche'), /schema/],
    ['a price URL with credentials', () => edited('https://www.quillmere.example', 'https://a:b@www.quillmere.example'), /schema/],
    ['a price URL whose host is filled in', () => edited('url: https://www.quillmere.example/suche?sq={query}', 'url: https://{query}.example/suche?sq=x'), /schema/],
    ['a price URL whose path is filled in', () => edited('url: https://www.quillmere.example/suche?sq={query}', 'url: https://www.quillmere.example/{query}?sq=x'), /schema/],
    ['a price URL with {query} twice', () => edited('sq={query}', 'sq={query}&q2={query}'), /schema/],
    ['a price URL at an address', () => edited('url: https://www.quillmere.example/', 'url: https://192.0.2.7/'), /schema/],
    // What a schema cannot say.
    ['a quote sender at another domain', () => edited('senders: [english-orders@quillmere.example]', 'senders: [orders@evil.example]'), /not at one of its mail domains/],
    ['an id that is not its folder', () => edited('id: quillmere', 'id: another-shop'), /folder/],
    ['a subject that is only its number', () => edited("subjects: ['Ihre Quillmere-Rechnung Nr. {number}',", "subjects: ['Nr. {number} 12345',"), /too few words/],
    ['a subject without a number', () => edited("'Wir bearbeiten Ihre Bestellung ({number})'", "'Wir bearbeiten Ihre Bestellung'"), /schema/],
    ['an article id with fewer digits at most than at least', () => edited('id_digits: [6, 14]', 'id_digits: [14, 6]'), /fewer digits/],
    // Words are words: no control characters, a * only at the end of a summary word, bounded lists and lengths.
    ['a * inside a word', () => edited('gesamt*,', 'ges*amt,'), /schema/],
    ['a * in a phrase', () => edited('confirm_phrases: [we have now ordered]', 'confirm_phrases: [we have * ordered]'), /schema/],
    ['a control character', () => edited('by: von', 'by: "v\\u0007on"'), /schema/],
    ['a phrase over 60 characters', () => edited('confirm_phrases: [we have now ordered]', `confirm_phrases: [${'a'.repeat(61)}]`), /schema/],
    ['more than 32 phrases', () => edited('confirm_phrases: [we have now ordered]', `confirm_phrases: [${Array.from({ length: 33 }, (_, i) => `p${i}`).join(', ')}]`), /schema/],
    // YAML that is more than data.
    ['an alias', () => edited('  domains: [quillmere.example]', '  domains: &d [quillmere.example]\n  dkim_domains: *d'), /anchor|YAML/],
    // Two layers: the parser's own warning for a tag it cannot resolve, and a walk that refuses any tag it can.
    ['a tag', () => edited('name: Quillmere Books', 'name: !!js/function "x"'), /not plain YAML: TAG_RESOLVE_FAILED/],
    ['a custom tag', () => edited('name: Quillmere Books', 'name: !shop Quillmere'), /not plain YAML: TAG_RESOLVE_FAILED/],
    ['a tag YAML resolves', () => edited('name: Quillmere Books', 'name: !!str Quillmere'), /uses a YAML tag or anchor/],
    ['a key twice', () => edited('name: Quillmere Books', 'name: Quillmere Books\nname: Other'), /YAML/],
    ['a merge key', () => edited('order:\n', 'order:\n  <<: {to: x@quillmere.example}\n'), /schema/],
    ['a file over 64 KB', () => `${EXAMPLE}#${'x'.repeat(CONNECTOR_LIMITS.fileBytes)}\n`, /larger/],
  ])('refused: %s', (_n, make, why) => {
    expect(problemOf(make())).toMatch(why);
  });

  it('a file that is not UTF-8 is refused', () => {
    expect('problem' in readConnector(Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x3a, 0x20, 0xff, 0xfe]), 'quillmere')).toBe(true);
  });

  it('folders: the household\'s own are read too, a reused id or a symbolic link is refused, files beside them are ignored', () => {
    const root = mkdtempSync(join(tmpdir(), 'philobiblos-connectors-'));
    const local = join(root, 'local');
    const mk = (name: string, text: string) => { mkdirSync(join(local, name), { recursive: true }); writeFileSync(join(local, name, 'connector.yaml'), text); };
    mk('lindenhof', EXAMPLE.replace('id: quillmere', 'id: lindenhof').replaceAll('quillmere.example', 'lindenhof.example'));
    mk('quillmere', EXAMPLE);
    mkdirSync(join(local, 'linked'));
    symlinkSync(join(local, 'lindenhof', 'connector.yaml'), join(local, 'linked', 'connector.yaml'));
    symlinkSync(join(local, 'lindenhof'), join(local, 'linked-folder'));
    writeFileSync(join(local, 'README.txt'), 'not a connector');
    const reg = loadConnectors({ builtin: new URL('../../../connectors', import.meta.url).pathname, local });
    const by = (id: string) => reg.get(id)!;
    expect(reg.all.map((c) => [c.id, c.origin])).toEqual([['quillmere', 'builtin'], ['lindenhof', 'local'], ['linked', 'local'], ['quillmere', 'local']]);
    expect(by('lindenhof').problem).toBeNull();
    expect(reg.all[3]).toMatchObject({ problem: expect.stringMatching(/ships with Philobiblos/), connector: null });
    expect(by('linked')).toMatchObject({ problem: expect.stringMatching(/link/), connector: null });
  });
});

describe('a connector\'s words are matched in linear time', () => {
  const HUGE = 1 << 20;
  // Words chosen to make a backtracking pattern slow, were they patterns: they are literals here.
  const nasty = ['(a+)+$', 'a'.repeat(59) + 'b', '.*.*.*=.*', 'a?'.repeat(20) + 'a'.repeat(20)];
  it.each([
    ['contains', () => { const f = contains(nasty); return () => f('a'.repeat(HUGE)); }],
    ['startsWith (with a prefix word)', () => { const f = startsWith([...nasty.slice(0, 2), 'aaaa*']); return () => f('a'.repeat(HUGE) + '!'); }],
    ['a subject template', () => { const f = subjectMatcher(`${'a'.repeat(50)} {number} ${'a'.repeat(50)}`); return () => f(`${'a'.repeat(50)} ${'1 '.repeat(HUGE / 2)}x`); }],
    ['amounts', () => { const f = amountFinder({ before: ['CHF', 'a.a'], after: ['CHF'] }); return () => f('1.1'.repeat(HUGE / 3) + 'a.a 1'); }],
  ])('%s, on a megabyte of hostile text', (_n, make) => {
    const run = make();
    const t0 = Date.now();
    run();
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('a word is a literal: its pattern characters match only themselves', () => {
    expect(contains(['(a+)+$'])('see (a+)+$ here')).toBe(true);
    expect(contains(['(a+)+$'])('aaaa')).toBe(false);
    expect(contains(['Fr.'])('Frx 12')).toBe(false);
    expect(alternation(['a|b'])).toBe('(?:a\\|b)');
  });

  it('subject templates: in any case and spacing; a space before the number may be left out; nothing else is loose', () => {
    const f = subjectMatcher('Your Order No. {number}');
    expect(f('your  order no. 123456')).toBe('123456');
    expect(f('Your Order No.123456')).toBe('123456');
    expect(f('Your Order No. 123456 (again)')).toBeNull();
    expect(f('Re: Your Order No. 123456')).toBeNull();
    expect(f('Your Order No. ')).toBeNull();
  });
});

describe('a connector counts only once an admin enabled it, for the file they read', () => {
  const lindenhof = () => {
    const text = EXAMPLE.replace('id: quillmere', 'id: lindenhof').replace('name: Quillmere Books', 'name: Lindenhof Books');
    const r = readConnector(Buffer.from(text), 'lindenhof');
    return { id: 'lindenhof', origin: 'local', version: 'v-lindenhof', connector: 'connector' in r ? r.connector : null, problem: null } satisfies LoadedConnector;
  };

  it('nothing is enabled at first; enabling needs the version Settings showed; turning off is always possible', () => {
    const db = openDb(':memory:');
    db.insert(t.person).values({ id: 'p_admin', name: 'Admin', role: 'admin', handle: 'admin' }).run();
    expect(enabledConnectors(db, CONNECTORS)).toEqual([]);
    expect(() => setConnector(db, CONNECTORS, 'quillmere', { enabled: true }, 'p_admin')).toThrow(/changed since/);
    expect(() => setConnector(db, CONNECTORS, 'quillmere', { enabled: true, acceptVersion: '0'.repeat(64) }, 'p_admin')).toThrow(ConnectorError);
    expect(() => setConnector(db, CONNECTORS, 'quillmere', { enabled: true, acceptVersion: CONNECTORS.get('quillmere')!.version, trustUnsigned: true }, 'p_admin')).toThrow(/not one of its settings/);
    expect(() => setConnector(db, CONNECTORS, 'nowhere', { enabled: true }, 'p_admin')).toThrow(/no such connector/);
    expect(setConnector(db, CONNECTORS, 'quillmere', { enabled: true, acceptVersion: CONNECTORS.get('quillmere')!.version }, 'p_admin')).toMatchObject({ enabled: true, changed: false });
    expect(enabledConnectors(db, CONNECTORS).map((e) => e.id)).toEqual(['quillmere']);
    expect(setConnector(db, CONNECTORS, 'quillmere', { enabled: false }, 'p_admin')).toMatchObject({ enabled: false });
    expect(enabledConnectors(db, CONNECTORS)).toEqual([]);
  });

  it('a file that changed since it was enabled allows nothing until an admin enables it again', () => {
    const db = household();
    const q = CONNECTORS.get('quillmere')!;
    expect(enabledConnectors(db, CONNECTORS).map((e) => e.id)).toEqual(['quillmere']);
    const changed = registry([{ ...q, version: 'f'.repeat(64) }]);
    expect(enabledConnectors(db, changed)).toEqual([]);
    expect(shopHosts(enabledConnectors(db, changed))).toEqual([]);
  });

  it('a connector that cannot be used is never enabled, nor counted if its row is there', () => {
    const db = household();
    const broken = registry([{ ...CONNECTORS.get('quillmere')!, connector: null, problem: 'it does not follow the connector schema' }]);
    expect(enabledConnectors(db, broken)).toEqual([]);
    // A problem found after the file was read (another connector took its id) counts as much as an unreadable file.
    expect(enabledConnectors(db, registry([{ ...CONNECTORS.get('quillmere')!, problem: 'a connector that ships with Philobiblos has this id' }]))).toEqual([]);
    expect(() => setConnector(db, broken, 'quillmere', { enabled: true, acceptVersion: CONNECTORS.get('quillmere')!.version }, 'p_alex')).toThrow(/cannot be used/);
  });

  it('two enabled connectors never share a mail domain', () => {
    const db = household();
    const reg = registry([CONNECTORS.get('quillmere')!, lindenhof()]);
    expect(() => setConnector(db, reg, 'lindenhof', { enabled: true, acceptVersion: 'v-lindenhof' }, 'p_alex')).toThrow(/same mail domain/);
  });

  it('the egress allowlist holds a shop\'s host only while it is enabled, checked at each request', async () => {
    const db = openDb(':memory:');
    db.insert(t.person).values({ id: 'p_admin', name: 'Admin', role: 'admin', handle: 'admin' }).run();
    const asked: string[] = [];
    const e = createEgress({ rules: () => egressRules({ shopHosts: shopHosts(enabledConnectors(db, CONNECTORS)) }), resolve: async (h) => { asked.push(h); throw new Error('stop here'); } });
    await expect(e.get('https://www.quillmere.example/suche?sq=x', 'html')).rejects.toMatchObject({ reason: 'not-allowed' });
    setConnector(db, CONNECTORS, 'quillmere', { enabled: true, acceptVersion: CONNECTORS.get('quillmere')!.version }, 'p_admin');
    await expect(e.get('https://www.quillmere.example/suche?sq=x', 'html')).rejects.toBeInstanceOf(EgressError);
    expect(asked).toEqual(['www.quillmere.example']);
    // Only that host: not the mail domain, not another name under it.
    await expect(e.get('https://quillmere.example/', 'html')).rejects.toMatchObject({ reason: 'not-allowed' });
    await expect(e.get('https://evil.www.quillmere.example/', 'html')).rejects.toMatchObject({ reason: 'not-allowed' });
    setConnector(db, CONNECTORS, 'quillmere', { enabled: false }, 'p_admin');
    await expect(e.get('https://www.quillmere.example/suche?sq=x', 'html')).rejects.toMatchObject({ reason: 'not-allowed' });
  });

  it('mail: nothing is read with no bookshop enabled, and a disabled one\'s mail is not verified', async () => {
    const db = openDb(':memory:');
    const mail = await signed(message({ id: 'off1' }));
    expect(await refreshMail(db, CFG, { open: async () => fakeBox([{ uid: 1, raw: mail }]), resolver })).toMatchObject({ status: 'blocked', detail: expect.stringMatching(/no bookshop is enabled/) });
    expect(await verifyBookshopMail(mail, { shops: [], arcSealers: SEALERS, recipients: HOUSEHOLD, resolver })).toMatchObject({ accepted: false, reason: expect.stringMatching(/no bookshop is enabled/) });
    expect(await verifyBookshopMail(mail, { shops: [{ id: 'lindenhof', domains: ['lindenhof.example'], dkimDomains: ['lindenhof.example'] }], arcSealers: SEALERS, recipients: HOUSEHOLD, resolver })).toMatchObject({ accepted: false, reason: 'not from an enabled bookshop' });
  });

  it('mail domains are exact: a subdomain of an enabled shop\'s domain is another sender, and a signature by a parent domain does not count', async () => {
    const shops = [{ id: 'quillmere', domains: ['quillmere.example'], dkimDomains: ['quillmere.example'] }];
    const v = (raw: Buffer) => verifyBookshopMail(raw, { shops, arcSealers: SEALERS, recipients: HOUSEHOLD, resolver });
    expect(await v(await signed(message({ from: 'news@mail.quillmere.example' })))).toMatchObject({ accepted: false, reason: 'not from an enabled bookshop' });
    expect(await v(await signed(message()))).toMatchObject({ accepted: true, connector: 'quillmere' });
    // Listed as a sender domain but not as a signing one: its own signature does not count.
    const onlyParentSigns = [{ id: 'quillmere', domains: ['quillmere.example', 'mail.quillmere.example'], dkimDomains: ['example'] }];
    expect(await verifyBookshopMail(await signed(message()), { shops: onlyParentSigns, arcSealers: SEALERS, recipients: HOUSEHOLD, resolver })).toMatchObject({ accepted: false });
  });

  it('the parsers read a mail with its own connector\'s words: another shop\'s subjects and senders mean nothing to it', () => {
    const text = EXAMPLE.replace('id: quillmere', 'id: lindenhof').replaceAll('Quillmere', 'Lindenhof').replaceAll('quillmere.example', 'lindenhof.example');
    const r = readConnector(Buffer.from(text), 'lindenhof');
    if (!('connector' in r)) throw new Error(r.problem);
    const theirs = mailRules(r.connector), ours = mailRules(CONNECTORS.get('quillmere')!.connector!);
    expect(classify(ours, 'english-orders@quillmere.example', 'Re: Book order')).toEqual({ kind: 'quote_or_confirm' });
    expect(classify(theirs, 'english-orders@quillmere.example', 'Re: Book order')).toEqual({ kind: 'other' });
    expect(classify(ours, 'x@quillmere.example', 'Ihre Quillmere-Rechnung Nr. 99001122')).toEqual({ kind: 'invoice', number: '99001122' });
    expect(classify(theirs, 'x@lindenhof.example', 'Ihre Quillmere-Rechnung Nr. 99001122')).toEqual({ kind: 'other' });
  });
});

describe('Settings: GET /connectors and PUT /connectors/{id}', () => {
  let built: Awaited<ReturnType<typeof buildApp>>;
  const db = openDb(':memory:');
  beforeAll(async () => {
    db.insert(t.person).values([
      { id: 'p_admin', name: 'Admin', role: 'admin', handle: 'admin' },
      { id: 'p_adult', name: 'Adult', role: 'adult', handle: 'adult' },
    ]).run();
    built = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY }), db, { connectors: CONNECTORS });
  });
  afterAll(() => built.app.close());
  const ask = (method: 'GET' | 'PUT', url: string, cookie: string, body?: unknown) => built.app.inject({ method, url, headers: { cookie, origin: ORIGIN, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { payload: JSON.stringify(body) } : {}) });
  const version = CONNECTORS.get('quillmere')!.version;

  it('admins only; each connector says what it allows before anyone enables it', async () => {
    expect((await ask('GET', '/api/connectors', sessionCookie(db, 'p_adult'))).statusCode).toBe(403);
    const r = await ask('GET', '/api/connectors', sessionCookie(db, 'p_admin'));
    expect(r.statusCode).toBe(200);
    expect(r.json().connectors).toEqual([{
      id: 'quillmere', name: 'Quillmere Books', origin: 'builtin', version, usable: true, enabled: false, changed: false, currency: 'CHF', language: 'de',
      allows: { mailFrom: ['quillmere.example'], signedBy: ['quillmere.example'], quoteSenders: ['english-orders@quillmere.example'], priceHost: 'www.quillmere.example', orderTo: 'english-orders@quillmere.example' },
    }]);
  });

  it('enabling takes an admin with a sign-in of the last few minutes; turning off takes an admin', async () => {
    expect((await ask('PUT', '/api/connectors/quillmere', sessionCookie(db, 'p_adult'), { enabled: true, acceptVersion: version })).statusCode).toBe(403);
    const stale = sessionCookie(db, 'p_admin');
    db.update(t.session).set({ createdAt: new Date(Date.now() - 3600_000).toISOString() }).run();
    const old = await ask('PUT', '/api/connectors/quillmere', stale, { enabled: true, acceptVersion: version });
    expect(old.statusCode).toBe(403);
    expect(old.json().error).toMatch(/sign in again/);
    expect(db.select().from(t.connectorEnabled).all()).toEqual([]);
    const ok = await ask('PUT', '/api/connectors/quillmere', sessionCookie(db, 'p_admin'), { enabled: true, acceptVersion: version });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: 'quillmere', enabled: true });
    expect(db.select().from(t.connectorEnabled).where(eq(t.connectorEnabled.id, 'quillmere')).get()).toMatchObject({ version, enabledBy: 'p_admin' });
    // Turning off only narrows: an older sign-in will do, but never a non-admin.
    expect((await ask('PUT', '/api/connectors/quillmere', sessionCookie(db, 'p_adult'), { enabled: false })).statusCode).toBe(403);
    expect((await ask('PUT', '/api/connectors/quillmere', stale, { enabled: false })).json()).toMatchObject({ enabled: false });
    expect((await ask('PUT', '/api/connectors/quillmere', sessionCookie(db, 'p_admin'), { enabled: true, acceptVersion: 'x' })).statusCode).toBe(409);
    expect((await ask('PUT', '/api/connectors/nowhere', sessionCookie(db, 'p_admin'), { enabled: false })).statusCode).toBe(404);
  });
});

describe('Compose writes to the enabled bookshop unless an admin named another address', () => {
  it('the address set in Settings first; else the one enabled connector\'s; never a disabled one\'s, nor a guess between two', () => {
    const db = openDb(':memory:');
    db.insert(t.person).values({ id: 'p_admin', name: 'Admin', role: 'admin', handle: 'admin' }).run();
    expect(orderAddress(null, enabledConnectors(db, CONNECTORS))).toBeNull();
    expect(orderAddress('orders@bookshop.example', enabledConnectors(db, CONNECTORS))).toBe('orders@bookshop.example');
    setConnector(db, CONNECTORS, 'quillmere', { enabled: true, acceptVersion: CONNECTORS.get('quillmere')!.version }, 'p_admin');
    const enabled = enabledConnectors(db, CONNECTORS);
    expect(orderAddress(null, enabled)).toBe('english-orders@quillmere.example');
    expect(orderAddress('orders@bookshop.example', enabled)).toBe('orders@bookshop.example');
    expect(orderAddress(null, [...enabled, { ...enabled[0]!, id: 'other', connector: { ...enabled[0]!.connector, order: { to: 'orders@other.example' } } }])).toBeNull();
  });
});
