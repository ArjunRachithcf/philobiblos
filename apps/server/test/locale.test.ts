// The household's locale (philobiblos#60): the order letter's language (the bookshop connector's, else the household's,
// else English) and the delivery-address filter's common words, both data in locales/, never core constants.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb, type Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { nextMonth } from '../src/month/plan';
import { importSeed } from '../src/seed/import';
import { LETTERS, checkLetter, commonAddressWords, letterFor, letterShop } from '../src/household/locale';
import { addressParts, safeField } from '../src/mail/read';
import { monthOfSubject } from '../src/mail/effects';
import { mailto, orderText } from '../src/month/order-mail';
import { ORIGIN, TEST_SEALING_KEY, THIS_MONTH, sessionCookie } from './helpers';
import { CONNECTORS, enableShop } from './mailkit';

const lines = [{ title: 'A Book', authors: ['Some Author'], isbn13: '9780000000002' }, { title: 'Another', authors: [], isbn13: null }];

describe('the order letter\'s language', () => {
  it('the connector\'s language first, then the household\'s, then English', () => {
    expect(letterFor({ connector: 'de', household: 'en-GB' }).language).toBe('de');
    expect(letterFor({ connector: 'en', household: 'de-CH' }).language).toBe('en');
    expect(letterFor({ connector: null, household: 'de-CH' }).language).toBe('de');
    expect(letterFor({ connector: null, household: null }).language).toBe('en');
    expect(letterFor({}).language).toBe('en');
  });

  it('a language Philobiblos has no letter in counts for nothing: the next one, then English', () => {
    expect(letterFor({ connector: 'xx', household: 'de-CH' }).language).toBe('de');
    expect(letterFor({ connector: 'xx', household: 'yy' }).language).toBe('en');
    // Not a language tag at all: ignored, never thrown.
    expect(letterFor({ connector: 'not a tag!', household: '' }).language).toBe('en');
    // Case and region do not matter.
    expect(letterFor({ connector: 'DE-at', household: null }).language).toBe('de');
  });

  it('English as before: the subject and the text', () => {
    const { subject, body } = orderText({ month: '2026-12', lines, deliveryAddress: 'A Reader\nSomewhere 1', signedBy: 'Alex' });
    expect(subject).toBe('Book order, December 2026');
    expect(body).toBe(['Hello,', '', 'I would like to order these 2 books:', '', '1. A Book, Some Author (ISBN 9780000000002)', '2. Another', '',
      'Please send them to:', 'A Reader', 'Somewhere 1', '',
      'Could you reply with the prices and delivery times before sending anything? I will give the payment details myself.', '',
      'Thank you,', 'Alex'].join('\n'));
    expect(orderText({ month: '2026-01', lines: lines.slice(0, 1), deliveryAddress: null, signedBy: '' }).body).toContain('I would like to order this book:');
  });

  it('in German when the letter is German: its subject, text, and the too-long link', () => {
    const de = letterFor({ connector: 'de' });
    const { subject, body } = orderText({ month: '2026-03', lines, deliveryAddress: null, signedBy: 'Alex' }, de);
    expect(subject).toBe('Buchbestellung, März 2026');
    expect(body.startsWith('Guten Tag,')).toBe(true);
    expect(body).toContain('1. A Book, Some Author (ISBN 9780000000002)');
    expect(body).not.toMatch(/Hello|Thank you/);
    const long = Array.from({ length: 40 }, (_, i) => ({ title: `A Rather Long Book Title Number ${i}`, authors: ['Some Author'], isbn13: '9780000000000' }));
    const m = mailto('orders@bookshop.example', subject, orderText({ month: '2026-03', lines: long, deliveryAddress: null, signedBy: 'Alex' }, de).body, de);
    expect(m.complete).toBe(false);
    expect(decodeURIComponent(m.url)).toContain('Philobiblos');
    expect(decodeURIComponent(m.url)).not.toContain('Paste the order');
  });

  it('a title holding a placeholder or a $ pattern is written as it is', () => {
    const { body } = orderText({ month: '2026-12', lines: [{ title: '{count} $& {month}', authors: ['$1'], isbn13: null }], deliveryAddress: null, signedBy: '{year}' });
    expect(body).toContain('1. {count} $& {month}, $1');
    expect(body.endsWith('Thank you,\n{year}')).toBe(true);
  });

  it('a reply\'s subject names its month in every language a letter is written in', () => {
    for (const l of Object.values(LETTERS)) {
      for (const month of ['2026-01', '2026-03', '2026-12']) {
        const { subject } = orderText({ month, lines, deliveryAddress: null, signedBy: '' }, l);
        expect(monthOfSubject(`AW: Re: ${subject}`), `${l.language} ${subject}`).toBe(month);
      }
    }
    expect(monthOfSubject('Buchbestellung März 2026')).toBeNull();
    expect(monthOfSubject('Book order, Smarch 2026')).toBeNull();
  });

  it('every shipped letter is complete: 12 months, each text, its placeholders', () => {
    expect(Object.keys(LETTERS)).toEqual(expect.arrayContaining(['en', 'de']));
    for (const [k, l] of Object.entries(LETTERS)) { expect(l.language).toBe(k); expect(() => checkLetter(l)).not.toThrow(); }
  });

  it('a letter that lacks something is refused', () => {
    const en = LETTERS.en!;
    expect(() => checkLetter({ ...en, months: en.months.slice(1) })).toThrow();
    expect(() => checkLetter({ ...en, subject: 'Book order' })).toThrow();
    expect(() => checkLetter({ ...en, many: 'these books:' })).toThrow();
    expect(() => checkLetter({ ...en, thanks: '' })).toThrow();
    expect(() => checkLetter({ ...en, greeting: undefined } as unknown as typeof en)).toThrow();
  });

  it('the shop a letter goes to: the enabled connector whose order address it is, or whose mail domain', () => {
    const enabled = CONNECTORS.all.flatMap((c) => (c.connector ? [{ id: c.id, version: c.version!, connector: c.connector }] : []));
    const quill = enabled.find((e) => e.id === 'quillmere')!;
    expect(letterShop(quill.connector.order!.to, enabled)?.id).toBe('quillmere');
    expect(letterShop(`someone@${quill.connector.mail!.domains[0]}`, enabled)?.id).toBe('quillmere');
    expect(letterShop('orders@bookshop.example', enabled)).toBeNull();
    expect(letterShop(null, enabled)).toBeNull();
    // A domain only ends one: never a look-alike that has it as its end.
    expect(letterShop(`x@evil${quill.connector.mail!.domains[0]}`, enabled)).toBeNull();
  });
});

