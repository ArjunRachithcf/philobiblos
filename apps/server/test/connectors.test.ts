// Bookshops are data (philobiblos#27): connectors/<id>/connector.yaml, read strictly, matched in linear time, and
// counting for nothing until an admin enables one (with a fresh sign-in) for the version of its file they read. Every
// connector and mail here is invented. Each guard has a test that fails when the guard is removed.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONNECTOR_SCHEMA } from '@philobiblos/contracts/connector';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { ConnectorError, enabledConnectors, orderAddress, setConnector, shopHosts } from '../src/connectors/enabled';
import { CONNECTOR_LIMITS, loadConnectors, readConnector, registry, type LoadedConnector } from '../src/connectors/load';
import { alternation, amountFinder, amountReader, amountTest, contains, startsWith, subjectMatcher } from '../src/connectors/text';
import { openDb } from '../src/db/open';
import * as t from '../src/db/schema';
import { refreshMail } from '../src/mail/job';
import { mailRules, classify } from '../src/mail/parse';
import { relaxedAligned } from '../src/net/domains';
import { createEgress, egressRules, EgressError } from '../src/net/egress';
import { ORIGIN, TEST_SEALING_KEY, household, sessionCookie } from './helpers';
import { CFG, CONNECTORS, HOUSEHOLD, SEALERS, evil, fakeBox, message, resolver, sealed, signed } from './mailkit';
import { verifyBookshopMail } from '../src/mail/verify';

