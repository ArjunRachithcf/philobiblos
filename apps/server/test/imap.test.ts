// The IMAP connection against a real server: GreenMail in its own container (scripts/imap-test.sh starts it with
// fixtures/tls, a certificate made for these tests only, for the name imap.test). Skipped unless that script runs it.
// Mails are invented and delivered over the server's own SMTP port; the bookshop's DKIM key is in a fake DNS.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { ImapFlow } from 'imapflow';
import { dkimSign } from 'mailauth/lib/dkim/sign';
import { describe, expect, it } from 'vitest';
import * as t from '../src/db/schema';
import { refreshMail } from '../src/mail/job';
import { MailboxError, openMailbox, type MailboxConfig, type MailboxPlace, type Secret } from '../src/net/imap';
import { household } from './helpers';
import { CONNECTORS } from './mailkit';

const IMAPS = Number(process.env.PHILOBIBLOS_IMAP_TEST_PORT ?? 0);
const SMTP = Number(process.env.PHILOBIBLOS_SMTP_TEST_PORT ?? 0);
const CA = readFileSync(new URL('./fixtures/tls/cert.pem', import.meta.url), 'utf8');
const USER = 'shelf@shelf.test', PASS = 'test-password';
const cfg = (o: Partial<MailboxPlace> & { password?: Secret } = {}, test: Partial<NonNullable<MailboxConfig['test']>> = {}): MailboxPlace & { password: Secret } =>
  ({ host: 'imap.test', user: USER, password: { value: PASS }, folder: 'INBOX', port: IMAPS, ...o, test: { ca: CA, connectTo: '127.0.0.1', ...test } });

/** SMTP, just enough to hand GreenMail a message. */
async function deliver(raw: Buffer): Promise<void> {
  const s = net.connect(SMTP, '127.0.0.1');
  const lines: string[] = [];
  s.on('data', (d) => lines.push(d.toString()));
  const wait = (code: string) => new Promise<void>((ok, fail) => {
    const t0 = Date.now();
    const tick = () => (lines.join('').split('\r\n').some((l) => l.startsWith(code)) ? (lines.length = 0, ok()) : Date.now() - t0 > 5000 ? fail(new Error(`no ${code}: ${lines.join('')}`)) : setTimeout(tick, 10));
    tick();
  });
  await wait('220');
  for (const [cmd, code] of [['EHLO test', '250 '], ['MAIL FROM:<english-orders@quillmere.example>', '250'], [`RCPT TO:<${USER}>`, '250'], ['DATA', '354']] as const) { s.write(`${cmd}\r\n`); await wait(code); }
  s.write(Buffer.concat([Buffer.from(raw.toString('latin1').replace(/\r\n\./g, '\r\n..'), 'latin1'), Buffer.from('\r\n.\r\n')])); // dot-stuffed
  await wait('250');
  s.end('QUIT\r\n');
}

const shop = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const resolver = async (n: string) => (n === 'mail._domainkey.quillmere.example' ? [[`v=DKIM1; k=rsa; p=${shop.publicKey.toString('base64')}`]] : Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })));
async function mail(id: string, o: { sign?: boolean } = {}): Promise<Buffer> {
  const raw = Buffer.from([`From: English Bookshop <english-orders@quillmere.example>`, `To: ${USER}`, 'Subject: Re: Book order', `Message-ID: <${id}@quillmere.example>`, 'Date: Mon, 16 Nov 2026 09:00:00 +0100', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'Title: The Long Tide of Markets / ISBN: 9780000000002 / Price: CHF 19.90', ''].join('\r\n'));
  if (o.sign === false) return raw;
  const r = await dkimSign(raw, { signatureData: [{ signingDomain: 'quillmere.example', selector: 'mail', privateKey: shop.privateKey }] });
  return Buffer.concat([Buffer.from(r.signatures), raw]);
}

describe.skipIf(!IMAPS)('IMAP against a real server (GreenMail)', () => {
  it('TLS is verified: another CA, or another name than the certificate\'s, is refused', async () => {
    await expect(openMailbox(cfg({}, { ca: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n' }))).rejects.toBeInstanceOf(MailboxError);
    await expect(openMailbox(cfg({ host: 'other.example' }))).rejects.toBeInstanceOf(MailboxError);
  });

  it('a wrong password: refused, and the error says nothing of it', async () => {
    const e = await openMailbox(cfg({ password: { value: 'wrong-secret-123' } })).catch((x: unknown) => x as Error);
    expect(e).toBeInstanceOf(MailboxError);
    expect(String((e as Error).message)).not.toContain('wrong-secret-123');
  });

  it('reads new mail by UID, read-only: nothing is flagged as seen, moved or deleted', async () => {
    await deliver(await mail('imap1'));
    await deliver(await mail('imap2', { sign: false }));
    const box = await openMailbox(cfg());
    let list;
    try {
      list = await box.list(0, 50);
      expect(list.length).toBeGreaterThanOrEqual(2);
      const src = await box.source(list.at(-1)!.uid, 1 << 20);
      expect(src?.toString()).toContain('imap2@quillmere.example');
      expect(await box.source(list.at(-1)!.uid, 10)).toBeNull(); // over the limit: not read
      expect(await box.list(list.at(-1)!.uid, 50)).toEqual([]);
    } finally { await box.close(); }
    // A second client (the test's own, read-write) sees the messages still there and still unseen.
    const c = new ImapFlow({ host: '127.0.0.1', port: IMAPS, secure: true, auth: { user: USER, pass: PASS }, tls: { ca: CA, servername: 'imap.test' }, logger: false });
    await c.connect();
    try {
      await c.mailboxOpen('INBOX');
      const flags: string[][] = [];
      for await (const m of c.fetch('1:*', { flags: true })) flags.push([...(m.flags ?? [])]);
      expect(flags.length).toBe(list.length);
      expect(flags.flat()).not.toContain('\\Seen');
    } finally { await c.logout(); }
  });

  it('the mail job end to end: verified and not verified, once each', async () => {
    await deliver(await mail('job1'));
    await deliver(await mail('job2', { sign: false }));
    const db = household();
    const c = { imap: cfg(), arcSealers: ['forwarder.example'], mailRecipients: [], sealingKey: null, connectors: CONNECTORS };
    expect((await refreshMail(db, c, { resolver })).status).toBe('done');
    const rows = db.select().from(t.mailSeen).all();
    expect(rows.find((r) => r.messageId === '<job1@quillmere.example>')).toMatchObject({ accepted: 1 });
    // The unsigned one is not verified: kept under a hash of its bytes, never under its Message-ID, with no content.
    expect(rows.filter((r) => r.accepted === 0 && r.parsedJson === null).length).toBeGreaterThan(0);
    expect(rows.find((r) => r.messageId === '<job2@quillmere.example>')).toBeUndefined();
    const n = rows.length;
    await refreshMail(db, c, { resolver });
    expect(db.select().from(t.mailSeen).all()).toHaveLength(n);
  });
});
