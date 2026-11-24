// Architecture (philobiblos#27): "as open as possible, no one mail provider or one bookshop". Every shop lives in a
// connector (connectors/<id>/connector.yaml) and every mail provider in the household's settings, so no core module
// names either: not the server, the worker, the web app, the packages, nor the contracts they are generated from. This
// test reads the code as text, so a name in a comment counts too: the code is the place a reader learns what is built in.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONNECTORS } from './mailkit';
import { allows } from '../src/connectors/enabled';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CORE = ['apps/server/src', 'apps/worker/src', 'apps/web/src', 'packages/ai/src', 'packages/contracts/src', 'packages/scoring/src'];
const CONTRACTS = ['contracts/openapi.yaml', 'contracts/schema.sql', 'contracts/homerslab-app.yaml', 'contracts/connector.schema.json'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|js|mjs|json|css|html)$/.test(f) ? [p] : [];
  });
}
const core = () => [...CORE.flatMap((d) => files(join(ROOT, d))), ...CONTRACTS.map((f) => join(ROOT, f))];

/** Mail providers: the household chooses its own (IMAP with any of them); the core names none. */
const PROVIDERS = ['gmail', 'googlemail', 'google.com', 'outlook', 'hotmail', 'office365', 'live.com', 'fastmail', 'mailbox.org', 'protonmail', 'proton.me', 'yahoo', 'icloud', 'gmx', 'posteo', 'microsoft', 'proton', 'accounts.google', 'oauth2.googleapis'];
/** The bookshop the first slices were built for, now an invented example connector (philobiblos#27). */
const FORMER_SHOP = ['orell', 'fuessli', 'füssli', 'fussli', 'english-orders'];

/** Every name a connector brings: its id and name, its domains, senders and hosts. */
function shopWords(): string[] {
  return CONNECTORS.all.flatMap((c) => {
    if (!c.connector) return [];
    const a = allows(c.connector);
    return [c.id, c.connector.name, ...a.mailFrom, ...a.signedBy, ...a.quoteSenders, ...(a.priceHost ? [a.priceHost] : []), ...(a.orderTo ? [a.orderTo] : [])];
  });
}

/**
 * Where these words stand in these files, case-insensitively: as whole words, or with `starts` as the start of a word
 * (a compound too: Gesamtbetrag holds gesamt).
 */
function mailWordHits(words: string[], texts: readonly (readonly [string, string])[], starts = false): string[] {
  const res = words.map((w) => [w, new RegExp(`(?<![\\p{L}\\p{N}])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${starts ? '' : '(?![\\p{L}\\p{N}])'}`, 'u')] as const);
  return texts.flatMap(([name, text]) => { const t = text.toLowerCase(); return res.filter(([, re]) => re.test(t)).map(([w]) => `${name}: ${w}`); });
}

