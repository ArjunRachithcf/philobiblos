// Every connector that ships brings invented fixtures (connectors/<id>/fixtures/*.yaml, docs/connectors.md), and each
// runs here through the same path a real mail takes: signed as the shop (keys made by the test), the strict header
// block, the sender and DKIM checks against that connector alone, the size limits, then the parser with the
// connector's own words; a price page through its lookup. A new shop is a folder of data and fixtures, and this test.
// Each connector's words are also run over hostile text, to keep every match linear whatever a connector holds.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseTiles, pickOffer, pickProduct, tileRules } from '../src/books/prices';
import { classify, mailRules, ownLines, parseInvoice, parseMarkup, parseQuote, parseShop } from '../src/mail/parse';
import { ldBlocks, schemaNodes } from '../src/schemaorg/jsonld';
import { openVerified } from '../src/mail/read';
import { CONNECTORS, HOUSEHOLD, message, resolver, signed } from './mailkit';

const DIR = fileURLToPath(new URL('../../../connectors', import.meta.url));
interface Fixture { from?: string; subject?: string; text?: string; html?: string; rows?: string[][]; title?: string; authors?: string[]; page?: string; expect: unknown }
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

  it.each(fixtures(id).filter(([, f]) => f.from))('%s: signed, verified, read as expected', async (_n, f) => {
    const domain = f.from!.slice(f.from!.indexOf('@') + 1);
    const signer = (c.mail!.dkim_domains ?? c.mail!.domains).includes(domain) ? domain : (c.mail!.dkim_domains ?? c.mail!.domains)[0]!;
    const raw = await signed(message({ from: f.from, subject: f.subject, html: Boolean(f.html), body: (f.html ?? f.text ?? 'Invoice attached.').replace(/\r?\n/g, '\r\n') }), signer);
    const shops = [{ id, domains: c.mail!.domains, dkimDomains: c.mail!.dkim_domains ?? c.mail!.domains }];
    const opened = await openVerified(raw, { shops, arcSealers: [], recipients: HOUSEHOLD, resolver, address: [] });
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

  it.each(fixtures(id).filter(([, f]) => f.page))('%s: the price lookup picks the expected offer', (_n, f) => {
    const p = c.prices!;
    if (p.kind === 'jsonld') { expect(pickProduct(schemaNodes(ldBlocks(f.page!)), f.title!, f.authors ?? [], c.locale.currency)).toEqual(f.expect); return; }
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
