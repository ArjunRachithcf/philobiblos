// The mail reader (ADR 0007) against hostile mail: every message here is invented and signed by the test with keys
// it makes (the bookshop's domain stands in a fake DNS; nothing is looked up for real). The IMAP side has its own test
// against a real server (test/imap.test.ts, scripts/imap-test.sh); here a stand-in mailbox plays it.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { sealMessage } from 'mailauth';
import { dkimSign } from 'mailauth/lib/dkim/sign';
import { describe, expect, it } from 'vitest';
import * as t from '../src/db/schema';
import { MediaUnavailable } from '../src/media/client';
import { refreshMail } from '../src/mail/job';
import { MailUnreadable, htmlText, keepText, readMail } from '../src/mail/read';
import { addressDomains, verifyBookshopMail } from '../src/mail/verify';
import { dkimKeyResolver } from '../src/net/dns';
import type { Mailbox } from '../src/net/imap';
import { household } from './helpers';

const key = () => generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const shop = key(), google = key(), evil = key();
const record = (k: ReturnType<typeof key>) => [[`v=DKIM1; k=rsa; p=${k.publicKey.toString('base64')}`]];
const DNS: Record<string, string[][]> = {
  'mail._domainkey.orellfuessli.ch': record(shop),
  'arc._domainkey.google.com': record(google),
  'arc._domainkey.evil.example': record(evil),
  'mail._domainkey.evil.example': record(evil),
};
const resolver = async (name: string) => { const r = DNS[name.toLowerCase()]; if (!r) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); return r; };
const SEALERS = ['google.com'];

function message(o: { from?: string; extra?: string; body?: string; id?: string; subject?: string; html?: boolean } = {}): Buffer {
  return Buffer.from([
    `From: ${o.from ?? 'English Bookshop <english-orders@orellfuessli.ch>'}`,
    'To: shelf.household@example.org',
    `Subject: ${o.subject ?? 'Re: Book order'}`,
    `Message-ID: <${o.id ?? `m${Math.random().toString(36).slice(2)}`}@orellfuessli.ch>`,
    'Date: Mon, 16 Nov 2026 09:00:00 +0100',
    ...(o.extra ? [o.extra] : []),
    'MIME-Version: 1.0',
    `Content-Type: ${o.html ? 'text/html' : 'text/plain'}; charset=utf-8`,
    '',
    o.body ?? 'Dear customer,\r\nAuthor: Mira Okafor / Title: The Long Tide of Markets / ISBN: 9780000000002 / Price: CHF 19.90\r\nKind regards',
    '',
  ].join('\r\n'));
}
async function signed(raw: Buffer, domain = 'orellfuessli.ch', k = shop): Promise<Buffer> {
  const r = await dkimSign(raw, { signatureData: [{ signingDomain: domain, selector: 'mail', privateKey: k.privateKey }] });
  return Buffer.concat([Buffer.from(r.signatures), raw]);
}
async function sealed(raw: Buffer, by: 'google.com' | 'evil.example', authResults: string): Promise<Buffer> {
  const h = await sealMessage(raw, { signingDomain: by, selector: 'arc', privateKey: (by === 'google.com' ? google : evil).privateKey, authResults, cv: 'none' });
  return Buffer.concat([h, raw]);
}
const verify = (raw: Buffer, dns = resolver) => verifyBookshopMail(raw, { arcSealers: SEALERS, resolver: dns });