describe('the delivery-address filter\'s common words come from the household\'s locale', () => {
  it('a region\'s country names are common only for a household in that region', () => {
    expect(commonAddressWords('de-CH').has('schweiz')).toBe(true);
    expect(commonAddressWords('en-CH').has('switzerland')).toBe(true);
    expect(commonAddressWords('en-GB').has('schweiz')).toBe(false);
    expect(commonAddressWords(null).has('switzerland')).toBe(false);
  });

  it('a language\'s street words for its households; English when the locale is unknown or not set', () => {
    expect(commonAddressWords('de-CH').has('gasse')).toBe(true);
    expect(commonAddressWords('en-GB').has('gasse')).toBe(false);
    expect(commonAddressWords('en-GB').has('road')).toBe(true);
    expect(commonAddressWords(null)).toEqual(commonAddressWords('en'));
    expect(commonAddressWords('xx-YY')).toEqual(commonAddressWords('en'));
    expect(commonAddressWords('not a tag!')).toEqual(commonAddressWords('en'));
  });

  it('the spelling every street word is compared as is common in every locale', () => {
    for (const l of [null, 'en', 'de-CH', 'xx']) expect(safeField('Strasse der Bücher', addressParts('A Reader\nLange Strasse 1', l))).toBe('Strasse der Bücher');
  });

  it('a common word only keeps a field a lone word would drop: the address\'s own lines are dropped in every locale', () => {
    const address = 'Alex Brightwater\nBahnhofstrasse 12\n8000 Zürich Schweiz';
    for (const l of [null, 'en-GB', 'de-CH', 'fr-CH', 'xx']) {
      const parts = addressParts(address, l);
      for (const v of ['Bahnhofstr. 12', 'Bahnhof Street 12', 'CH-8000 Zuerich', 'Herr Brightwater', 'Brightwater, Alex']) expect(safeField(`Delivered to ${v}`, parts), `${l}: ${v}`).toBeNull();
    }
    // In Switzerland the country's name alone keeps a field; elsewhere it is a word of the address, and drops it. (A line
    // or comma part of its own is always a piece: a common word is only never a piece on its own.)
    expect(safeField('Versand Schweiz', addressParts(address, 'de-CH'))).toBe('Versand Schweiz');
    expect(safeField('Versand Schweiz', addressParts(address, 'en-GB'))).toBeNull();
  });
});

