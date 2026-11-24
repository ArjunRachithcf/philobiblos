// The mail reader (ADR 0007) against hostile mail: every message here is invented and signed by the test with keys
// it makes (the bookshop's domain stands in a fake DNS; nothing is looked up for real). The IMAP side has its own test
// against a real server (test/imap.test.ts, scripts/imap-test.sh); here a stand-in mailbox plays it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as t from '../src/db/schema';
import { refreshMail } from '../src/mail/job';
import { MailUnreadable, addressParts, mailDay, readMail, safeField } from '../src/mail/read';
import { addressDomains, headerBlock, verifyBookshopMail } from '../src/mail/verify';
import { dkimKeyResolver } from '../src/net/dns';
import { SEALED } from '../src/routes/month';
import { seal } from '../src/household/sealed';
import { TEST_SEALING_KEY, household } from './helpers';
import { CFG, HOUSEHOLD, SEALERS, SHOPS, evil, fakeBox, message, resolver, sealed, shop, signed } from './mailkit';

const verify = (raw: Buffer, dns = resolver) => verifyBookshopMail(raw, { shops: SHOPS, arcSealers: SEALERS, recipients: HOUSEHOLD, resolver: dns });

describe('is it the bookshop?', () => {
  it('signed by the bookshop\'s domain, aligned with its From: accepted', async () => {
    expect(await verify(await signed(message()))).toMatchObject({ accepted: true, via: 'dkim' });
  });

  it.each([
    ['a body changed after signing', async () => { const s = await signed(message()); return Buffer.from(s.toString().replace('CHF 19.90', 'CHF 1.90')); }],
    ['no signature at all', async () => message()],
    ['signed by another domain (not aligned)', async () => signed(message(), 'evil.example', evil)],
    ['the bookshop\'s name on someone else\'s address', async () => signed(message({ from: '"english-orders@quillmere.example" <a@evil.example>' }), 'evil.example', evil)],
    ['a look-alike domain', async () => signed(message({ from: 'x@quillmere.example.evil.example' }), 'evil.example', evil)],
    ['two From addresses', async () => signed(message({ from: 'english-orders@quillmere.example, a@evil.example' }))],
    ['two From headers', async () => signed(message({ extra: 'From: a@evil.example' }))],
    ['a Sender elsewhere', async () => signed(message({ extra: 'Sender: a@evil.example' }))],
    ['headers prepended above the signed ones (Subject, Message-ID, In-Reply-To, Date)', async () => Buffer.concat([Buffer.from('Subject: FORGED\r\nMessage-ID: <forged@x>\r\nIn-Reply-To: <forged-reply@x>\r\nDate: Mon, 1 Jan 2030 00:00:00 +0000\r\n'), await signed(message())])],
    ['a prepended Subject alone', async () => Buffer.concat([Buffer.from('Subject: FORGED\r\n'), await signed(message())])],
    ['a signature that does not cover the Subject, which was then changed', async () => Buffer.from((await signed(message(), 'quillmere.example', shop, { headerList: 'From:To:Date:Message-ID:MIME-Version:Content-Type' })).toString().replace('Subject: Re: Book order', 'Subject: CHANGED'))],
    ['a signature over part of the body (l=), with more appended', async () => Buffer.concat([await signed(message(), 'quillmere.example', shop, { maxBodyLength: 20 }), Buffer.from('Price correction: CHF 999.00, pay at https://evil.example\r\n')])],
    ['a genuine bookshop mail to someone else (a replay)', async () => signed(Buffer.from(message().toString().replace('To: shelf.household@example.org', 'To: stranger@example.com')))],
  ])('%s: not verified', async (_n, make) => {
    expect(await verify(await make())).toMatchObject({ accepted: false, via: null });
  });

  // The two count rules, each where only it applies (each would otherwise hide the other).
  it('two Subjects, both signed: only the once-only rule refuses it', async () => {
    const mail = await signed(message({ extra: 'Subject: a second subject' }), 'quillmere.example', shop, { headerList: 'From:To:Subject:Subject:Date:Message-ID:MIME-Version:Content-Type' });
    expect(await verify(mail)).toMatchObject({ accepted: false, reason: 'more than one subject header' });
  });

  it('a header that may repeat, signed once, with another above it: only the instance rule refuses it', async () => {
    const mail = Buffer.concat([Buffer.from('X-Order: forged\r\n'), await signed(message({ extra: 'X-Order: 1234567' }), 'quillmere.example', shop, { headerList: 'From:To:Subject:Date:Message-ID:MIME-Version:Content-Type:X-Order' })]);
    expect(await verify(mail)).toMatchObject({ accepted: false, reason: 'more x-order headers than were signed' });
  });

  it('a forward that broke the signature: accepted through a trusted provider\'s ARC seal that saw dkim=pass', async () => {
    // The bookshop's key is gone from DNS here (rotated, say): only the forwarder's ARC record can vouch for the mail.
    const noShopKey = async (n: string) => (n.startsWith('mail._domainkey.quillmere.example') ? Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })) : resolver(n));
    const mail = await sealed(await signed(message()), 'forwarder.example', 'mx.forwarder.example; dkim=pass header.i=@quillmere.example header.s=mail');
    expect(await verify(mail, noShopKey)).toMatchObject({ accepted: true, via: 'arc' });
  });

  it.each([
    ['sealed by a provider Philobiblos does not trust', () => sealed(message(), 'evil.example', 'mx.evil.example; dkim=pass header.i=@quillmere.example')],
    ['a trusted seal that saw the bookshop\'s DKIM fail', () => sealed(message(), 'forwarder.example', 'mx.forwarder.example; dkim=fail header.i=@quillmere.example')],
    ['a trusted seal that saw another domain pass', () => sealed(message(), 'forwarder.example', 'mx.forwarder.example; dkim=pass header.i=@evil.example')],
    ['a seal broken by a change after it', async () => Buffer.from((await sealed(message(), 'forwarder.example', 'mx.forwarder.example; dkim=pass header.i=@quillmere.example')).toString().replace('CHF 19.90', 'CHF 1.90'))],
  ])('%s: not verified', async (_n, make) => {
    expect(await verify(await make())).toMatchObject({ accepted: false });
  });

  it('addresses: quoted names and comments never count as the address', () => {
    expect(addressDomains('"a@quillmere.example" <b@evil.example>')).toEqual(['evil.example']);
    expect(addressDomains('Shop (x@quillmere.example) <b@quillmere.example>')).toEqual(['quillmere.example']);
    expect(addressDomains('a@x.example, b@y.example')).toEqual(['x.example', 'y.example']);
  });

  it('DNS: DKIM key records only, a few per mail; nothing else is looked up', async () => {
    const asked: string[] = [];
    const r = dkimKeyResolver(async (n) => { asked.push(n); return [['v=DKIM1']]; }, 2);
    await expect(r('quillmere.example', 'TXT')).rejects.toThrow(/not a DKIM key/);
    await expect(r('_dmarc.quillmere.example', 'TXT')).rejects.toThrow(/not a DKIM key/);
    await expect(r('mail._domainkey.quillmere.example', 'A')).rejects.toThrow(/not a DKIM key/);
    await expect(r('mail._domainkey.quillmere.example', 'TXT')).resolves.toBeTruthy();
    await r('s2._domainkey.quillmere.example', 'TXT');
    await expect(r('s3._domainkey.quillmere.example', 'TXT')).rejects.toThrow(/too many/);
    expect(asked).toEqual(['mail._domainkey.quillmere.example', 's2._domainkey.quillmere.example']);
  });
});

