// The mail job (ADR 0007): reads what is new in the Shelf-only mailbox, checks who sent it, and records each mail once
// in mail_seen (keyed by its Message-ID, so a mail seen again, after a UIDVALIDITY change say, is not recorded twice).
// It changes nothing else: the parsers that turn a verified mail into quotes, orders and copies come later (M3 d) and
// read what is kept here. A mail that fails the checks is kept as "not verified" with Shelf's reason, and its content
// is not kept at all.
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { MediaUnavailable, runMediaJob } from '../media/client';
import { MailboxError, openMailbox, type Mailbox, type MailboxConfig } from '../net/imap';
import type { TxtResolver } from '../net/dns';
import type { Outcome } from '../jobs/books';
import { MAIL_LIMITS, MailUnreadable, readMail } from './read';
import { verifyBookshopMail } from './verify';

export const PARSER_VERSION = 'm3c-1';
export const PER_RUN = 200;

export interface MailDeps {
  open?: (c: MailboxConfig) => Promise<Mailbox>;
  resolver?: TxtResolver;
  media?: (kind: 'pdf.text', input: Uint8Array) => ReturnType<typeof runMediaJob>;
  now?: () => Date;
}

/** A Message-ID as a key: the header's value, or, for a mail without one, a hash of its bytes. */
const keyOf = (messageId: string | null, raw: Buffer | null, uid: number, uidValidity: number) =>
  messageId?.trim().slice(0, 300) || (raw ? `sha256:${createHash('sha256').update(raw).digest('hex')}` : `uid:${uidValidity}:${uid}`);

export async function refreshMail(db: Db, cfg: { imap: MailboxConfig | null; workDir: string | null; arcSealers: string[] }, deps: MailDeps = {}): Promise<Outcome> {
  if (!cfg.imap) return { status: 'blocked', detail: 'no mailbox is set up (SHELF_IMAP_HOST, SHELF_IMAP_USER, SHELF_IMAP_PASSWORD)' };
  const now = deps.now ?? (() => new Date());
  const media = deps.media ?? ((kind, input) => runMediaJob(cfg.workDir, kind, input));
  let box: Mailbox;
  try { box = await (deps.open ?? openMailbox)(cfg.imap); } catch (e) {
    return { status: 'failed', detail: e instanceof MailboxError ? e.message : 'cannot reach the mailbox' };
  }
  const folder = cfg.imap.folder;
  let verified = 0, notVerified = 0, already = 0;
  try {
    const cur = db.select().from(t.mailCursor).where(eq(t.mailCursor.folder, folder)).get();
    let last = cur && cur.uidValidity === box.uidValidity ? cur.lastUid : 0;
    const advance = (uid: number) => {
      last = uid;
      const v = { uidValidity: box.uidValidity, lastUid: uid, updatedAt: now().toISOString() };
      db.insert(t.mailCursor).values({ folder, ...v }).onConflictDoUpdate({ target: t.mailCursor.folder, set: v }).run();
    };
    const list = await box.list(last, PER_RUN);
    for (const m of list) {
      const known = m.messageId && db.select({ id: t.mailSeen.messageId }).from(t.mailSeen).where(eq(t.mailSeen.messageId, m.messageId.trim().slice(0, 300))).get();
      if (known) { already++; advance(m.uid); continue; }
      const raw = m.size <= MAIL_LIMITS.message ? await box.source(m.uid, MAIL_LIMITS.message) : null;
      const key = keyOf(m.messageId, raw, m.uid, box.uidValidity);
      const record = (row: { kind: string; parsedJson: string | null; authJson: string; accepted: number }) => {
        db.insert(t.mailSeen).values({ messageId: key, parserVersion: PARSER_VERSION, seenAt: now().toISOString(), ...row }).onConflictDoNothing().run();
      };
      if (!raw) {
        record({ kind: 'unread', parsedJson: null, authJson: JSON.stringify({ accepted: false, reason: 'larger than 25 MB, not read' }), accepted: 0 });
        notVerified++; advance(m.uid); continue;
      }
      const auth = await verifyBookshopMail(raw, { arcSealers: cfg.arcSealers, resolver: deps.resolver });
      if (!auth.accepted) {
        record({ kind: 'not_verified', parsedJson: null, authJson: JSON.stringify(auth), accepted: 0 });
        notVerified++; advance(m.uid); continue;
      }
      let content;
      try {
        content = await readMail(raw, media);
      } catch (e) {
        // Without the media worker a PDF cannot be read now: stop here, and this mail is read again next time.
        if (e instanceof MediaUnavailable) return { status: 'blocked', detail: `stopped: ${e.message}; ${verified} verified, ${notVerified} not verified so far` };
        if (!(e instanceof MailUnreadable)) throw e;
        record({ kind: 'unreadable', parsedJson: null, authJson: JSON.stringify({ ...auth, reason: `${auth.reason}; ${e.message}` }), accepted: 0 });
        notVerified++; advance(m.uid); continue;
      }
      // Recognising quotes, orders and invoices is M3 (d): until then a verified mail waits as 'unclassified'.
      record({ kind: 'unclassified', parsedJson: JSON.stringify(content), authJson: JSON.stringify(auth), accepted: 1 });
      verified++; advance(m.uid);
    }
    return { status: 'done', detail: `${list.length} new: ${verified} verified, ${notVerified} not verified, ${already} seen before` };
  } finally {
    await box.close();
  }
}