describe('is it the bookshop?', () => {
  it('signed by the bookshop\'s domain, aligned with its From: accepted', async () => {
    expect(await verify(await signed(message()))).toMatchObject({ accepted: true, via: 'dkim' });
  });

  it.each([
    ['a body changed after signing', async () => { const s = await signed(message()); return Buffer.from(s.toString().replace('CHF 19.90', 'CHF 1.90')); }],
    ['no signature at all', async () => message()],
    ['signed by another domain (not aligned)', async () => signed(message(), 'evil.example', evil)],
    ['the bookshop\'s name on someone else\'s address', async () => signed(message({ from: '"english-orders@orellfuessli.ch" <a@evil.example>' }), 'evil.example', evil)],
    ['a look-alike domain', async () => signed(message({ from: 'x@orellfuessli.ch.evil.example' }), 'evil.example', evil)],
    ['two From addresses', async () => signed(message({ from: 'english-orders@orellfuessli.ch, a@evil.example' }))],
    ['two From headers', async () => signed(message({ extra: 'From: a@evil.example' }))],
    ['a Sender elsewhere', async () => signed(message({ extra: 'Sender: a@evil.example' }))],
  ])('%s: not verified', async (_n, make) => {
    expect(await verify(await make())).toMatchObject({ accepted: false, via: null });
  });

  it('a forward that broke the signature: accepted through a trusted provider\'s ARC seal that saw dkim=pass', async () => {
    // The bookshop's key is gone from DNS here (rotated, say): only the forwarder's ARC record can vouch for the mail.
    const noShopKey = async (n: string) => (n.startsWith('mail._domainkey.orellfuessli.ch') ? Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })) : resolver(n));
    const mail = await sealed(await signed(message()), 'google.com', 'mx.google.com; dkim=pass header.i=@orellfuessli.ch header.s=mail');
    expect(await verify(mail, noShopKey)).toMatchObject({ accepted: true, via: 'arc' });
  });

  it.each([
    ['sealed by a provider Shelf does not trust', () => sealed(message(), 'evil.example', 'mx.evil.example; dkim=pass header.i=@orellfuessli.ch')],
    ['a trusted seal that saw the bookshop\'s DKIM fail', () => sealed(message(), 'google.com', 'mx.google.com; dkim=fail header.i=@orellfuessli.ch')],
    ['a trusted seal that saw another domain pass', () => sealed(message(), 'google.com', 'mx.google.com; dkim=pass header.i=@evil.example')],
    ['a seal broken by a change after it', async () => Buffer.from((await sealed(message(), 'google.com', 'mx.google.com; dkim=pass header.i=@orellfuessli.ch')).toString().replace('CHF 19.90', 'CHF 1.90'))],
  ])('%s: not verified', async (_n, make) => {
    expect(await verify(await make())).toMatchObject({ accepted: false });
  });

  it('addresses: quoted names and comments never count as the address', () => {
    expect(addressDomains('"a@orellfuessli.ch" <b@evil.example>')).toEqual(['evil.example']);
    expect(addressDomains('Shop (x@orellfuessli.ch) <b@orellfuessli.ch>')).toEqual(['orellfuessli.ch']);
    expect(addressDomains('a@x.example, b@y.example')).toEqual(['x.example', 'y.example']);
  });

  it('DNS: DKIM key records only, a few per mail; nothing else is looked up', async () => {
    const asked: string[] = [];
    const r = dkimKeyResolver(async (n) => { asked.push(n); return [['v=DKIM1']]; }, 2);
    await expect(r('orellfuessli.ch', 'TXT')).rejects.toThrow(/not a DKIM key/);
    await expect(r('_dmarc.orellfuessli.ch', 'TXT')).rejects.toThrow(/not a DKIM key/);
    await expect(r('mail._domainkey.orellfuessli.ch', 'A')).rejects.toThrow(/not a DKIM key/);
    await expect(r('mail._domainkey.orellfuessli.ch', 'TXT')).resolves.toBeTruthy();
    await r('s2._domainkey.orellfuessli.ch', 'TXT');
    await expect(r('s3._domainkey.orellfuessli.ch', 'TXT')).rejects.toThrow(/too many/);
    expect(asked).toEqual(['mail._domainkey.orellfuessli.ch', 's2._domainkey.orellfuessli.ch']);
  });
});