/** The household's currency in these tests: the example shop's (a connector counts only in it). */
const QUILLMERE_CURRENCY = CONNECTORS.get('quillmere')!.connector!.locale.currency;
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
    // Format characters (\p{Cf}): a right-to-left override would show a name reversed in Settings, and a phrase holding
    // one would never match (fold drops them from the mail).
    ['a right-to-left override in its name', () => edited('name: Quillmere Books', 'name: "Quillmere \\u202Eskoob"'), /schema/],
    ['a zero-width space in a phrase', () => edited('confirm_phrases: [we have now ordered]', 'confirm_phrases: ["we have\\u200Bnow ordered"]'), /schema/],
    ['a soft hyphen in a word', () => edited('by: von', 'by: "v\\u00ADon"'), /schema/],
    ['a zero-width joiner in a summary word', () => edited('rechnungsbetrag,', '"rechnungs\\u200Dbetrag",'), /schema/],
    ['a word joiner in a money symbol', () => edited('before: [CHF, Fr.]', 'before: [CHF, "Fr\\u2060."]'), /schema/],
    ['a left-to-right mark in a subject template', () => edited("subjects: ['Ihre Quillmere-Rechnung Nr. {number}',", 'subjects: ["Ihre Quillmere-Rechnung\\u200E Nr. {number}",'), /schema/],
    // A signing domain must be aligned with one of its mail domains (relaxed: the same organizational domain), or its
    // signature could never count for the shop's From: a shared sending service's domain would let its customers forge it.
    ['a signing domain not aligned with any of its mail domains', () => edited('  domains: [quillmere.example]', '  domains: [quillmere.example]\n  dkim_domains: [quillmere.example, mailer.example]'), /signing domain mailer\.example is not aligned/],
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

  it('every object of the schema refuses keys it does not name, at every depth: a connector cannot add a setting', () => {
    // The tests above try a few keys at a few levels; this holds for every object the schema has, now and as it grows,
    // so no connector can carry an unsigned-mail switch, a private host or another size limit anywhere.
    const open: string[] = [];
    const walk = (s: unknown, at: string): void => {
      if (Array.isArray(s)) { s.forEach((x, i) => walk(x, `${at}/${i}`)); return; }
      if (typeof s !== 'object' || s === null) return;
      const o = s as Record<string, unknown>;
      const object = o.type === 'object' || (Array.isArray(o.type) && o.type.includes('object'));
      if ((object || 'properties' in o || 'required' in o || 'dependentRequired' in o) && o.additionalProperties !== false) open.push(at || '/');
      // A schema with no type that only points elsewhere ($ref, allOf/oneOf/anyOf) is checked where it points (walked too).
      for (const k of ['patternProperties', 'unevaluatedProperties', 'propertyNames']) if (k in o) open.push(`${at}/${k}`);
      for (const [k, v] of Object.entries(o)) {
        if (k === 'properties' || k === '$defs') for (const [name, sub] of Object.entries(v as Record<string, unknown>)) walk(sub, `${at}/${k}/${name}`);
        else walk(v, `${at}/${k}`);
      }
    };
    walk(CONNECTOR_SCHEMA, '');
    expect(open).toEqual([]);
    // And the loader reads with this schema: a key it does not name, deep in a layout, is refused.
    expect(problemOf(edited('    confirm_phrases: [we have now ordered]', '    confirm_phrases: [we have now ordered]\n    unsigned_ok: true'))).toMatch(/schema.*unsigned_ok/);
  });

  it('a signing domain under one of its mail domains is aligned, and sound', () => {
    expect(read(edited('  domains: [quillmere.example]', '  domains: [quillmere.example]\n  dkim_domains: [mail.quillmere.example]'))).toHaveProperty('connector.mail.dkim_domains', ['mail.quillmere.example']);
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
    expect(reg.all.map((c) => [c.id, c.origin])).toEqual([['larkspur', 'builtin'], ['marginalia', 'builtin'], ['quillmere', 'builtin'], ['lindenhof', 'local'], ['linked', 'local'], ['quillmere', 'local']]);
    expect(by('lindenhof').problem).toBeNull();
    expect(reg.all[5]).toMatchObject({ problem: expect.stringMatching(/ships with Philobiblos/), connector: null });
    expect(by('linked')).toMatchObject({ problem: expect.stringMatching(/link/), connector: null });
  });

  it('an entry that cannot be looked at becomes a problem row, and the rest still load', () => {
    const local = mkdtempSync(join(tmpdir(), 'philobiblos-connectors-'));
    mkdirSync(join(local, 'lindenhof'));
    writeFileSync(join(local, 'lindenhof', 'connector.yaml'), EXAMPLE.replace('id: quillmere', 'id: lindenhof').replaceAll('quillmere.example', 'lindenhof.example'));
    // An entry that vanishes between the listing and the look at it (a household editing its folder while Philobiblos starts).
    mkdirSync(join(local, 'gone'));
    const lstat = (p: string) => { if (p.endsWith('/gone')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return lstatSync(p); };
    const reg = loadConnectors({ builtin: null, local }, { lstat });
    expect(reg.all.map((c) => [c.id, c.problem])).toEqual([['gone', expect.stringMatching(/cannot be read/)], ['lindenhof', null]]);
  });

  it('the loader does not load the mail verifier: domain alignment is a shared module (philobiblos#38)', () => {
    // A type-only import is erased; any other reference to mail/ (an import, an export from, a dynamic import, in any
    // quotes) loads the verifier with the loader. Checked in the loader and in the module it now takes alignment from.
    for (const f of ['../src/connectors/load.ts', '../src/net/domains.ts']) {
      const source = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^import type [^;]*;$/gm, '');
      expect(source, f).not.toMatch(/['"`](?:\.\.?\/)+mail\//);
    }
    expect(relaxedAligned('mail.quillmere.example', 'quillmere.example')).toBe(true);
    expect(relaxedAligned('Mail.Quillmere.Example', 'quillmere.example')).toBe(true);
    expect(relaxedAligned('quillmere.example.evil.example', 'quillmere.example')).toBe(false);
    // The public suffix list's private domains count: two customers of one hosting service are two organizations.
    expect(relaxedAligned('evil.github.io', 'shop.github.io')).toBe(false);
    expect(relaxedAligned('', 'quillmere.example')).toBe(false);
  });
});

