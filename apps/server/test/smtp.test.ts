// The one outgoing mail connection (net/smtp.ts; philobiblos#34 slice 4a) against a local SMTP server (smtpd.ts): TLS
// with the certificate verified, one plain recipient, the fixed text holding the code alone, and nothing of the server's
// words or the password in an error. No mail leaves this machine. Every address is invented (example.org).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SmtpError, codeMessage, plainAddress, sendCode, type SmtpSettings } from '../src/net/smtp';
import { SMTPD_CA, SMTPD_HOST, SMTPD_PASS, SMTPD_USER, smtpd, type Smtpd } from './smtpd';

let servers: Smtpd[] = [];
afterEach(async () => { for (const s of servers) await s.close(); servers = []; });
async function server(o: Parameters<typeof smtpd>[0] = {}) { const s = await smtpd(o); servers.push(s); return s; }
const settings = (s: Smtpd, more: Partial<SmtpSettings> = {}): SmtpSettings => ({
  host: SMTPD_HOST, port: s.port, user: SMTPD_USER, password: { value: SMTPD_PASS }, from: 'codes@example.org', caFile: null,
  test: { ca: SMTPD_CA, connectTo: '127.0.0.1' }, ...more,
});
const fails = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(SmtpError);
  expect(String((e as Error).message)).not.toContain(SMTPD_PASS);
  return e as SmtpError;
};

describe('one plain address', () => {
  it('takes a plain address, its domain lowercased', () => {
    expect(plainAddress('jordan@example.org')).toBe('jordan@example.org');
    expect(plainAddress('Jordan.Lee+books@Mail.Example.ORG')).toBe('Jordan.Lee+books@mail.example.org');
  });

  it('refuses display names, line breaks, commas, a second recipient, quotes, comments and anything not ASCII', () => {
    for (const v of ['Jordan <jordan@example.org>', 'jordan@example.org\r\nBcc: x@example.org', 'jordan@example.org\n', 'a@example.org,b@example.org',
      'a@example.org;b@example.org', 'a@example.org b@example.org', '"jordan"@example.org', 'jordan(x)@example.org', 'jordan@[192.0.2.1]', 'jordan@localhost',
      'jordän@example.org', 'jordan@exämple.org', '.jordan@example.org', 'jor..dan@example.org', 'jordan@-example.org', '@example.org', 'jordan@', 'jordan',
      `${'a'.repeat(65)}@example.org`, `a@${'b'.repeat(250)}.org`, 'jordan@example.org>', '<jordan@example.org>', '', 42, null]) {
      expect(plainAddress(v), String(v)).toBeNull();
    }
  });
});

describe('the message', () => {
  it('is fixed text: the code is its only variable part, and it holds no link', () => {
    const a = codeMessage('codes@example.org', 'jordan@example.org', '123456', new Date('2026-11-24T10:00:00Z'));
    const b = codeMessage('codes@example.org', 'jordan@example.org', '654321', new Date('2026-11-24T10:00:00Z'));
    const body = (m: string) => m.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    expect(body(a).replace('123456', 'CODE')).toBe(body(b).replace('654321', 'CODE'));
    expect(body(a)).toContain('123456');
    expect(a).not.toMatch(/https?:|www\.|href/i);
    expect(a.match(/^To: .*$/m)![0]).toBe('To: jordan@example.org');
    expect(a).not.toMatch(/^(Cc|Bcc|Reply-To):/im);
  });

  it('only a six-digit code', () => {
    for (const c of ['12345', '1234567', 'abcdef', '12345\n', '']) expect(() => codeMessage('codes@example.org', 'jordan@example.org', c)).toThrow(SmtpError);
  });
});

