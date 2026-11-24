// Every connector that ships brings invented fixtures (connectors/<id>/fixtures/*.yaml, docs/connectors.md), and each
// runs here through the same path a real mail takes: signed as the shop (keys made by the test), the strict header
// block, the sender and DKIM checks against that connector alone, the size limits, then the parser with the
// connector's own words; a price page through its lookup. A new shop is a folder of data and fixtures, and this test.
// Each connector's words are also run over hostile text, to keep every match linear whatever a connector holds. And
// what a connector cannot loosen is checked for each one: its fixtures unsigned, altered, signed by another, signed in
// part, with a broken header block, to someone else or over the size limit are refused, and its price host is never
// asked at a private address (docs/connectors.md "What a connector cannot do").
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { priceAsks } from '@philobiblos/contracts/connector';
import { describe, expect, it } from 'vitest';
import { parseTiles, pickOffer, pickProduct, tileRules } from '../src/books/prices';
import { classify, mailRules, ownLines, parseInvoice, parseMarkup, parseQuote, parseShop } from '../src/mail/parse';
import { ldBlocks, schemaNodes } from '../src/schemaorg/jsonld';
import { MAIL_LIMITS, openVerified } from '../src/mail/read';
import { shopHosts, shopMail } from '../src/connectors/enabled';
import { createEgress, egressRules } from '../src/net/egress';
import { CONNECTORS, HOUSEHOLD, evil, message, resolver, shop, signed } from './mailkit';

const DIR = fileURLToPath(new URL('../../../connectors', import.meta.url));
interface Fixture { from?: string; subject?: string; text?: string; html?: string; rows?: string[][]; title?: string; authors?: string[]; isbn13?: string; page?: string; expect: unknown }
const fixtures = (id: string): [string, Fixture][] => {
  let names: string[] = [];
  try { names = readdirSync(join(DIR, id, 'fixtures')).filter((n) => n.endsWith('.yaml')).sort(); } catch { /* none */ }
  return names.map((n) => [n, parseYaml(readFileSync(join(DIR, id, 'fixtures', n), 'utf8')) as Fixture]);
};
const shipped = CONNECTORS.all.filter((c) => c.origin === 'builtin');