describe('a connector\'s words are matched in linear time', () => {
  const HUGE = 1 << 20;
  const LINEAR_BOUND_MS = 3000;
  // Words chosen to make a backtracking pattern slow, were they patterns: they are literals here.
  const nasty = ['(a+)+$', 'a'.repeat(59) + 'b', '.*.*.*=.*', 'a?'.repeat(20) + 'a'.repeat(20)];
  it.each([
    ['contains', () => { const f = contains(nasty); return () => f('a'.repeat(HUGE)); }],
    ['startsWith (with a prefix word)', () => { const f = startsWith([...nasty.slice(0, 2), 'aaaa*']); return () => f('a'.repeat(HUGE) + '!'); }],
    ['a subject template', () => { const f = subjectMatcher(`${'a'.repeat(50)} {number} ${'a'.repeat(50)}`); return () => f(`${'a'.repeat(50)} ${'1 '.repeat(HUGE / 2)}x`); }],
    ['amounts', () => { const f = amountFinder({ before: ['CHF', 'a.a'], after: ['CHF'] }, 2); return () => f('1.1'.repeat(HUGE / 3) + 'a.a 1'); }],
    ...[0, 2, 3].flatMap((d) => [
      [`amounts with ${d} decimals, grouped`, () => { const f = amountFinder({ before: ['JPY'], after: ['JPY'] }, d); return () => f('1,111'.repeat(HUGE / 5) + ' JPY'); }],
      [`amounts with ${d} decimals, symbols and digits`, () => { const f = amountFinder({ before: ['JPY'], after: ['JPY'] }, d); return () => f('JPY 1'.repeat(HUGE / 5) + '.'); }],
      [`amounts with ${d} decimals, points and apostrophes`, () => { const f = amountFinder({ before: ['JPY'], after: ['JPY'] }, d); return () => f("1'1.".repeat(HUGE / 4) + ' JPY'); }],
    ] as [string, () => () => unknown][]),
    ...[0, 2, 3].map((d) => [`amounts with ${d} decimals, a decimal mark and space groups`, () => {
      const f = amountFinder({ before: ['JPY'], after: ['JPY'], decimal: ',', groups: [' ', '.'] }, d);
      return () => f('1 111\u00a0'.repeat(HUGE / 6) + '1.1 JPY');
    }] as [string, () => () => unknown]),
  ])('%s, on a megabyte of hostile text', (_n, make) => {
    // A linear match takes some 70 ms here on 16 cores; a backtracking one on a megabyte takes minutes (even a quadratic
    // one is ~10^12 steps). So the bound is loose, 3 s, for a slow and loaded 2-core runner with a GC pause
    // (philobiblos#38): it still tells the two apart, and never fails a linear match.
    const run = make();
    const t0 = performance.now();
    run();
    expect(performance.now() - t0).toBeLessThan(LINEAR_BOUND_MS);
  });

  it('amounts in the connector\'s currency\'s decimals (philobiblos#62): none, two or three, of any size up to the ceiling', () => {
    const yen = amountFinder({ before: ['¥', 'JPY'], after: ['JPY', '円'] }, 0);
    expect(yen('Price: ¥1,980')).toBe(198000);
    expect(yen('Price: ¥ 1980.')).toBe(198000);
    expect(yen('JPY 1.980')).toBe(198000);
    expect(yen("JPY 1'980")).toBe(198000);
    expect(yen('1,980 JPY')).toBe(198000);
    expect(yen('合計 2,480円')).toBe(248000);
    expect(yen('¥1,234,567,890')).toBe(123456789000);
    // Never a part of the number: a fraction, a group that is not three digits, a mix of separators.
    for (const bad of ['¥1,980.50', '¥1,98', '¥1,9800', '¥1,980.000', '¥1.980,000', '¥19800000000000', '1,98 JPY', '¥ 12,34,567', '¥1980,000', '¥1,980000']) expect(yen(bad), bad).toBeNull();
    const chf = amountFinder({ before: ['CHF'], after: ['CHF'] }, 2);
    expect(chf('CHF 19.90')).toBe(1990);
    expect(chf('CHF 12345.00')).toBe(1234500); // past the old cap of 9999.99
    expect(chf("CHF 1'234.50")).toBe(123450);
    expect(chf('CHF 1,234.50')).toBe(123450);
    expect(chf('CHF 1.234,50')).toBe(123450);
    expect(chf('1.234,50 CHF')).toBe(123450);
    expect(chf('CHF 10000000000.00')).toBe(1_000_000_000_000);
    for (const bad of ['CHF 1,980', 'CHF 19.9', 'CHF 19.905', 'CHF 1,234,50', 'CHF 1.234.50', 'CHF 10000000000.01', 'CHF 19', 'CHF 1234,567.00']) expect(chf(bad), bad).toBeNull();
    // Three decimals: the connector says which mark is its decimal one (`money.decimal`); a point and three digits is
    // then never a thousands group. Without it, nothing reads (KWD 1,250 could be 1.25 or 1250).
    const bare = amountReader({ before: ['KWD'], after: ['KWD'] }, 3);
    for (const probe of ['KWD 1,250', '12.500 KWD', 'KWD 1.250', 'KWD 1,250.500']) expect(bare(probe), probe).toBeNull();
    const kwd = amountFinder({ before: ['KWD'], after: ['KWD'], decimal: '.' }, 3);
    expect(kwd('KWD 1,250')).toBeNull();
    expect(kwd('12,500 KWD')).toBeNull();
    const comma = amountFinder({ before: ['KWD'], after: ['KWD'], decimal: ',' }, 3);
    expect(comma('12.500 KWD')).toBeNull();
    expect(comma('KWD 1.250,500')).toBe(125050);
    expect(comma('KWD 12,500')).toBe(1250);
    // A decimal mark the connector names is never one of its groups.
    expect(amountFinder({ before: ['¥'], after: [], decimal: '.' }, 0)('¥1.980')).toBeNull();
    expect(amountFinder({ before: ['CHF'], after: [], decimal: ',' }, 2)('CHF 1,234,50')).toBeNull();
    expect(amountFinder({ before: ['CHF'], after: [], decimal: ',' }, 2)('CHF 1.234,50')).toBe(123450);
    expect(kwd('KWD 1.250')).toBe(125);
    expect(kwd('KWD 1,250.500')).toBe(125050);
    expect(kwd('12.500 KWD')).toBe(1250);
    // A thousandth is never kept, nor rounded: none read, and the reader says why.
    for (const bad of ['KWD 1.255', 'KWD 1.25', 'KWD 1']) expect(kwd(bad), bad).toBeNull();
    const below = (s: string) => amountReader({ before: ['KWD'], after: ['KWD'], decimal: '.' }, 3)(s) === 'below';
    expect(below('KWD 1.255')).toBe(true);
    expect(below('1.255 KWD')).toBe(true);
    expect(below('KWD 1.250')).toBe(false);
    expect(amountReader({ before: ['CHF'], after: ['CHF'] }, 2)('CHF 1.255')).toBeNull();
  });

  it('a connector in a currency with three decimals names its decimal mark; its groups never hold it (philobiblos#62)', () => {
    const kwd = (money: string) => read(EXAMPLE.replace('currency: CHF', 'currency: KWD').replace('money:\n  before: [CHF, Fr.]', `money:\n${money}  before: [CHF, Fr.]`));
    expect(kwd('')).toMatchObject({ problem: expect.stringMatching(/three decimals.*money\.decimal/) });
    expect(kwd("  decimal: '.'\n")).toMatchObject({ connector: expect.anything() });
    expect(kwd("  decimal: ';'\n")).toMatchObject({ problem: expect.stringMatching(/schema/) });
    expect(read(EXAMPLE.replace('money:\n  before: [CHF, Fr.]', "money:\n  decimal: '.'\n  groups: ['.', ' ']\n  before: [CHF, Fr.]"))).toMatchObject({ problem: expect.stringMatching(/decimal mark.*group/) });
    expect(read(EXAMPLE.replace('money:\n  before: [CHF, Fr.]', "money:\n  groups: [' ', \"'\"]\n  before: [CHF, Fr.]"))).toMatchObject({ connector: expect.anything() });
  });

  it('a space before more digits ends no amount: it is refused, never cut short; a connector may declare space groups', () => {
    const huf = amountFinder({ before: ['HUF'], after: ['HUF'] }, 0);
    for (const probe of ['HUF 12 500', '12 500 HUF', 'HUF 12\u00a0500', '12\u202f500 HUF']) expect(huf(probe), probe).toBeNull();
    expect(amountFinder({ before: ['¥'], after: [] }, 0)('¥1 250')).toBeNull();
    expect(amountFinder({ before: ['CHF'], after: ['CHF'] }, 2)('CHF 1 234.50')).toBeNull();
    const spaced = amountFinder({ before: ['HUF'], after: ['HUF'], groups: [' '] }, 0);
    expect(spaced('HUF 12 500')).toBe(1250000);
    expect(spaced('12\u00a0500 HUF')).toBe(1250000);
    expect(spaced('12\u202f500 HUF')).toBe(1250000);
    expect(spaced('HUF 12,500')).toBeNull(); // only the groups it declares
    expect(spaced('HUF 12 50')).toBeNull();
  });

  it('whether a line holds an amount: any digit with a symbol, however the number is written', () => {
    expect(amountTest({ before: ['¥'], after: ['円'] })('2,480円')).toBe(true);
    expect(amountTest({ before: ['¥'], after: ['円'] })('2480 円')).toBe(true);
    expect(amountTest({ before: ['KWD'], after: ['KWD'] })('1.250 KWD')).toBe(true);
    // Loose on purpose: an amount with fewer decimals than its currency's still counts, so its line is refused, never skipped.
    expect(amountTest({ before: ['KWD'], after: ['KWD'] })('Versand 1.25 KWD')).toBe(true);
    expect(amountTest({ before: ['CHF'], after: ['CHF'] })('19.90 CHF')).toBe(true);
    // A number with the symbol after it counts, however it is written, so a quote's line is refused, never skipped.
    expect(amountTest({ before: ['CHF'], after: ['CHF'] })('12 500 CHF')).toBe(true);
    expect(amountTest({ before: ['CHF'], after: ['CHF'] })('1.250 CHF')).toBe(true);
    expect(amountTest({ before: ['CHF'], after: ['CHF'] })('Swiss CHF')).toBe(false);
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
    db.insert(t.householdSettings).values({ id: 1, currency: QUILLMERE_CURRENCY }).run();
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
    db.insert(t.householdSettings).values({ id: 1, currency: QUILLMERE_CURRENCY }).run();
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

  it('over ARC as over DKIM: the signing domain must be aligned with the From, and the reason names the one that passed', async () => {
    // The shop's key is gone from DNS (rotated, say): only the forwarder's ARC record can vouch for the mail.
    const noShopKey = async (n: string) => (n.startsWith('mail._domainkey.quillmere.example') ? Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })) : resolver(n));
    const v = (raw: Buffer, dkimDomains: string[]) => verifyBookshopMail(raw, { shops: [{ id: 'quillmere', domains: ['quillmere.example'], dkimDomains }], arcSealers: SEALERS, recipients: HOUSEHOLD, resolver: noShopKey });
    // A connector that lists another organization's domain as a signer (a shared sending service, say): its signature
    // never counts for the shop's From, whether verified here or as a trusted forwarder recorded it.
    expect(await v(await signed(message(), 'evil.example', evil), ['evil.example'])).toMatchObject({ accepted: false });
    expect(await v(await sealed(message(), 'forwarder.example', 'mx.forwarder.example; dkim=pass header.d=evil.example header.s=mail'), ['evil.example'])).toMatchObject({ accepted: false, via: null });
    // A signer under the shop's own domain is aligned (relaxed), and the reason says which signature the forwarder saw pass.
    expect(await v(await sealed(message(), 'forwarder.example', 'mx.forwarder.example; dkim=pass header.d=mail.quillmere.example header.s=mail'), ['mail.quillmere.example']))
      .toMatchObject({ accepted: true, via: 'arc', reason: 'arc=pass by forwarder.example, which saw dkim=pass for mail.quillmere.example' });
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
    built = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY, PHILOBIBLOS_CURRENCY: QUILLMERE_CURRENCY }), db, { connectors: CONNECTORS });
  });
  afterAll(() => built.app.close());
  const ask = (method: 'GET' | 'PUT', url: string, cookie: string, body?: unknown) => built.app.inject({ method, url, headers: { cookie, origin: ORIGIN, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { payload: JSON.stringify(body) } : {}) });
  const version = CONNECTORS.get('quillmere')!.version;

  it('admins only; each connector says what it allows before anyone enables it', async () => {
    expect((await ask('GET', '/api/connectors', sessionCookie(db, 'p_adult'))).statusCode).toBe(403);
    const r = await ask('GET', '/api/connectors', sessionCookie(db, 'p_admin'));
    expect(r.statusCode).toBe(200);
    expect(r.json().connectors.filter((c: { id: string }) => c.id === 'quillmere')).toEqual([{
      id: 'quillmere', name: 'Quillmere Books', origin: 'builtin', version, usable: true, enabled: false, changed: false, currency: 'CHF', language: 'de',
      allows: { mailFrom: ['quillmere.example'], signedBy: ['quillmere.example'], quoteSenders: ['english-orders@quillmere.example'], priceHost: 'www.quillmere.example', priceAsks: 'title', orderTo: 'english-orders@quillmere.example', markup: false },
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

describe('under HomersLab, enabling waits for the edge\'s recent sign-in (homeward#253)', () => {
  it('refused, fail closed: Philobiblos has no step-up of its own there; turning off still works', async () => {
    const db = openDb(':memory:');
    db.insert(t.person).values({ id: 'p_admin', externalId: 'hl-admin', name: 'Admin', role: 'admin', handle: 'admin' }).run();
    const built = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'homerslab', PHILOBIBLOS_EDGE_IDENTITY: 'homerslab-v1', PHILOBIBLOS_TRUSTED_PROXY: '127.0.0.1', PHILOBIBLOS_ORIGIN: ORIGIN, PHILOBIBLOS_DATA_DIR: '/nonexistent' }), db, { connectors: CONNECTORS });
    const h = { 'x-homerslab-person': 'hl-admin', 'x-homerslab-name': 'Admin', 'x-homerslab-role': 'admin', origin: ORIGIN, 'content-type': 'application/json' };
    const put = (body: unknown) => built.app.inject({ method: 'PUT', url: '/api/connectors/quillmere', headers: h, payload: JSON.stringify(body) });
    const r = await put({ enabled: true, acceptVersion: CONNECTORS.get('quillmere')!.version });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/recent sign-in/);
    expect(db.select().from(t.connectorEnabled).all()).toEqual([]);
    expect((await put({ enabled: false })).statusCode).toBe(200);
    await built.app.close();
  });
});

describe('the app\'s book client follows Settings: a price host is reachable only while its connector is enabled', () => {
  it('enabled through PUT /connectors/{id}: reached; turned off: refused; the same app throughout', async () => {
    const db = household();
    db.delete(t.connectorEnabled).run();
    const asked: string[] = [];
    const runs: Promise<void>[] = [];
    const built = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY }), db, {
      connectors: CONNECTORS,
      // Nothing is looked up for real: the lookup is where the test stops a request the allowlist let through.
      egress: { resolve: async (host) => { asked.push(host); throw new Error('stop here'); } },
      jobs: { env: { sleep: async () => {} }, started: (_j, done) => runs.push(done) },
    });
    const as = { cookie: sessionCookie(db, 'p_alex'), origin: ORIGIN };
    const put = (body: unknown) => built.app.inject({ method: 'PUT', url: '/api/connectors/quillmere', headers: { ...as, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    const url = 'https://www.quillmere.example/suche?sq=x';
    await expect(built.egress.get(url, 'html')).rejects.toMatchObject({ reason: 'not-allowed' });
    expect((await put({ enabled: true, acceptVersion: CONNECTORS.get('quillmere')!.version })).statusCode).toBe(200);
    // The price job's lookup reached the shop's host (and stopped at the test's lookup), with no rebuild of the app.
    expect((await built.app.inject({ method: 'POST', url: '/api/jobs/prices/run', headers: as })).statusCode).toBe(202);
    await Promise.all(runs);
    expect(asked).toEqual(['www.quillmere.example']);
    await expect(built.egress.get(url, 'html')).rejects.toMatchObject({ reason: 'network' });
    expect((await put({ enabled: false })).statusCode).toBe(200);
    await expect(built.egress.get(url, 'html')).rejects.toMatchObject({ reason: 'not-allowed' });
    expect(asked).toEqual(['www.quillmere.example', 'www.quillmere.example']);
    await built.app.close();
  });

  it('enabled when the app was built, turned off through PUT /connectors/{id}: refused at once', async () => {
    const db = household();
    const built = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY }), db, {
      connectors: CONNECTORS, egress: { resolve: async () => { throw new Error('stop here'); } },
    });
    await expect(built.egress.get('https://www.quillmere.example/suche?sq=x', 'html')).rejects.toMatchObject({ reason: 'network' });
    const off = await built.app.inject({ method: 'PUT', url: '/api/connectors/quillmere', headers: { cookie: sessionCookie(db, 'p_alex'), origin: ORIGIN, 'content-type': 'application/json' }, payload: JSON.stringify({ enabled: false }) });
    expect(off.statusCode).toBe(200);
    await expect(built.egress.get('https://www.quillmere.example/suche?sq=x', 'html')).rejects.toMatchObject({ reason: 'not-allowed' });
    await built.app.close();
  });
});