describe('no core module names a bookshop or a mail provider', () => {
  it('the connectors that ship are where the shops are (and there is at least the example)', () => {
    expect(shopWords()).toContain('quillmere.example');
  });

  it.each([
    ['a shop a connector names', () => shopWords()],
    ['the bookshop the first slices were built for', () => FORMER_SHOP],
    ['a mail provider', () => PROVIDERS],
  ])('%s', (_what, words) => {
    const ws = [...new Set(words().map((w) => w.toLowerCase()))];
    const hits = core().flatMap((f) => {
      const text = readFileSync(f, 'utf8').toLowerCase();
      return ws.filter((w) => text.includes(w)).map((w) => `${relative(ROOT, f)}: ${w}`);
    });
    expect(hits).toEqual([]);
  });

  it('no core module names a currency: amounts are in the household\'s (Settings), a connector\'s are its own', () => {
    // ISO 4217 codes, in any case, as a word or as a part of a name (`priceEur`, `CHF_LIMIT`, `const eur`), and the
    // signs a currency is written with.
    const codes = new Set(Intl.supportedValuesOf('currency').map((c) => c.toLowerCase()));
    const signs = /[€£¥₹₩₽₺₪]|\bFr\.|\bUS\$/;
    // Codes that are also ordinary words (a JPEG's start of scan, SQL's ALL, TRY): never taken for money, as a part of
    // a name or as a word. Two more only as the whole name, in lower case: a token's `aud` claim and a CSS class `btn`
    // (`priceAud`, `AUD_LIMIT` and `AUD` are still money).
    const notMoney = new Set(['all', 'bob', 'cup', 'gel', 'mad', 'mop', 'pen', 'sos', 'top', 'try']);
    const asName = new Set(['aud', 'btn']);
    const parts = (name: string) => name.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([0-9])([A-Za-z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s_$]+/).map((p) => p.toLowerCase());
    const named = (id: string) => (asName.has(id) ? undefined : parts(id).find((p) => codes.has(p) && !notMoney.has(p)));
    // And the codes that are never a word, anywhere in a name or a string, whatever surrounds them (`pricechf`, `usd2eur`).
    const anywhere = /chf|usd|gbp|jpy/i;
    const hits = core().flatMap((f) => readFileSync(f, 'utf8').split('\n').flatMap((line, i) => {
      const m = (line.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []).map(named).find(Boolean) ?? signs.exec(line)?.[0] ?? anywhere.exec(line)?.[0];
      return m ? [`${relative(ROOT, f)}:${i + 1}: ${m}`] : [];
    }));
    expect(hits).toEqual([]);
  });

  it('no core module holds the words of a language\'s mail: reply markers, shop words and month names are a connector\'s', () => {
    // The parsers' words are each connector's (`mail.reply`, `summary`, `unavailable`, its layouts), so no list of them
    // lives in the core: neither the shops' (every shipped connector's reply separators) nor these, in the languages
    // shops write in. The order letter Compose writes is the household's, in the app's language (English): its month
    // names are the one list of words of a language the core has, so English month names are not looked for.
    const LANGUAGES = ['de', 'fr', 'it', 'es', 'nl', 'pt', 'sv', 'da', 'nb', 'pl'];
    const monthsIn = (l: string) => Array.from({ length: 12 }, (_, m) => new Intl.DateTimeFormat(l, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, m, 15))).toLowerCase());
    const english = new Set(monthsIn('en'));
    const MARKERS = ['original message', 'ursprüngliche nachricht', "message d'origine", 'messaggio originale', 'mensaje original', 'oorspronkelijk bericht',
      'mensagem original', 'schrieb', 'a écrit', 'ha scritto', 'escribió', 'schreef', 'escreveu', 'gesendet', 'envoyé', 'inviato', 'enviado', 'verzonden',
      'betreff', 'oggetto', 'asunto', 'onderwerp'];
    const SHOP_WORDS = ['gesamt', 'summe', 'zwischensumme', 'rechnung', 'bestell', 'lieferbar', 'vergriffen', 'versand', 'porto', 'mwst', 'rabatt',
      'facture', 'commande', 'livraison', 'fattura', 'ordine', 'spedizione', 'factura', 'pedido', 'envío', 'bestelling', 'factuur', 'verzending'];
    const separators = CONNECTORS.all.flatMap((c) => c.connector?.mail?.reply?.separators ?? []);
    const words = [...new Set([...MARKERS, ...separators, ...LANGUAGES.flatMap(monthsIn).filter((m) => !english.has(m))].map((w) => w.toLowerCase()))];
    const texts = core().map((f) => [relative(ROOT, f), readFileSync(f, 'utf8')] as const);
    // Shop words also as a word's start, for the compounds a shop writes (Gesamtbetrag, Versandkosten).
    expect([...mailWordHits(words, texts), ...mailWordHits(SHOP_WORDS, texts, true)]).toEqual([]);
  });

  it('a shop word counts as the start of a word too: a compound holding one is caught', () => {
    const source = "const TOTALS = ['Gesamtbetrag','Rechnungsbetrag','Bestellnummer'];";
    expect(mailWordHits(['gesamt', 'rechnung', 'bestellung', 'versand'], [['books/prices.ts', source]], true)).toEqual(['books/prices.ts: gesamt', 'books/prices.ts: rechnung']);
    // The shop-word check in the test above is this one: the example in the core is caught.
    expect(mailWordHits(['bestell'], [['books/prices.ts', source]], true)).toEqual(['books/prices.ts: bestell']);
    // Never a word's middle or end: "Untergesamt" is not gesamt's start.
    expect(mailWordHits(['gesamt'], [['x.ts', 'const untergesamt = 1;']], true)).toEqual([]);
  });

  it('only the connector modules read connectors/, and nothing in the core names a connector folder', () => {
    const hits = core().filter((f) => /connectors\/[a-z0-9-]+\/connector\.yaml/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});