describe('the header block is strict, and what was parsed is what was signed', () => {
  // One line above a signed mail that a parser cannot read as a header ends the header block there: the signed
  // headers would become body, and the attacker's line the mail. Each variant is refused before anything is read.
  it.each([
    ['no colon', 'Price correction CHF 999.00 pay at evil.example'],
    ['an 8-bit name', 'Xé: Price correction CHF 999.00'],
    ['a space in the name', 'X Y: Price correction CHF 999.00'],
    ['a space before the colon', 'Subject : Price correction'],
    ['a NUL', 'X-Note: a\u0000b'],
    ['a continuation first', ' Price correction CHF 999.00'],
    ['a lone CR', 'X-Note: a\rSubject: forged'],
    // philobiblos#13: no bypass known, but parsers disagree on each, and genuine bookshop mail has none.
    ['a form feed', 'X-Note: a\fb'],
    ['a continuation that is only white space', 'X-Note: a\r\n \t'],
    ['an encoded word as a name', '=?utf-8?q?Subject?=: forged'],
  ])('a line with %s above the signed headers: refused', async (_n, line) => {
    const mail = Buffer.concat([Buffer.from(`${line}\r\n`, 'latin1'), await signed(message())]);
    expect(headerBlock(mail)).toHaveProperty('problem');
    expect(await verify(mail)).toMatchObject({ accepted: false });
  });

  it('the parser\'s Subject, Message-ID, From and Date must equal those of the verified block', async () => {
    const good = await signed(message({ id: 'same1' }));
    const hb = headerBlock(good);
    if (!('block' in hb)) throw new Error('strict block expected');
    await expect(readMail(good, hb.block)).resolves.toMatchObject({ content: { messageId: '<same1@quillmere.example>', subject: 'Re: Book order' } });
    // A block that is not this mail's (as if the parser had read other headers than the verified ones): refused.
    const other = headerBlock(message({ id: 'other1', subject: 'Something else' }));
    if (!('block' in other)) throw new Error('strict block expected');
    await expect(readMail(good, other.block)).rejects.toMatchObject({ code: 'headers_differ' });
    // The same instant in another zone names another day (philobiblos#53): the Date header itself must be the block's.
    const zoned = headerBlock(message({ id: 'same1', date: 'Mon, 16 Nov 2026 00:00:00 -0900' }));
    if (!('block' in zoned)) throw new Error('strict block expected');
    const late = await signed(message({ id: 'same1', date: 'Mon, 16 Nov 2026 10:00:00 +0100' }));
    await expect(readMail(late, zoned.block)).rejects.toMatchObject({ code: 'headers_differ' });
  });

  it('a mail\'s day is the one its Date header names in its own zone; anything else is none (philobiblos#53)', () => {
    expect(mailDay('Thu, 12 Nov 2026 00:30:00 +0100')).toBe('2026-11-12T00:00:00.000Z');
    expect(mailDay('12 Nov 2026 23:59:59 -1100')).toBe('2026-11-12T00:00:00.000Z');
    expect(mailDay('Sun, 1 Mar 2026 08:00:00 +0000')).toBe('2026-03-01T00:00:00.000Z');
    for (const bad of ['Mon, 31 Feb 2026 08:00:00 +0000', 'Mon, 0 Nov 2026 08:00:00 +0000', '12 Foo 2026 08:00:00 +0000', '12 Nov 0026 08:00 +0000', '2026-11-12T08:00:00Z', 'garbage', '', null, undefined]) {
      expect(mailDay(bad), String(bad)).toBeNull();
    }
  });

  it('a verified mail keeps no text: only its fields, and where it is in the mailbox', async () => {
    const db = household();
    const mail = await signed(message({ id: 'fields1', body: 'Delivery to: Somewhere Street 1, 8000 Exampletown\r\nCard 4111 1111 1111 1111\r\nTotal CHF 19.90' }));
    await refreshMail(db, CFG, { open: async () => fakeBox([{ uid: 6, raw: mail }]), resolver });
    const kept = JSON.parse(db.select().from(t.mailSeen).get()!.parsedJson!);
    // A quote with no book in it is a layout Philobiblos does not know: refused, and only that is kept.
    expect(kept).toEqual({ subject: 'Re: Book order', date: expect.any(String), day: '2026-11-16T00:00:00.000Z', messageId: '<fields1@quillmere.example>', inReplyTo: null, pdfs: 0, uidValidity: 7, uid: 6, parser: 'quote-1', expected: 'bookshop_quote', reason: 'no books' });
    expect(JSON.stringify(kept)).not.toMatch(/Somewhere|4111|19\.90/);
  });
});