describe('Compose writes to the enabled bookshop unless an admin named another address', () => {
  it('the address set in Settings first; else the one enabled connector\'s; never a disabled one\'s, nor a guess between two', () => {
    const db = openDb(':memory:');
    db.insert(t.person).values({ id: 'p_admin', name: 'Admin', role: 'admin', handle: 'admin' }).run();
    db.insert(t.householdSettings).values({ id: 1, currency: QUILLMERE_CURRENCY }).run();
    expect(orderAddress(null, enabledConnectors(db, CONNECTORS))).toBeNull();
    expect(orderAddress('orders@bookshop.example', enabledConnectors(db, CONNECTORS))).toBe('orders@bookshop.example');
    setConnector(db, CONNECTORS, 'quillmere', { enabled: true, acceptVersion: CONNECTORS.get('quillmere')!.version }, 'p_admin');
    const enabled = enabledConnectors(db, CONNECTORS);
    expect(orderAddress(null, enabled)).toBe('english-orders@quillmere.example');
    expect(orderAddress('orders@bookshop.example', enabled)).toBe('orders@bookshop.example');
    expect(orderAddress(null, [...enabled, { ...enabled[0]!, id: 'other', connector: { ...enabled[0]!.connector, order: { to: 'orders@other.example' } } }])).toBeNull();
  });
});
