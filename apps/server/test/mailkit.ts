// Invented bookshop mail for the tests: keys made here, a fake DNS that holds only them, signing and ARC sealing as
// the bookshop and a forwarder would, and a stand-in mailbox. Nothing is looked up for real, and no real mail is used.
// The bookshop is Quillmere Books, the invented example connector (connectors/quillmere/connector.yaml); the forwarder
// is invented too (forwarder.example).
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Connector } from '@philobiblos/contracts/connector';
import { loadConnectors } from '../src/connectors/load';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { mailRules } from '../src/mail/parse';
import { sealMessage } from 'mailauth';
import { dkimSign } from 'mailauth/lib/dkim/sign';
import type { MailJobConfig } from '../src/mail/job';
import type { Mailbox } from '../src/net/imap';

const key = () => generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
export const shop = key(), forwarder = key(), evil = key();
const record = (k: ReturnType<typeof key>) => [[`v=DKIM1; k=rsa; p=${k.publicKey.toString('base64')}`]];
const DNS: Record<string, string[][]> = {
  'mail._domainkey.quillmere.example': record(shop),
  'arc._domainkey.forwarder.example': record(forwarder),
  'arc._domainkey.evil.example': record(evil),
  'mail._domainkey.evil.example': record(evil),
};
/** The fake DNS: the records above, and the shop's key for every signing domain of a connector that ships (selector `mail`). */
export const resolver = async (name: string) => {
  const n = name.toLowerCase();
  const signer = n.startsWith('mail._domainkey.') && CONNECTORS.all.some((c) => (c.connector?.mail?.dkim_domains ?? c.connector?.mail?.domains ?? []).includes(n.slice(16)));
  const r = DNS[n] ?? (signer ? record(shop) : undefined);
  if (!r) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
  return r;
};
export const SEALERS = ['forwarder.example'];

/** The connectors that ship (the invented example among them), read as the server reads them. */
export const CONNECTORS = loadConnectors({ builtin: fileURLToPath(new URL('../../../connectors', import.meta.url)), local: null });
export const QUILLMERE = CONNECTORS.get('quillmere')!.connector as Connector;
export const RULES = mailRules(QUILLMERE);
export const SHOPS = [{ id: 'quillmere', domains: QUILLMERE.mail!.domains, dkimDomains: QUILLMERE.mail!.domains }];
/** The example bookshop enabled, as an admin enables it in Settings (the household's currency is the shop's). */
export function enableShop(db: Db, id = 'quillmere'): Db {
  const currency = CONNECTORS.get(id)!.connector!.locale.currency;
  db.insert(t.householdSettings).values({ id: 1, currency }).onConflictDoUpdate({ target: t.householdSettings.id, set: { currency } }).run();
  db.insert(t.connectorEnabled).values({ id, version: CONNECTORS.get(id)!.version, enabledAt: new Date().toISOString() }).onConflictDoNothing().run();
  return db;
}
export const HOUSEHOLD = ['shelf.household@example.org'];

/** A header value as a mail carries it: non-ASCII as an RFC 2047 encoded word. */
const word = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?utf-8?B?${Buffer.from(v).toString('base64')}?=`);

/** An invented bookshop mail; with `pdf`, a multipart one with that PDF attached. */
export function message(o: { from?: string; extra?: string; body?: string; id?: string; subject?: string; html?: boolean; pdf?: Buffer; date?: string } = {}): Buffer {
  const body = o.body ?? 'Dear customer,\r\nAuthor: Mira Okafor / Title: The Long Tide of Markets / ISBN: 9780000000002 / Price: CHF 19.90\r\nKind regards';
  const b = 'shelf-test-boundary';
  return Buffer.from([
    `From: ${o.from ?? 'English Bookshop <english-orders@quillmere.example>'}`,
    'To: shelf.household@example.org',
    `Subject: ${word(o.subject ?? 'Re: Book order')}`,
    `Message-ID: <${o.id ?? `m${Math.random().toString(36).slice(2)}`}@quillmere.example>`,
    `Date: ${o.date ?? 'Mon, 16 Nov 2026 09:00:00 +0100'}`,
    ...(o.extra ? [o.extra] : []),
    'MIME-Version: 1.0',
    ...(o.pdf
      ? [`Content-Type: multipart/mixed; boundary="${b}"`, '', `--${b}`, 'Content-Type: text/plain; charset=utf-8', '', body, `--${b}`,
        'Content-Type: application/pdf; name="invoice.pdf"', 'Content-Transfer-Encoding: base64', '', o.pdf.toString('base64'), `--${b}--`]
      : [`Content-Type: ${o.html ? 'text/html' : 'text/plain'}; charset=utf-8`, '', body]),
    '',
  ].join('\r\n'));
}
export async function signed(raw: Buffer, domain = 'quillmere.example', k = shop, extra: { headerList?: string; maxBodyLength?: number } = {}): Promise<Buffer> {
  const r = await dkimSign(raw, { signatureData: [{ signingDomain: domain, selector: 'mail', privateKey: k.privateKey, ...extra }] });
  return Buffer.concat([Buffer.from(r.signatures), raw]);
}
export async function sealed(raw: Buffer, by: 'forwarder.example' | 'evil.example', authResults: string): Promise<Buffer> {
  const h = await sealMessage(raw, { signingDomain: by, selector: 'arc', privateKey: (by === 'forwarder.example' ? forwarder : evil).privateKey, authResults, cv: 'none' });
  return Buffer.concat([h, raw]);
}

/** A stand-in mailbox: these messages, these UIDs. */
export function fakeBox(msgs: { uid: number; raw: Buffer }[], uidValidity = 7): Mailbox & { closed: number; read: number[] } {
  const box = {
    uidValidity, closed: 0, read: [] as number[],
    async list(after: number, max: number) {
      return msgs.filter((m) => m.uid > after).slice(0, max).map((m) => ({ uid: m.uid, size: m.raw.length, messageId: /Message-ID: (<[^>]+>)/i.exec(m.raw.toString())?.[1] ?? null }));
    },
    async source(uid: number) { box.read.push(uid); return msgs.find((m) => m.uid === uid)?.raw ?? null; },
    async close() { box.closed++; },
  };
  return box;
}
export const IMAP = { host: 'imap.example.org', user: 'shelf', password: { value: 'not-a-real-password' }, folder: 'INBOX' };
export const CFG: MailJobConfig = { imap: IMAP, arcSealers: SEALERS, mailRecipients: HOUSEHOLD, sealingKey: null, locale: null, connectors: CONNECTORS };