describe('a kept field never holds the address or a long number', () => {
  const parts = addressParts('Alex Example\nExample Street 1\n8000 Zurich');
  it.each([
    ['the address as written', 'Example Street 1'], ['diacritics', 'CH-8000 Zürich'], ['Str.', 'Example Str. 1'], ['strasse', 'Examplestrasse 1'],
    ['a soft hyphen', 'Exam­ple Street 1'], ['a zero-width space', 'Example​ Street 1'], ['other case and spacing', 'EXAMPLE   street 1'],
  ])('%s: dropped', (_n, v) => expect(safeField(`Delivered to ${v}`, parts)).toBeNull());

  it.each([
    ['spaces', '4111 1111 1111 1111'], ['an en dash', '4111–1111–1111–1111'], ['apostrophes', "4111'1111'1111'1111"], ['underscores', '4111_1111_1111_1111'],
    ['commas', '4111,1111,1111,1111'], ['zero-width spaces', '4111​1111​1111​1111'], ['" - "', '4111 - 1111 - 1111 - 1111'], ['full-width digits', '４１１１ 1111 1111 1111'],
    ['slashes', '4111/1111/1111/1111'], ['NBSP', '4111 1111 1111 1111'],
  ])('a card-like number with %s: dropped', (_n, v) => expect(safeField(`Card ${v}`, [])).toBeNull());

  // philobiblos#13's residue, against an address whose name and street share no word (so each rule is tested alone).
  const other = addressParts('Alex Brightwater\nBahnhofstrasse 12\n8000 Zürich');
  it.each([
    ['a compound street abbreviated', 'Bahnhofstr. 12'], ['ue for ü', 'CH-8000 Zuerich'], ['the surname alone', 'Herr Brightwater'],
    ['the name reversed', 'Brightwater, Alex'],
  ])('%s: dropped', (_n, v) => expect(safeField(`Delivered to ${v}`, other)).toBeNull());
  it('a common street word on its own is no reason to drop a field', () => expect(safeField('Strasse der Bücher', addressParts('A Reader\nLange Strasse 1'))).toBe('Strasse der Bücher'));

  it('what may stay: an ISBN as the whole field, a price, an order number, ordinary words', () => {
    expect(safeField('978-0-00-000000-2', [])).toBe('978-0-00-000000-2');
    expect(safeField('Re: Ihre Bestellung 1234567', parts)).toBe('Re: Ihre Bestellung 1234567');
    expect(safeField('Total CHF 19.90', parts)).toBe('Total CHF 19.90');
    expect(safeField(42, [])).toBeNull();
  });

  it('hostile input costs linear time: a From of 200k (, a field of 1M digits and separators', async () => {
    const t0 = Date.now();
    expect(await verify(message({ from: `${'('.repeat(200_000)} a@quillmere.example` }))).toMatchObject({ accepted: false, reason: 'a header is too long' });
    expect(safeField('1 '.repeat(500_000), [])).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('MIME nested too deep, or too many parts: unreadable, not a crash', async () => {
    let body = 'x';
    for (let i = 0; i < 12; i++) body = [`Content-Type: multipart/mixed; boundary="d${i}"`, '', `--d${i}`, body, `--d${i}--`].join('\r\n');
    const deep = Buffer.from(`From: a@quillmere.example\r\nMIME-Version: 1.0\r\n${body}\r\n`);
    const block = (b: Buffer) => { const h = headerBlock(b); return 'block' in h ? h.block : Buffer.alloc(0); };
    await expect(readMail(deep, block(deep))).rejects.toBeInstanceOf(MailUnreadable);
    const wide = Buffer.from(`From: a@quillmere.example\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="w"\r\n\r\n${Array.from({ length: 100 }, () => '--w\r\nContent-Type: text/plain\r\n\r\nx\r\n').join('')}--w--\r\n`);
    await expect(readMail(wide, block(wide))).rejects.toBeInstanceOf(MailUnreadable);
  });

  it('PDFs are only counted (by their bytes); nothing of them is kept', async () => {
    const b = 'b1';
    const part = (name: string, bytes: Buffer) => [`--${b}`, `Content-Type: application/pdf; name="${name}"`, 'Content-Transfer-Encoding: base64', '', bytes.toString('base64'), ''].join('\r\n');
    const raw = Buffer.from(['From: english-orders@quillmere.example', 'Subject: Ihre Rechnung', 'Message-ID: <inv1@quillmere.example>', 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${b}"`, '',
      `--${b}`, 'Content-Type: text/plain', '', 'See the invoice.', '', part('invoice.pdf', Buffer.from('%PDF-1.4 made up')), part('not-really.pdf', Buffer.from('MZ an executable')), `--${b}--`, ''].join('\r\n'));
    const h = headerBlock(raw);
    expect(await readMail(raw, 'block' in h ? h.block : Buffer.alloc(0))).toMatchObject({ content: { pdfs: 1 } });
  });
});


describe('the mail job', () => {
  it('records each mail once: verified with its content, not verified with only Philobiblos\'s reason', async () => {
    const db = household();
    const good = await signed(message({ id: 'good1' }));
    const forged = message({ id: 'forged1', from: 'english-orders@quillmere.example', body: 'Pay here: https://evil.example' });
    const box = fakeBox([{ uid: 3, raw: good }, { uid: 5, raw: forged }]);
    const cfg = CFG;
    expect(await refreshMail(db, cfg, { open: async () => box, resolver })).toMatchObject({ status: 'done', detail: '2 new: 1 verified, 1 not verified, 0 seen before' });
    const rows = db.select().from(t.mailSeen).all();
    expect(rows.find((r) => r.messageId === '<good1@quillmere.example>')).toMatchObject({ accepted: 1, kind: 'bookshop_quote' });
    expect(JSON.parse(rows.find((r) => r.accepted === 1)!.parsedJson!)).toMatchObject({ subject: 'Re: Book order', uid: 3 });
    // An unverified mail never claims its Message-ID: it is kept under a hash of its bytes.
    const bad = rows.find((r) => r.accepted === 0)!;
    expect(bad.messageId).toMatch(/^unverified:[0-9a-f]{64}$/);
    expect(bad).toMatchObject({ accepted: 0, kind: 'not_verified', parsedJson: null });
    expect(bad.authJson).not.toContain('evil');
    expect(db.select().from(t.mailCursor).where(eq(t.mailCursor.folder, 'INBOX')).get()).toMatchObject({ uidValidity: 7, lastUid: 5 });
    expect(box.closed).toBe(1);

    // Again: nothing new. A new UIDVALIDITY starts over: the verified one is known, the other is checked again, and
    // nothing is recorded twice.
    expect((await refreshMail(db, cfg, { open: async () => fakeBox([{ uid: 3, raw: good }, { uid: 5, raw: forged }]), resolver })).detail).toBe('0 new: 0 verified, 0 not verified, 0 seen before');
    expect((await refreshMail(db, cfg, { open: async () => fakeBox([{ uid: 1, raw: good }, { uid: 2, raw: forged }], 8), resolver })).detail).toBe('2 new: 0 verified, 1 not verified, 1 seen before');
    expect(db.select().from(t.mailSeen).all()).toHaveLength(2);
  });

  it('a forgery cannot take the Message-ID of the genuine mail after it', async () => {
    const db = household();
    const forged = message({ id: 'next', body: 'Pay here' });
    const genuine = await signed(message({ id: 'next' }));
    await refreshMail(db, CFG, { open: async () => fakeBox([{ uid: 1, raw: forged }, { uid: 2, raw: genuine }]), resolver });
    expect(db.select().from(t.mailSeen).where(eq(t.mailSeen.messageId, '<next@quillmere.example>')).get()).toMatchObject({ accepted: 1 });
    expect(db.select().from(t.mailSeen).all().filter((r) => r.accepted === 0).map((r) => r.messageId)).toEqual([expect.stringMatching(/^unverified:[0-9a-f]{64}$/)]);
  });

  it('a mail refused under the old settings is checked again under the new ones (and then counts)', async () => {
    const db = household();
    const noShopKey = async (n: string) => (n.startsWith('mail._domainkey.quillmere.example') ? Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })) : resolver(n));
    const forward = await sealed(await signed(message({ id: 'fwd1' })), 'forwarder.example', 'mx.forwarder.example; dkim=pass header.i=@quillmere.example');
    const box = () => fakeBox([{ uid: 4, raw: forward }]);
    await refreshMail(db, { ...CFG, arcSealers: [] }, { open: async () => box(), resolver: noShopKey });
    expect(db.select().from(t.mailSeen).all().map((r) => r.accepted)).toEqual([0]);
    await refreshMail(db, CFG, { open: async () => box(), resolver: noShopKey });
    expect(db.select().from(t.mailSeen).all().map((r) => [r.messageId, r.accepted])).toEqual([['<fwd1@quillmere.example>', 1]]);
  });

  it('the first run reads a window (90 days), not the whole mailbox; later runs go on by UID', async () => {
    const db = household();
    const asked: (Date | undefined)[] = [];
    const box = fakeBox([{ uid: 1, raw: await signed(message({ id: 'w1' })) }]);
    const list = box.list.bind(box);
    box.list = async (a, m, since) => { asked.push(since); return list(a, m); };
    const now = new Date('2026-11-16T10:00:00Z');
    await refreshMail(db, CFG, { open: async () => box, resolver, now: () => now });
    await refreshMail(db, CFG, { open: async () => box, resolver, now: () => now });
    expect(asked).toEqual([new Date('2026-08-18T10:00:00Z'), undefined]);
  });

  it('the delivery address (sealed) is kept out of every field; a key that cannot open it reads nothing', async () => {
    const db = household();
    const key = Buffer.from(TEST_SEALING_KEY, 'base64');
    seal(db, key, SEALED.deliveryAddress, 'A Reader\nSomewhere Street 1\n8000 Exampletown');
    const mail = await signed(message({ id: 'conf1', subject: 'Your order to Somewhere Street 1' }));
    await refreshMail(db, { ...CFG, sealingKey: { value: TEST_SEALING_KEY } }, { open: async () => fakeBox([{ uid: 1, raw: mail }]), resolver });
    const kept = JSON.parse(db.select().from(t.mailSeen).get()!.parsedJson!);
    expect(kept.subject).toBeNull();
    expect(JSON.stringify(kept)).not.toMatch(/Somewhere|Exampletown/);
    const other = household();
    seal(other, key, SEALED.deliveryAddress, 'A Reader');
    expect(await refreshMail(other, { ...CFG, sealingKey: { value: Buffer.alloc(32, 9).toString('base64') } }, { open: async () => fakeBox([{ uid: 1, raw: mail }]), resolver })).toMatchObject({ status: 'blocked' });
    expect(other.select().from(t.mailSeen).all()).toEqual([]);
  });

  it('a verified mail is keyed by its Message-ID as signed, not by the server\'s envelope', async () => {
    const db = household();
    const mail = await signed(message({ id: 'signed-id' }));
    const box = fakeBox([{ uid: 1, raw: mail }]);
    const list = box.list.bind(box);
    box.list = async (a, m) => (await list(a, m)).map((x) => ({ ...x, messageId: '<envelope-says-other@x>' }));
    await refreshMail(db, CFG, { open: async () => box, resolver });
    expect(db.select().from(t.mailSeen).all().map((r) => r.messageId)).toEqual(['<signed-id@quillmere.example>']);
  });

  it('no mailbox set up, or one that refuses: the run says so, and never the password', async () => {
    const db = household();
    expect(await refreshMail(db, { ...CFG, imap: null })).toMatchObject({ status: 'blocked' });
    const out = await refreshMail(db, CFG, { open: async () => { const { MailboxError } = await import('../src/net/imap'); throw new MailboxError('cannot sign in to imap.example.org:993 over TLS'); } });
    expect(out).toMatchObject({ status: 'failed' });
    expect(out.detail).not.toContain('not-a-real-password');
  });
});

