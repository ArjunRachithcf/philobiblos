// The one outgoing mail connection (ADR 0011, philobiblos#34 slice 4a; ADR 0009's note): a small SMTP client of
// Philobiblos's own on Node's TLS, which sends one mail only, a join code. No mail library: it speaks the few commands
// that mail needs (EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA, QUIT) and nothing else.
//
// - TLS from the first byte (port 465 unless the household names another; never STARTTLS, so nothing to downgrade),
//   the certificate and the host name verified (against the system's CAs, or only the one PHILOBIBLOS_SMTP_CA_FILE
//   names), TLS 1.2 or newer. A server that does not offer AUTH PLAIN is not signed in to, and nothing is sent.
// - One recipient, one plain address (plainAddress: no display name, no line break, comma or space), in RCPT TO and the
//   To header alike, and the message is fixed text holding the code alone (codeMessage): no name, no link, nothing of the
//   household. The code is six digits or nothing is sent.
// - Every reply is held to a line length, a size and one deadline for the whole exchange; the server's words never reach
//   an error, a log or an answer (the password neither).
// The architecture tests keep every other connection out (test/egress.test.ts) and this file the only one that opens
// a TLS socket or sends mail (test/smtp.test.ts).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { readSecret, type Secret } from './imap';

export interface SmtpSettings {
  host: string;
  /** Default 465; TLS from the first byte whatever it is. */
  port: number;
  user: string;
  password: Secret;
  /** The sender, one plain address (the account's own, usually). */
  from: string;
  /** A PEM file: the server's certificate must chain to it, and to nothing else (null: the system's CAs). */
  caFile: string | null;
  /** Tests only: the CA of their own server and the address it listens on (the port is always `port`'s). */
  test?: { ca?: string; connectTo: string };
}

export class SmtpError extends Error {
  constructor(message: string) { super(message); this.name = 'SmtpError'; }
}

/** The whole exchange, from the connection to QUIT. */
export const SMTP_TIMEOUT_MS = 20_000;
/** A reply line (RFC 5321 4.5.3.1.5: 512), with room; a whole reply. */
const LINE_MAX = 1000;
const REPLY_MAX = 16 << 10;

/**
 * One plain address, lowercased in its domain, or null: an ASCII local part of the dot-atom kind (no quotes, no
 * comments, no display name), an @, and a host name of at least two labels. Nothing that could end a header or a
 * command, or name a second recipient: no CR, LF, comma, semicolon, space, angle bracket or quote.
 */
export function plainAddress(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 254) return null;
  const m = /^([A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)$/.exec(v);
  if (!m || m[1]!.length > 64) return null;
  return `${m[1]}@${m[2]!.toLowerCase()}`;
}

/** The domain of a plain address. */
export const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);

/** The message: fixed text, the code its one variable part. Nothing of the household, no link. */
export function codeMessage(from: string, to: string, code: string, now = new Date()): string {
  if (!/^\d{6}$/.test(code)) throw new SmtpError('not a code');
  const id = `${randomBytes(12).toString('hex')}@${domainOf(from)}`;
  return [
    `From: ${from}`,
    `To: ${to}`,
    'Subject: Your code to join',
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=us-ascii',
    'Content-Transfer-Encoding: 7bit',
    'Auto-Submitted: auto-generated',
    '',
    `Your code to join: ${code}`,
    '',
    'It works for 10 minutes, on the page that asked for it. If you did not ask for it, ignore this mail.',
    '',
  ].join('\r\n');
}

