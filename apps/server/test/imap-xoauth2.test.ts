// XOAUTH2 over IMAP (philobiblos#27) against a fake IMAP server made here: TLS from the first byte with the tests' own
// certificate (fixtures/tls, made for imap.test), just enough IMAP for imapflow to sign in and open the folder. It checks
// the SASL payload the way a provider does. Nothing here reaches a real server.
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { MailboxError, openMailbox, type MailboxConfig } from '../src/net/imap';

const fixture = (f: string) => fileURLToPath(new URL(`./fixtures/tls/${f}`, import.meta.url));
const TOKEN = 'ya-test-access-token-0123456789';
const USER = 'shelf@shelf.test';

const imap = { caps: 'IMAP4rev1 SASL-IR AUTH=XOAUTH2', commands: [] as string[], payloads: [] as string[] };
let server: tls.Server, port = 0;
beforeAll(async () => {
  server = tls.createServer({ key: readFileSync(fixture('key.pem')), cert: readFileSync(fixture('cert.pem')) }, (s) => {
    s.write(`* OK [CAPABILITY ${imap.caps}] fake ready\r\n`);
    let buf = '';
    s.on('data', (d: Buffer) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tag, cmd = '', ...args] = line.split(' ');
        imap.commands.push(cmd.toUpperCase());
        switch (cmd.toUpperCase()) {
          case 'CAPABILITY': s.write(`* CAPABILITY ${imap.caps}\r\n${tag} OK done\r\n`); break;
          case 'AUTHENTICATE': {
            const payload = Buffer.from(args[1] ?? '', 'base64').toString('latin1');
            imap.payloads.push(payload);
            if (args[0] === 'XOAUTH2' && payload === `user=${USER}\x01auth=Bearer ${TOKEN}\x01\x01`) s.write(`${tag} OK [CAPABILITY IMAP4rev1] signed in\r\n`);
            else s.write(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials\r\n`);
            break;
          }
          case 'EXAMINE': s.write(`* 0 EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 1] ok\r\n${tag} OK [READ-ONLY] examined\r\n`); break;
          case 'LOGOUT': s.write(`* BYE bye\r\n${tag} OK bye\r\n`); s.end(); break;
          default: s.write(`${tag} OK done\r\n`);
        }
      }
    });
    s.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
});
afterAll(() => { server.close(); });
beforeEach(() => { imap.caps = 'IMAP4rev1 SASL-IR AUTH=XOAUTH2'; imap.commands = []; imap.payloads = []; });

const box = (o: Partial<MailboxConfig> = {}): MailboxConfig => ({ host: 'imap.test', user: USER, folder: 'INBOX', accessToken: TOKEN, port, test: { ca: readFileSync(fixture('cert.pem'), 'utf8'), connectTo: '127.0.0.1' }, ...o } as MailboxConfig);

describe('XOAUTH2', () => {
  it('signs in with the token in the SASL payload, then opens the folder read-only; never LOGIN', async () => {
    const m = await openMailbox(box());
    expect(m.uidValidity).toBe(7);
    await m.close();
    expect(imap.payloads).toEqual([`user=${USER}\x01auth=Bearer ${TOKEN}\x01\x01`]);
    expect(imap.commands).toContain('EXAMINE');
    expect(imap.commands).not.toContain('LOGIN');
    expect(imap.commands).not.toContain('SELECT');
  });

  it('a token the server refuses: MailboxError, and the error holds nothing of the token', async () => {
    const e = (await openMailbox(box({ accessToken: 'another-token-9876543210' })).then(() => null, (x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(MailboxError);
    expect(e.message).not.toContain('another-token');
    expect(e.message).toBe(`cannot sign in to imap.test:${port} over TLS`);
  });

  it('a server that offers no OAuth mechanism: refused, never a password fallback', async () => {
    imap.caps = 'IMAP4rev1 AUTH=PLAIN';
    await expect(openMailbox(box())).rejects.toBeInstanceOf(MailboxError);
    expect(imap.commands).not.toContain('LOGIN');
    expect(imap.payloads).toEqual([]);
  });

  it('a token with a control character is never framed into the payload', async () => {
    await expect(openMailbox(box({ accessToken: `${TOKEN}\x01auth=Bearer x` }))).rejects.toBeInstanceOf(MailboxError);
    expect(imap.payloads).toEqual([]);
  });
});

describe('a self-hosted server\'s or a bridge\'s own certificate (PHILOBIBLOS_IMAP_CA_FILE)', () => {
  it('trusted only when named; the host name is still checked', async () => {
    const place = { test: { connectTo: '127.0.0.1' } };
    // Without it the system's CAs do not know the certificate.
    await expect(openMailbox(box(place))).rejects.toBeInstanceOf(MailboxError);
    const m = await openMailbox(box({ ...place, caFile: fixture('cert.pem') }));
    await m.close();
    await expect(openMailbox(box({ ...place, caFile: fixture('cert.pem'), host: 'not-in-the-certificate.test' }))).rejects.toBeInstanceOf(MailboxError);
    await expect(openMailbox(box({ ...place, caFile: '/nonexistent/ca.pem' }))).rejects.toThrow('cannot read PHILOBIBLOS_IMAP_CA_FILE');
  });

  it('PHILOBIBLOS_IMAP_PORT is the port connected to (philobiblos#49): loadConfig to openMailbox, no test port override', async () => {
    const c = loadConfig({ PHILOBIBLOS_IMAP_HOST: 'imap.test', PHILOBIBLOS_IMAP_USER: USER, PHILOBIBLOS_IMAP_PASSWORD: 'unused', PHILOBIBLOS_IMAP_PORT: String(port), PHILOBIBLOS_IMAP_CA_FILE: fixture('cert.pem') });
    const { password: _unused, ...place } = c.imap!;
    // Only where the name resolves is the test's: the port, the CA and the host name checked are the configuration's.
    const m = await openMailbox({ ...place, accessToken: TOKEN, test: { connectTo: '127.0.0.1' } });
    await m.close();
    expect(imap.payloads).toEqual([`user=${USER}\x01auth=Bearer ${TOKEN}\x01\x01`]);
  });

  it('no port named: 993, with TLS from the first byte', async () => {
    const c = loadConfig({ PHILOBIBLOS_IMAP_HOST: 'imap.test', PHILOBIBLOS_IMAP_USER: USER, PHILOBIBLOS_IMAP_PASSWORD: 'unused' });
    expect(c.imap!.port).toBe(993);
    const { password: _unused, port: _993, ...place } = c.imap!;
    const e = (await openMailbox({ ...place, accessToken: TOKEN, test: { ca: readFileSync(fixture('cert.pem'), 'utf8'), connectTo: '127.0.0.1' } }).then(() => null, (x: unknown) => x)) as Error;
    expect(e.message).toBe('cannot sign in to imap.test:993 over TLS');
  });
});