describe('the mail boundary (architecture)', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(f) ? [p] : []; });
  const src = files(root).map((f) => ({ f: relative(root, f), s: readFileSync(f, 'utf8') }));
  it('imapflow only in net/imap.ts; mailauth only in mail/verify.ts, its alignment only in net/domains.ts; DNS only in net/', () => {
    expect(src.filter((x) => /from ['"]imapflow['"]/.test(x.s)).map((x) => x.f)).toEqual(['net/imap.ts']);
    expect(src.filter((x) => /from ['"]mailauth['"]/.test(x.s)).map((x) => x.f)).toEqual(['mail/verify.ts']);
    expect(src.filter((x) => /from ['"]mailauth\//.test(x.s)).map((x) => x.f)).toEqual(['net/domains.ts']);
    expect(src.filter((x) => /from ['"]node:dns/.test(x.s)).map((x) => x.f).sort()).toEqual(['net/dns.ts', 'net/egress.ts']);
  });
  it('the IMAP connection reads and never changes: no flag, move, copy, delete, expunge or append', () => {
    const s = src.find((x) => x.f === 'net/imap.ts')!.s.replace(/^\s*\/\/.*$/gm, '');
    expect(s).not.toMatch(/messageFlags|messageMove|messageCopy|messageDelete|expunge|append\(|mailboxCreate|mailboxDelete|mailboxRename|setFlag|\.exec\(|run\(/i);
    expect(s).toMatch(/readOnly: true/);
    expect(s).toMatch(/rejectUnauthorized: true/);
  });
});
