// The Philobiblos-only mailbox over IMAP (ADR 0007, contracts/connectors.md): the only IMAP connection in Philobiblos, and only
// these operations. TLS from the first byte (port 993 unless the household names another; never STARTTLS, so nothing to
// downgrade), the certificate and the host name verified (against the system's CAs, or only the one certificate
// PHILOBIBLOS_IMAP_CA_FILE names: a self-hosted server's, a local bridge's), TLS 1.2 or newer. It signs in with the app
// password, or with XOAUTH2 (or OAUTHBEARER, when the server offers it) and the access token mail/oauth.ts gives. The folder is opened with EXAMINE (read-only), and the reader only lists
// UIDs (UID SEARCH) and sizes and reads a message's bytes with BODY.PEEK: it never stores a flag, moves, copies, deletes, expunges
// or appends (an architecture test, test/mail.test.ts, keeps every other call out of this file).
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { ImapFlow } from 'imapflow';

export type Secret = { value: string } | { file: string };

/** Where the mailbox is. */
export interface MailboxPlace {
  host: string;
  /** Default 993; TLS from the first byte whatever it is. */
  port?: number;
  user: string;
  folder: string;
  /** A PEM file: the server's certificate must chain to it, and to nothing else (null: the system's CAs). */
  caFile?: string | null;
  /** Tests only: the CA of their own server and the address it listens on (the port is always `port`'s). */
  test?: { ca?: string; connectTo: string };
}
/** How it signs in: the app password, or an OAuth access token (never both). */
export type MailboxConfig = MailboxPlace & ({ password: Secret; accessToken?: undefined } | { accessToken: string; password?: undefined });

export interface MessageInfo { uid: number; size: number; messageId: string | null }
export interface Mailbox {
  uidValidity: number;
  /** Messages with a UID above `afterUid` (and, if given, received since `since`), oldest first, at most `max`. */
  list(afterUid: number, max: number, since?: Date): Promise<MessageInfo[]>;
  /** The message's bytes, or null if it is gone or larger than `maxBytes`. */
  source(uid: number, maxBytes: number): Promise<Buffer | null>;
  close(): Promise<void>;
}

export class MailboxError extends Error {
  constructor(message: string) { super(message); this.name = 'MailboxError'; }
}

const secret = (p: Secret) => ('value' in p ? p.value : readFileSync(p.file, 'utf8').trim());

export async function openMailbox(c: MailboxConfig): Promise<Mailbox> {
  const port = c.port ?? 993;
  let ca: string | undefined = c.test?.ca;
  if (!ca && c.caFile) {
    try { ca = readFileSync(c.caFile, 'utf8'); } catch { throw new MailboxError('cannot read PHILOBIBLOS_IMAP_CA_FILE'); }
  }
  const client = new ImapFlow({
    host: c.test?.connectTo ?? c.host,
    port,
    secure: true,
    doSTARTTLS: false,
    // XOAUTH2 (or OAUTHBEARER) with the token, never a password beside it; imapflow refuses a token with control characters.
    auth: c.accessToken !== undefined ? { user: c.user, accessToken: c.accessToken } : { user: c.user, pass: secret(c.password) },
    // An IP address is checked against the certificate's IP names (SNI carries host names only).
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(isIP(c.host) ? {} : { servername: c.host }), ...(ca ? { ca } : {}) },
    logger: false,
    disableAutoIdle: true,
    disableCompression: true,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
  });
  // A failed sign-in says only that; the server's words (and the password) never reach a log or job_run.
  client.on('error', () => { /* reported through the calls below */ });
  try { await client.connect(); } catch { throw new MailboxError(`cannot sign in to ${c.host}:${port} over TLS`); }
  let box;
  try { box = await client.mailboxOpen(c.folder, { readOnly: true }); } catch { await client.logout().catch(() => {}); throw new MailboxError(`cannot open the folder ${c.folder}`); }
  if (!box.readOnly) { await client.logout().catch(() => {}); throw new MailboxError('the server did not open the folder read-only'); }
  return {
    uidValidity: Number(box.uidValidity),
    async list(afterUid, max, since) {
      if (!box.exists) return [];
      // UID SEARCH first (numbers only), then envelopes for at most `max` of them: a large mailbox costs one search.
      const uids = await client.search({ uid: `${afterUid + 1}:*`, ...(since ? { since } : {}) }, { uid: true });
      const pick = (uids || []).filter((u) => u > afterUid).sort((a, b) => a - b).slice(0, max);
      if (!pick.length) return [];
      const out: MessageInfo[] = [];
      for await (const m of client.fetch(pick.join(','), { uid: true, size: true, envelope: true }, { uid: true })) {
        out.push({ uid: m.uid, size: m.size ?? 0, messageId: m.envelope?.messageId ?? null });
      }
      return out.sort((a, b) => a.uid - b.uid);
    },
    async source(uid, maxBytes) {
      const m = await client.fetchOne(String(uid), { uid: true, size: true }, { uid: true });
      if (!m || (m.size ?? 0) > maxBytes) return null;
      const full = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!full || !full.source || full.source.length > maxBytes) return null;
      return full.source;
    },
    async close() { await client.logout().catch(() => client.close()); },
  };
}