describe('PHILOBIBLOS_LOCALE', () => {
  const cfg = (v?: string) => loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', ...(v === undefined ? {} : { PHILOBIBLOS_LOCALE: v }) });
  it('a BCP 47 tag, canonical; unset or empty is none', () => {
    expect(cfg('de-ch').locale).toBe('de-CH');
    expect(cfg(' en ').locale).toBe('en');
    expect(cfg('').locale).toBeNull();
    expect(cfg().locale).toBeNull();
  });
  it('anything else stops the start', () => {
    for (const bad of ['not a tag!', 'de_CH_', '1234']) expect(() => cfg(bad), bad).toThrow(/PHILOBIBLOS_LOCALE/);
  });
});

describe('Compose writes in the shop\'s language, the plain list in the household\'s', () => {
  const SAMPLE = fileURLToPath(new URL('../../../seed-sample', import.meta.url));
  const MONTH = nextMonth(THIS_MONTH);
  const quill = CONNECTORS.get('quillmere')!.connector!;
  let db: Db, built: BuiltApp, cookie: string;
  const start = async (env: Record<string, string>) => {
    db = openDb(':memory:');
    importSeed(db, SAMPLE, '2026-11-01T00:00:00.000Z');
    enableShop(db);
    cookie = sessionCookie(db, db.select().from(t.person).all().find((p) => p.handle === 'alex')!.id);
    built = await buildApp(loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_SEALING_KEY: TEST_SEALING_KEY, ...env }), db, { connectors: CONNECTORS });
    await built.app.ready();
  };
  const send = (method: 'POST' | 'PATCH', url: string, payload: unknown) =>
    built.app.inject({ method, url, payload: JSON.stringify(payload), headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' } });
  afterAll(() => built?.app.close());

  beforeAll(() => start({ PHILOBIBLOS_LOCALE: 'en-GB' }));
  it('to the enabled shop\'s own order address: its language (here German), whatever the household\'s', async () => {
    expect(quill.locale.language).toBe('de');
    const r = await send('POST', '/api/orders', { month: MONTH });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().composeTo).toBe(quill.order!.to);
    expect(r.json().composeSubject).toMatch(/^Buchbestellung, /);
  });
  it('to an address no connector names: the household\'s language; the plain list too', async () => {
    expect((await send('PATCH', '/api/settings', { order: { bookshopEmail: 'orders@bookshop.example' } })).statusCode).toBe(200);
    expect((await send('POST', `/api/month/${MONTH}/picks`, { recompute: true })).statusCode).toBe(200);
    expect((await send('POST', '/api/orders', { month: MONTH })).json().composeSubject).toMatch(/^Book order, /);
    await built.app.close();
    await start({ PHILOBIBLOS_LOCALE: 'de-CH' });
    expect((await send('PATCH', '/api/settings', { order: { bookshopEmail: 'orders@bookshop.example' } })).statusCode).toBe(200);
    expect((await send('POST', '/api/orders', { month: MONTH })).json().composeSubject).toMatch(/^Buchbestellung, /);
    expect((await send('POST', `/api/month/${MONTH}/picks`, { recompute: true })).statusCode).toBe(200);
    expect((await send('POST', '/api/orders', { month: MONTH, list: true })).json().listSubject).toMatch(/^Buchbestellung, /);
  });
});