describe('what is kept of a mail', () => {
  const noMedia = async () => { throw new Error('no PDF expected'); };

  it('the bookshop\'s words only: quoted lines and the household\'s own request below a reply header are dropped', () => {
    const text = [
      'Dear customer, here is your quote.', 'ISBN: 978-0-00-000000-2 Price: CHF 19.90', '',
      '> Premium Card number: 1234 5678 9012 3456', 'On Mon, 16 Nov 2026, A Reader wrote:', 'Delivered to: Somewhere Street 1', 'Premium Card number: 1234567890123456',
    ].join('\n');
    const kept = keepText(text);
    expect(kept).toContain('CHF 19.90');
    expect(kept).toContain('978-0-00-000000-2');
    expect(kept).not.toMatch(/1234|Somewhere|Premium/);
    expect(keepText('Your card 4111 1111 1111 1111 is noted')).toBe('Your card [number removed] is noted');
  });

  it('HTML: words only; no tag, link, script or image survives', () => {
    const t0 = htmlText('<p>Price <a href="https://evil.example/x">CHF 19.90</a><img src="https://evil.example/t.gif"><script>steal()</script></p>');
    expect(t0).toContain('CHF 19.90');
    expect(t0).not.toMatch(/evil|href|steal|<|img/);
  });

  it('only PDFs (by their bytes) go to the media worker; another file called .pdf, or an image, is never read', async () => {
    const b = 'b1';
    const part = (name: string, type: string, bytes: Buffer) => [`--${b}`, `Content-Type: ${type}; name="${name}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${name}"`, '', bytes.toString('base64'), ''].join('\r\n');
    const raw = Buffer.from([
      'From: english-orders@orellfuessli.ch', 'Subject: Ihre Rechnung', 'Message-ID: <inv1@orellfuessli.ch>', 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${b}"`, '',
      `--${b}`, 'Content-Type: text/plain', '', 'See the invoice.', '',
      part('invoice.pdf', 'application/pdf', Buffer.from('%PDF-1.4 made up')),
      part('not-really.pdf', 'application/pdf', Buffer.from('MZ\x90\x00 an executable')),
      part('photo.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
      `--${b}--`, '',
    ].join('\r\n'));
    const handed: string[] = [];
    const c = await readMail(raw, async (kind, input) => { handed.push(Buffer.from(input).toString('latin1')); return { id: 'x', ok: true, kind, pages: 1, rows: [['9780000000002', 'A Made-up Title', '19.90']], truncated: false }; });
    expect(handed).toEqual(['%PDF-1.4 made up']);
    expect(c.pdfs).toEqual([{ name: 'invoice.pdf', pages: 1, rows: [['9780000000002', 'A Made-up Title', '19.90']], truncated: false }]);
    expect(c.text).toBe('See the invoice.');
  });

  it('hostile HTML and headers cost linear time: 4 MB of <, an unclosed script, a From of 200k (', async () => {
    let t0 = Date.now();
    htmlText('<'.repeat(4 << 20));
    htmlText(`<script>${'<'.repeat(1 << 20)}`);
    expect(Date.now() - t0).toBeLessThan(500);
    t0 = Date.now();
    expect(await verify(message({ from: `${'('.repeat(200_000)} a@orellfuessli.ch` }))).toMatchObject({ accepted: false, reason: 'a header is too long' });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(htmlText('<p>Line one</p><p>Line <b>two</b></p>')).toBe('Line one\nLine two');
  });

  it('MIME nested too deep, or too many parts: unreadable, not a crash', async () => {
    let body = 'x';
    for (let i = 0; i < 12; i++) body = [`Content-Type: multipart/mixed; boundary="d${i}"`, '', `--d${i}`, body, `--d${i}--`].join('\r\n');
    const deep = Buffer.from(`From: a@orellfuessli.ch\r\nMIME-Version: 1.0\r\n${body}\r\n`);
    await expect(readMail(deep, noMedia)).rejects.toBeInstanceOf(MailUnreadable);
    const wide = Buffer.from(`From: a@orellfuessli.ch\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="w"\r\n\r\n${Array.from({ length: 100 }, () => '--w\r\nContent-Type: text/plain\r\n\r\nx\r\n').join('')}--w--\r\n`);
    await expect(readMail(wide, noMedia)).rejects.toBeInstanceOf(MailUnreadable);
  });
});

/** A stand-in mailbox: these messages, these UIDs. */
function fakeBox(msgs: { uid: number; raw: Buffer }[], uidValidity = 7): Mailbox & { closed: number } {
  const box = {
    uidValidity, closed: 0,
    async list(after: number, max: number) {
      return msgs.filter((m) => m.uid > after).slice(0, max).map((m) => ({ uid: m.uid, size: m.raw.length, messageId: /Message-ID: (<[^>]+>)/i.exec(m.raw.toString())?.[1] ?? null }));
    },
    async source(uid: number) { return msgs.find((m) => m.uid === uid)?.raw ?? null; },
    async close() { box.closed++; },
  };
  return box;
}
const IMAP = { host: 'imap.example.org', user: 'shelf', password: { value: 'not-a-real-password' }, folder: 'INBOX' };

describe('the mail job', () => {
  it('records each mail once: verified with its content, not verified with only Shelf\'s reason', async () => {
    const db = household();
    const good = await signed(message({ id: 'good1' }));
    const forged = message({ id: 'forged1', from: 'english-orders@orellfuessli.ch', body: 'Pay here: https://evil.example' });
    const box = fakeBox([{ uid: 3, raw: good }, { uid: 5, raw: forged }]);
    const cfg = { imap: IMAP, workDir: null, arcSealers: SEALERS };
    expect(await refreshMail(db, cfg, { open: async () => box, resolver })).toMatchObject({ status: 'done', detail: '2 new: 1 verified, 1 not verified, 0 seen before' });
    const rows = db.select().from(t.mailSeen).all();
    expect(rows.find((r) => r.messageId === '<good1@orellfuessli.ch>')).toMatchObject({ accepted: 1, kind: 'unclassified' });
    expect(JSON.parse(rows.find((r) => r.accepted === 1)!.parsedJson!).text).toContain('CHF 19.90');
    const bad = rows.find((r) => r.messageId === '<forged1@orellfuessli.ch>')!;
    expect(bad).toMatchObject({ accepted: 0, kind: 'not_verified', parsedJson: null });
    expect(bad.authJson).not.toContain('evil');
    expect(db.select().from(t.mailCursor).where(eq(t.mailCursor.folder, 'INBOX')).get()).toMatchObject({ uidValidity: 7, lastUid: 5 });
    expect(box.closed).toBe(1);

    // Again: nothing new. A new UIDVALIDITY starts over, and nothing is recorded twice.
    expect((await refreshMail(db, cfg, { open: async () => fakeBox([{ uid: 3, raw: good }, { uid: 5, raw: forged }]), resolver })).detail).toBe('0 new: 0 verified, 0 not verified, 0 seen before');
    expect((await refreshMail(db, cfg, { open: async () => fakeBox([{ uid: 1, raw: good }, { uid: 2, raw: forged }], 8), resolver })).detail).toBe('2 new: 0 verified, 0 not verified, 2 seen before');
    expect(db.select().from(t.mailSeen).all()).toHaveLength(2);
  });

  it('without the media worker, a mail with a PDF is left for the next run (the cursor stays before it)', async () => {
    const db = household();
    const b = 'p';
    const withPdf = await signed(Buffer.from(['From: english-orders@orellfuessli.ch', 'To: shelf@example.org', 'Subject: Rechnung', 'Message-ID: <pdf1@orellfuessli.ch>', 'Date: Mon, 16 Nov 2026 09:00:00 +0100', 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${b}"`, '',
      `--${b}`, 'Content-Type: text/plain', '', 'Invoice attached.', `--${b}`, 'Content-Type: application/pdf', 'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-1.4 x').toString('base64'), `--${b}--`, ''].join('\r\n')));
    const out = await refreshMail(db, { imap: IMAP, workDir: null, arcSealers: SEALERS }, { open: async () => fakeBox([{ uid: 9, raw: withPdf }]), resolver, media: async () => { throw new MediaUnavailable(); } });
    expect(out.status).toBe('blocked');
    expect(db.select().from(t.mailSeen).all()).toEqual([]);
    expect(db.select().from(t.mailCursor).all()).toEqual([]);
  });

  it('no mailbox set up, or one that refuses: the run says so, and never the password', async () => {
    const db = household();
    expect(await refreshMail(db, { imap: null, workDir: null, arcSealers: SEALERS })).toMatchObject({ status: 'blocked' });
    const out = await refreshMail(db, { imap: IMAP, workDir: null, arcSealers: SEALERS }, { open: async () => { const { MailboxError } = await import('../src/net/imap'); throw new MailboxError('cannot sign in to imap.example.org:993 over TLS'); } });
    expect(out).toMatchObject({ status: 'failed' });
    expect(out.detail).not.toContain('not-a-real-password');
  });
});

