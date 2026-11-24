// A local SMTP server for the tests (philobiblos#34 slice 4a): TLS from the first byte with the fixture certificate
// (fixtures/tls, made for *.test names), just enough SMTP to take one mail. It keeps what it was told; no mail goes
// anywhere. Listens on 127.0.0.1 only, on a port of its own.
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';

const pem = (f: string) => readFileSync(new URL(`./fixtures/tls/${f}`, import.meta.url), 'utf8');
export const SMTPD_CA = pem('cert.pem');
/** A name the fixture certificate carries. */
export const SMTPD_HOST = 'other.test';
export const SMTPD_USER = 'codes@example.org';
export const SMTPD_PASS = 'not-a-real-password';

export interface Received { commands: string[]; auth: string | null; from: string | null; to: string[]; data: string | null }

export interface Smtpd {
  port: number;
  received: Received[];
  close(): Promise<void>;
}

/** `ehlo`: the extension lines after the greeting line (default AUTH PLAIN LOGIN). `refuse`: a command answered 5xx. */
export async function smtpd(o: { ehlo?: string[]; refuse?: 'AUTH' | 'RCPT' | 'MAIL'; silent?: boolean; minVersion?: tls.SecureVersion; maxVersion?: tls.SecureVersion } = {}): Promise<Smtpd> {
  const received: Received[] = [];
  const server = tls.createServer({ key: pem('key.pem'), cert: SMTPD_CA, ...(o.minVersion ? { minVersion: o.minVersion } : {}), ...(o.maxVersion ? { maxVersion: o.maxVersion } : {}) }, (sock) => {
    const r: Received = { commands: [], auth: null, from: null, to: [], data: null };
    received.push(r);
    sock.on('error', () => {});
    if (o.silent) return;
    sock.write('220 other.test ESMTP test\r\n');
    let buf = '';
    let inData = false;
    sock.setEncoding('latin1');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          r.data = buf.slice(0, end).replace(/\r\n\.\./g, '\r\n.');
          buf = buf.slice(end + 5);
          inData = false;
          sock.write('250 queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        r.commands.push(line.startsWith('AUTH ') ? 'AUTH …' : line);
        const verb = line.split(' ')[0]!.toUpperCase();
        if (o.refuse && verb.startsWith(o.refuse)) { sock.write('535 no\r\n'); continue; }
        if (verb === 'EHLO') sock.write(['250-other.test', ...(o.ehlo ?? ['AUTH PLAIN LOGIN']).map((l) => `250-${l}`), '250 8BITMIME'].join('\r\n') + '\r\n');
        else if (verb === 'AUTH') {
          r.auth = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8');
          sock.write(r.auth === `\0${SMTPD_USER}\0${SMTPD_PASS}` ? '235 ok\r\n' : '535 bad credentials\r\n');
        } else if (verb === 'MAIL') { r.from = line; sock.write('250 ok\r\n'); }
        else if (verb === 'RCPT') { r.to.push(line); sock.write('250 ok\r\n'); }
        else if (verb === 'DATA') { inData = true; sock.write('354 go on\r\n'); }
        else if (verb === 'QUIT') { sock.end('221 bye\r\n'); return; }
        else sock.write('502 not here\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as AddressInfo).port,
    received,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}