/** Sends the code to `to`, the only recipient. Throws SmtpError (never with the server's words) when it was not sent. */
export async function sendCode(s: SmtpSettings, to: string, code: string, timeoutMs = SMTP_TIMEOUT_MS): Promise<void> {
  const rcpt = plainAddress(to);
  const from = plainAddress(s.from);
  if (!rcpt || rcpt !== to) throw new SmtpError('not one plain address');
  if (!from) throw new SmtpError('PHILOBIBLOS_SMTP_FROM is not one plain address');
  const message = codeMessage(from, rcpt, code);
  const user = s.user;
  let password: string;
  try { password = readSecret(s.password); } catch { throw new SmtpError('cannot read PHILOBIBLOS_SMTP_PASSWORD_FILE'); }
  if (/[\0\r\n]/.test(user) || /[\0\r\n]/.test(password)) throw new SmtpError('the SMTP user or password holds a control character');
  let ca: string | undefined = s.test?.ca;
  if (!ca && s.caFile) {
    try { ca = readFileSync(s.caFile, 'utf8'); } catch { throw new SmtpError('cannot read PHILOBIBLOS_SMTP_CA_FILE'); }
  }
  const where = `${s.host}:${s.port}`;
  const socket = tls.connect({
    host: s.test?.connectTo ?? s.host,
    port: s.port,
    // An IP address is checked against the certificate's IP names (SNI carries host names only).
    ...(isIP(s.host) ? {} : { servername: s.host }),
    // The name the certificate must carry is the configured host's, wherever the test points the socket.
    checkServerIdentity: (_h, cert) => tls.checkServerIdentity(s.host, cert),
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    ...(ca ? { ca } : {}),
  });
  const replies = replyReader(socket);
  const timer = setTimeout(() => socket.destroy(new SmtpError('timeout')), timeoutMs);
  const write = (line: string) => new Promise<void>((res, rej) => socket.write(line, (e) => (e ? rej(e) : res())));
  /** The next reply; its code must be one of `ok`. */
  const expect = async (ok: number[], step: string) => {
    const r = await replies.next();
    if (!ok.includes(r.code)) throw new SmtpError(`the server refused ${step} (${r.code})`);
    return r;
  };
  try {
    await new Promise<void>((res, rej) => {
      socket.once('secureConnect', () => res());
      socket.once('error', rej);
    });
    await expect([220], 'the connection');
    // An address literal: Philobiblos does not name the household's host to the server.
    await write('EHLO [127.0.0.1]\r\n');
    const ehlo = await expect([250], 'EHLO');
    const auth = ehlo.lines.find((l) => /^AUTH[ =]/i.test(l));
    if (!auth || !auth.slice(5).toUpperCase().split(/\s+/).includes('PLAIN')) throw new SmtpError('the server offers no AUTH PLAIN');
    await write(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64')}\r\n`);
    await expect([235], 'the sign-in');
    await write(`MAIL FROM:<${from}>\r\n`);
    await expect([250], 'the sender');
    await write(`RCPT TO:<${rcpt}>\r\n`);
    await expect([250, 251], 'the recipient');
    await write('DATA\r\n');
    await expect([354], 'DATA');
    // Dot-stuffing (RFC 5321 4.5.2), though the fixed text has no line that starts with a dot.
    await write(`${message.replace(/\r\n\./g, '\r\n..')}\r\n.\r\n`);
    await expect([250], 'the message');
    await write('QUIT\r\n');
    await replies.next().catch(() => null);
  } catch (e) {
    if (e instanceof SmtpError) throw new SmtpError(`cannot send through ${where}: ${e.message}`);
    // A TLS failure (an unknown issuer, another name, an old version) or a dropped connection: said as that alone.
    throw new SmtpError(`cannot send through ${where} over TLS`);
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

interface Reply { code: number; lines: string[] }

/** Reads SMTP replies (multi-line ones joined), held to LINE_MAX a line and REPLY_MAX a reply. */
function replyReader(socket: tls.TLSSocket) {
  let buf = '';
  let lines: string[] = [];
  let size = 0;
  const ready: Reply[] = [];
  let waiter: { res: (r: Reply) => void; rej: (e: Error) => void } | null = null;
  let failed: Error | null = null;
  const fail = (e: Error) => {
    failed ??= e;
    if (waiter) { waiter.rej(failed); waiter = null; }
  };
  socket.setEncoding('latin1');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    size += chunk.length;
    if (size > REPLY_MAX) { fail(new SmtpError('the reply is too long')); socket.destroy(); return; }
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      const m = /^(\d{3})([ -])(.*)$/.exec(line) ?? /^(\d{3})()()$/.exec(line);
      if (!m || line.length > LINE_MAX) { fail(new SmtpError('not an SMTP reply')); socket.destroy(); return; }
      lines.push(m[3]!);
      if (m[2] !== '-') {
        const r = { code: Number(m[1]), lines };
        lines = [];
        size = buf.length;
        if (waiter) { waiter.res(r); waiter = null; } else ready.push(r);
      }
    }
    if (buf.length > LINE_MAX) { fail(new SmtpError('the reply is too long')); socket.destroy(); }
  });
  socket.on('error', (e) => fail(e));
  socket.on('close', () => fail(new SmtpError('the connection closed')));
  return {
    next(): Promise<Reply> {
      const r = ready.shift();
      if (r) return Promise.resolve(r);
      if (failed) return Promise.reject(failed);
      return new Promise((res, rej) => { waiter = { res, rej }; });
    },
  };
}