describe('the mail boundary (architecture)', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(f) ? [p] : []; });
  const src = files(root).map((f) => ({ f: relative(root, f), s: readFileSync(f, 'utf8') }));
  it('imapflow only in net/imap.ts; mailauth only in mail/verify.ts; DNS only in net/', () => {
    expect(src.filter((x) => /from ['"]imapflow['"]/.test(x.s)).map((x) => x.f)).toEqual(['net/imap.ts']);
    expect(src.filter((x) => /from ['"]mailauth/.test(x.s)).map((x) => x.f)).toEqual(['mail/verify.ts']);
    expect(src.filter((x) => /from ['"]node:dns/.test(x.s)).map((x) => x.f).sort()).toEqual(['net/dns.ts', 'net/egress.ts']);
  });
  it('the IMAP connection reads and never changes: no flag, move, copy, delete, expunge or append', () => {
    const s = src.find((x) => x.f === 'net/imap.ts')!.s.replace(/^\s*\/\/.*$/gm, '');
    expect(s).not.toMatch(/messageFlags|messageMove|messageCopy|messageDelete|expunge|append\(|mailboxCreate|mailboxDelete|mailboxRename|setFlag|\.exec\(|run\(/i);
    expect(s).toMatch(/readOnly: true/);
    expect(s).toMatch(/rejectUnauthorized: true/);
  });
});