describe.each(shipped.map((c) => [c.id, c] as const))('connector %s', (id, loaded) => {
  it('is sound and has fixtures', () => {
    expect(loaded.problem).toBeNull();
    expect(fixtures(id).length).toBeGreaterThan(0);
  });
  const c = loaded.connector!;
  const mails = fixtures(id).filter(([, f]) => f.from);
  const signerOf = (f: Fixture) => {
    const domain = f.from!.slice(f.from!.indexOf('@') + 1);
    const signers = c.mail!.dkim_domains ?? c.mail!.domains;
    return signers.includes(domain) ? domain : signers[0]!;
  };
  const bodyOf = (f: Fixture) => (f.html ?? f.text ?? 'Invoice attached.').replace(/\r?\n/g, '\r\n');
  const mailOf = (f: Fixture, o: { extra?: string; body?: string } = {}) => message({ from: f.from, subject: f.subject, html: Boolean(f.html), body: bodyOf(f), ...o });
  // The mail checks take what the mail job takes from an enabled connector (shopMail), and nothing else of it.
  const open = (raw: Buffer) => openVerified(raw, { shops: [shopMail({ id, connector: c })], arcSealers: [], recipients: HOUSEHOLD, resolver, address: [] });

  it.each(mails)('%s: signed, verified, read as expected', async (_n, f) => {
    const opened = await open(await signed(mailOf(f), signerOf(f)));
    if (!opened.ok) throw new Error(`not verified: ${opened.auth.reason}`);
    const r = mailRules(c);
    const k = classify(r, opened.mail.auth.from, opened.mail.signedSubject);
    const parsed = k.kind === 'quote_or_confirm' ? parseQuote(opened.mail.text, [], r)
      : k.kind === 'online_order' || k.kind === 'click_collect' ? parseShop(k.kind, k.number, opened.mail.text, [], r)
        : k.kind === 'invoice' ? parseInvoice(k.number, f.rows ?? [], false, [], r)
          // A mail none of its layouts knows: its markup, if its connector's counts (as the mail job reads it).
          : k.kind === 'other' ? parseMarkup(opened.mail.markup, [], r) ?? k : k;
    expect(parsed).toMatchObject(f.expect as object);
  });

  it.each(mails)('%s: refused unsigned, altered, signed by another or in part, with a broken header block, to someone else, too large', async (_n, f) => {
    const refused = async (raw: Buffer, why: RegExp) => {
      const r = await open(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(`${r.auth.reason} ${r.unreadable ?? ''}`).toMatch(why);
    };
    const good = await signed(mailOf(f), signerOf(f));
    expect((await open(good)).ok).toBe(true);
    await refused(mailOf(f), /no DKIM|not signed|signature/i);
    // One byte more at the end of the body: its signature no longer holds.
    await refused(Buffer.concat([good.subarray(0, good.length - 2), Buffer.from('x\r\n')]), /dkim|signature/i);
    await refused(await signed(mailOf(f), 'evil.example', evil), /dkim|signature|aligned/i);
    await refused(await signed(mailOf(f), signerOf(f), shop, { maxBodyLength: 8 }), /part of the body/);
    await refused(await signed(mailOf(f, { extra: 'not a header line' }), signerOf(f)), /header/i);
    await refused(await signed(Buffer.from(mailOf(f).toString().replace(`To: ${HOUSEHOLD[0]}`, 'To: someone.else@example.org')), signerOf(f)), /household|recipient|addressed/i);
    const line = `${'a'.repeat(998)}\r\n`;
    await refused(await signed(mailOf(f, { body: line.repeat(Math.ceil(MAIL_LIMITS.message / line.length) + 1) }), signerOf(f)), /too_large/);
  }, 60_000);

  it.runIf(Boolean(c.prices))('its price host: on the allowlist only as an enabled shop\'s, never at a private address (not even as the household\'s Ollama host)', async () => {
    const url = c.prices!.url.replace(/\{(?:query|isbn)\}/, 'x');
    const host = new URL(url).hostname;
    const enabled = [{ id, version: loaded.version, connector: c }];
    expect(shopHosts(enabled)).toEqual([host]);
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
      // The household's Ollama may sit at a private address (its rule allows one): a connector naming that host is still a shop.
      for (const ollamaUrl of [null, `https://${host}`]) {
        const e = createEgress({ rules: egressRules({ shopHosts: shopHosts(enabled), ollamaUrl }), resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }] });
        await expect(e.get(url, 'html')).rejects.toMatchObject({ reason: 'private-address' });
      }
    }
    await expect(createEgress({ rules: egressRules({}), resolve: async () => [{ address: '93.184.215.14', family: 4 }] }).get(url, 'html')).rejects.toMatchObject({ reason: 'not-allowed' });
  });

  it.each(fixtures(id).filter(([, f]) => f.page))('%s: the price lookup picks the expected offer', (_n, f) => {
    const p = c.prices!;
    // A lookup by ISBN reads as it runs: the product carrying the fixture's ISBN (`isbn13`, which it then needs).
    if (p.kind === 'jsonld') {
      const by = priceAsks(p.url) === 'isbn' ? { isbn13: f.isbn13! } : undefined;
      if (by) expect(f.isbn13).toMatch(/^97[89]\d{10}$/);
      expect(pickProduct(schemaNodes(ldBlocks(f.page!)).nodes, f.title!, f.authors ?? [], c.locale.currency, by)).toEqual(f.expect);
      return;
    }
    const rules = tileRules({ money: c.money, prices: p });
    expect(pickOffer(parseTiles(f.page!, rules), f.title!, f.authors ?? [], rules)).toEqual(f.expect);
  });

  it('its words stay linear on hostile text', () => {
    const r = mailRules(c);
    const line = 'a '.repeat(490);
    const text = `${line}\n`.repeat(4900);
    const t0 = Date.now();
    ownLines(text, r);
    parseQuote(text, [], r);
    parseShop('online_order', '1', `${line} | ${'1'.repeat(400)}\n`.repeat(4900), [], r);
    classify(r, 'x@example.org', `${'a'.repeat(250)} ${'1 '.repeat(5000)}`);
    if (c.prices?.kind === 'search_tiles') {
      const rules = tileRules({ money: c.money, prices: c.prices });
      parseTiles(`<a href="${c.prices.article.path}${c.prices.article.id_prefix}${'1'.repeat(40)}`.repeat(20_000), rules);
      rules.availability.exec(`${'1'.repeat(100)} `.repeat(10_000));
    }
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