describe('sending a code', () => {
  it('over TLS, signed in with AUTH PLAIN, to the one recipient, with the fixed text', async () => {
    const s = await server();
    await sendCode(settings(s), 'jordan@example.org', '042917');
    expect(s.received).toHaveLength(1);
    const r = s.received[0]!;
    expect(r.auth).toBe(`\0${SMTPD_USER}\0${SMTPD_PASS}`);
    expect(r.commands[0]).toBe('EHLO [127.0.0.1]');
    expect(r.from).toBe('MAIL FROM:<codes@example.org>');
    expect(r.to).toEqual(['RCPT TO:<jordan@example.org>']);
    expect(r.data).toContain('Your code to join: 042917');
    expect(r.commands.at(-1)).toBe('QUIT');
  });

  it('a recipient that is not one plain address is never sent to: nothing connects', async () => {
    const s = await server();
    for (const to of ['jordan@example.org\r\nRCPT TO:<x@example.org>', 'a@example.org,b@example.org', 'Jordan <jordan@example.org>', 'Jordan@Example.org']) {
      await fails(sendCode(settings(s), to, '123456'));
    }
    expect(s.received).toHaveLength(0);
  });

  it('a certificate that is not trusted is refused: nothing is said, the password never sent', async () => {
    const s = await server();
    // The system's CAs: the fixture certificate is its own issuer, so it is not trusted.
    const e = await fails(sendCode(settings(s, { test: { connectTo: '127.0.0.1' } }), 'jordan@example.org', '123456'));
    expect(e.message).toMatch(/over TLS/);
    expect(s.received.every((r) => r.auth === null && r.commands.length === 0)).toBe(true);
  });

  it('a certificate for another name is refused', async () => {
    const s = await server();
    await fails(sendCode(settings(s, { host: 'smtp.example.org' }), 'jordan@example.org', '123456'));
    expect(s.received.every((r) => r.auth === null && r.commands.length === 0)).toBe(true);
  });

  it('TLS older than 1.2 is refused', async () => {
    const s = await server({ maxVersion: 'TLSv1.1', minVersion: 'TLSv1' });
    await fails(sendCode(settings(s), 'jordan@example.org', '123456'));
    expect(s.received.every((r) => r.auth === null)).toBe(true);
  });

  it('a server without AUTH PLAIN is not signed in to, and nothing is sent', async () => {
    const s = await server({ ehlo: ['AUTH LOGIN CRAM-MD5'] });
    const e = await fails(sendCode(settings(s), 'jordan@example.org', '123456'));
    expect(e.message).toMatch(/no AUTH PLAIN/);
    expect(s.received[0]!.auth).toBeNull();
    expect(s.received[0]!.data).toBeNull();
  });

  it('a refused sign-in or recipient stops it; the error carries no word of the server\'s', async () => {
    for (const refuse of ['AUTH', 'RCPT'] as const) {
      const s = await server({ refuse });
      const e = await fails(sendCode(settings(s), 'jordan@example.org', '123456'));
      expect(e.message).not.toMatch(/no$|bad credentials/);
      expect(s.received[0]!.data).toBeNull();
    }
    const wrong = await server();
    await fails(sendCode(settings(wrong, { password: { value: 'another-password' } }), 'jordan@example.org', '123456'));
    expect(wrong.received[0]!.data).toBeNull();
  });

  it('a server that never answers is cut off by the deadline', async () => {
    const s = await server({ silent: true });
    const t0 = Date.now();
    await fails(sendCode(settings(s), 'jordan@example.org', '123456', 300));
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('the mail boundary (architecture)', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'node_modules' || f === 'dist' ? [] : files(p);
    return /\.(ts|mjs|js)$/.test(f) ? [p] : [];
  });
  const src = [join(root, 'apps/server/src'), join(root, 'apps/worker/src'), ...readdirSync(join(root, 'packages')).map((d) => join(root, 'packages', d, 'src'))]
    .flatMap((d) => { try { return files(d); } catch { return []; } })
    .map((f) => ({ f: relative(root, f), s: readFileSync(f, 'utf8') }));

  it('net/smtp.ts is the one TLS socket of Philobiblos\'s own, and the one place that speaks SMTP', () => {
    expect(src.length).toBeGreaterThan(30);
    expect(src.filter((x) => /from\s+['"](?:node:)?tls['"]|require\(\s*['"](?:node:)?tls['"]/.test(x.s)).map((x) => x.f)).toEqual(['apps/server/src/net/smtp.ts']);
    expect(src.filter((x) => /RCPT TO|MAIL FROM:/.test(x.s)).map((x) => x.f)).toEqual(['apps/server/src/net/smtp.ts']);
  });

  it('no mail library anywhere; only the join code sends through it', () => {
    const lib = /from\s+['"](?:nodemailer|emailjs|smtp-client|smtp-connection|@sendgrid\/[^'"]+|mailgun[^'"]*|sendmail)['"]/;
    expect(src.filter((x) => lib.test(x.s)).map((x) => x.f)).toEqual([]);
    // Others may read its address helpers; only the join code's module sends (and nothing else imports it whole).
    expect(src.filter((x) => /import\s*\{[^}]*\bsendCode\b[^}]*\}\s*from\s+['"][./]+(?:net\/)?smtp['"]/.test(x.s)).map((x) => x.f)).toEqual(['apps/server/src/household/join-code.ts']);
    expect(src.filter((x) => /import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s+['"][./]+(?:net\/)?smtp['"]|import\(\s*['"][./]+(?:net\/)?smtp['"]/.test(x.s)).map((x) => x.f)).toEqual([]);
    for (const pkg of ['apps/server/package.json', 'apps/worker/package.json', 'package.json']) {
      const deps = Object.keys({ ...JSON.parse(readFileSync(join(root, pkg), 'utf8')).dependencies });
      expect(deps.filter((d) => /smtp|nodemailer|sendmail|emailjs/i.test(d)), pkg).toEqual([]);
    }
  });

  it('the connection verifies the certificate, TLS 1.2 or newer, and never STARTTLS', () => {
    const s = src.find((x) => x.f === 'apps/server/src/net/smtp.ts')!.s.replace(/^\s*\/\/.*$/gm, '');
    expect(s).toMatch(/rejectUnauthorized: true/);
    expect(s).toMatch(/minVersion: 'TLSv1\.2'/);
    expect(s).not.toMatch(/STARTTLS|rejectUnauthorized: false|net\.connect|createConnection/i);
  });
});
