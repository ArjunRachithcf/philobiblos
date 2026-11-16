// The mail job (ADR 0007): reads what is new in the Shelf-only mailbox, checks who sent it, and records each verified
// mail once in mail_seen, keyed by its Message-ID (so a mail seen again, after a UIDVALIDITY change say, is not
// recorded twice). Only a verified mail claims its Message-ID: an unverified one is keyed by a hash of its bytes, so a
// forgery cannot take the id of the genuine mail that follows it. When the checks' settings change (or the reader's
// version), the window is read again, so a mail refused under the old settings is checked under the new ones.
// The first run reads the last 90 days only.
// It changes nothing else, and keeps no mail's text (read.ts): the parsers that turn a verified mail into quotes,
// orders and copies come later (M3 d) and read it again from the mailbox. A mail that fails the checks is kept as
// "not verified" with Shelf's reason only.
import { createHash } from 'node:crypto';
import { and } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { MailboxError, openMailbox, type Mailbox, type MailboxConfig } from '../net/imap';
import type { TxtResolver } from '../net/dns';
import type { Outcome } from '../jobs/books';
import { SEALED } from '../routes/month';
import { SealError, isSealed, sealingKey, unseal } from '../household/sealed';
import type { Config } from '../config';
import { MAIL_LIMITS, MailUnreadable, addressParts, readMail } from './read';
import { headerBlock, verifyBookshopMail } from './verify';

export const PARSER_VERSION = 'm3c-3';
export const PER_RUN = 200;
/** The first run, and a run after the settings changed, read mail from this many days back. */
export const WINDOW_DAYS = 90;

export interface MailDeps {
  open?: (c: MailboxConfig) => Promise<Mailbox>;
  resolver?: TxtResolver;
  now?: () => Date;
}

const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export type MailJobConfig = Pick<Config, 'arcSealers' | 'mailRecipients' | 'sealingKey'> & { imap: MailboxConfig | null };

export async function refreshMail(db: Db, cfg: MailJobConfig, deps: MailDeps = {}): Promise<Outcome> {
  if (!cfg.imap) return { status: 'blocked', detail: 'no mailbox is set up (SHELF_IMAP_HOST, SHELF_IMAP_USER, SHELF_IMAP_PASSWORD)' };
  const now = deps.now ?? (() => new Date());
  // The delivery address is sealed (PR #7); it is unsealed here only to find it in the mail and leave it out.
  let address: string[] = [];
  if (isSealed(db, SEALED.deliveryAddress)) {
    try { address = addressParts(unseal(db, sealingKey(cfg), SEALED.deliveryAddress)); } catch (e) {
      if (!(e instanceof SealError)) throw e;
      return { status: 'blocked', detail: 'the sealing key cannot open the delivery address, so it could not be kept out of the mail: nothing read' };
    }
  }
  const recipients = [...new Set([...cfg.mailRecipients, ...(cfg.imap.user.includes('@') ? [cfg.imap.user] : [])].map((r) => r.toLowerCase()))];
  const configKey = hash(JSON.stringify([PARSER_VERSION, [...cfg.arcSealers].sort(), [...recipients].sort()]));
  let box: Mailbox;
  try { box = await (deps.open ?? openMailbox)(cfg.imap); } catch (e) {
    return { status: 'failed', detail: e instanceof MailboxError ? e.message : 'cannot reach the mailbox' };
  }
  const folder = cfg.imap.folder;
  let verified = 0, notVerified = 0, already = 0;
  try {
    const cur = db.select().from(t.mailCursor).where(eq(t.mailCursor.folder, folder)).get();
    const fresh = !cur || cur.uidValidity !== box.uidValidity || cur.configKey !== configKey;
    let last = fresh ? 0 : cur.lastUid;
    const advance = (uid: number) => {
      last = uid;
      const v = { uidValidity: box.uidValidity, lastUid: uid, configKey, updatedAt: now().toISOString() };
      db.insert(t.mailCursor).values({ folder, ...v }).onConflictDoUpdate({ target: t.mailCursor.folder, set: v }).run();
    };
    const list = await box.list(last, PER_RUN, last === 0 ? new Date(now().getTime() - WINDOW_DAYS * 86_400_000) : undefined);
    for (const m of list) {
      const id = m.messageId?.trim().slice(0, 300) || null;
      // Known only as a verified mail: an unverified row never stands for a Message-ID.
      const known = id && db.select({ id: t.mailSeen.messageId }).from(t.mailSeen).where(and(eq(t.mailSeen.messageId, id), eq(t.mailSeen.accepted, 1))).get();
      if (known) { already++; advance(m.uid); continue; }
      const raw = m.size <= MAIL_LIMITS.message ? await box.source(m.uid, MAIL_LIMITS.message) : null;
      const unverifiedKey = `unverified:${raw ? hash(raw) : `uid:${box.uidValidity}:${m.uid}`}`;
      const record = ({ signedId, ...row }: { kind: string; parsedJson: string | null; authJson: string; accepted: number; signedId?: string | null }) => {
        // A verified mail is keyed by its Message-ID as signed (not the server's envelope of it).
        const key = row.accepted === 1 && signedId ? signedId : row.accepted === 1 && raw ? `sha256:${hash(raw)}` : unverifiedKey;
        const v = { parserVersion: PARSER_VERSION, seenAt: now().toISOString(), ...row };
        db.insert(t.mailSeen).values({ messageId: key, ...v }).onConflictDoUpdate({ target: t.mailSeen.messageId, set: v }).run();
        // Verified now: what was kept of it as unverified goes.
        if (row.accepted === 1) db.delete(t.mailSeen).where(eq(t.mailSeen.messageId, unverifiedKey)).run();
      };
      if (!raw) {
        record({ kind: 'unread', parsedJson: null, authJson: JSON.stringify({ accepted: false, reason: 'larger than 25 MB, not read' }), accepted: 0 });
        notVerified++; advance(m.uid); continue;
      }
      const auth = await verifyBookshopMail(raw, { arcSealers: cfg.arcSealers, recipients, resolver: deps.resolver });
      if (!auth.accepted) {
        record({ kind: 'not_verified', parsedJson: null, authJson: JSON.stringify(auth), accepted: 0 });
        notVerified++; advance(m.uid); continue;
      }
      let content;
      try {
        const hb = headerBlock(raw);
        if (!('block' in hb)) throw new MailUnreadable('headers');
        content = await readMail(raw, hb.block, address);
      } catch (e) {
        if (!(e instanceof MailUnreadable)) throw e;
        record({ kind: 'unreadable', parsedJson: null, authJson: JSON.stringify({ ...auth, accepted: false, reason: `${auth.reason}; ${e.message}` }), accepted: 0 });
        notVerified++; advance(m.uid); continue;
      }
      // Recognising quotes, orders and invoices is M3 (d): until then a verified mail waits as 'unclassified'.
      // Where it is, so the parsers of M3 (d) can read it again from the mailbox; never its text (read.ts).
      record({ kind: 'unclassified', parsedJson: JSON.stringify({ ...content, uidValidity: box.uidValidity, uid: m.uid }), authJson: JSON.stringify(auth), accepted: 1, signedId: auth.messageId ?? null });
      verified++; advance(m.uid);
    }
    return { status: 'done', detail: `${list.length} new: ${verified} verified, ${notVerified} not verified, ${already} seen before` };
  } finally {
    await box.close();
  }
}
