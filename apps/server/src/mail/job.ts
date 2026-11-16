// The mail job (ADR 0007): reads what is new in the Shelf-only mailbox, checks who sent it, parses what the bookshop
// sent (parse.ts) and applies it (effects.ts), recording each verified mail once in mail_seen, keyed by its Message-ID
// as signed (so a mail seen again, after a UIDVALIDITY change say, is not applied twice). Only a verified mail claims
// its Message-ID: an unverified one is keyed by a hash of its bytes, so a forgery cannot take the id of the genuine
// mail that follows it. When the checks' settings change (or the reader's version), the window is read again, so a
// mail refused under the old settings is checked under the new ones. The first run reads the last 90 days only.
//
// No mail's text is kept (read.ts): a mail that is not finished (its invoice PDF waits for the media worker, a layout
// no parser of this version knows, a mail read before the parsers existed) keeps only where it is in the mailbox, and
// is read again from there (`reread`), by its UID under the same UIDVALIDITY and never another, through every check
// once more (`openVerified`). The effects and the mail's row are written in one transaction. A mail that fails the
// checks is kept as "not verified" with Shelf's reason only, and changes nothing.
import { createHash } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { MailboxError, openMailbox, type Mailbox, type MailboxConfig } from '../net/imap';
import type { TxtResolver } from '../net/dns';
import type { Outcome } from '../jobs/books';
import { SEALED } from '../routes/month';
import { SealError, isSealed, sealingKey, unseal } from '../household/sealed';
import { MediaUnavailable, runMediaJob, type MediaOutcome } from '../media/client';
import type { Config } from '../config';
import { MAIL_LIMITS, addressParts, openVerified, type VerifiedMail } from './read';
import { PARSERS, classify, parseInvoice, parseQuote, parseShop, type Parsed } from './parse';
import { applyMail } from './effects';

export const PARSER_VERSION = 'm3d-1';
/** Kinds of a verified mail that is not finished, read again from the mailbox. */
export const UNFINISHED = ['unclassified', 'pending_pdf', 'unknown_layout'] as const;
/** At most this many unfinished mails read again per run; a PDF is tried this many times before its mail is given up. */
export const REREAD_PER_RUN = 20;
export const PDF_TRIES = 5;
export const PER_RUN = 200;
/** The first run, and a run after the settings changed, read mail from this many days back. */
export const WINDOW_DAYS = 90;

export interface MailDeps {
  open?: (c: MailboxConfig) => Promise<Mailbox>;
  resolver?: TxtResolver;
  now?: () => Date;
  /** The media worker's PDF text (default: runMediaJob('pdf.text') in SHELF_WORK_DIR). */
  pdfText?: (pdf: Uint8Array) => Promise<MediaOutcome>;
}

const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export type MailJobConfig = Pick<Config, 'arcSealers' | 'mailRecipients' | 'sealingKey'> & { imap: MailboxConfig | null; workDir?: string | null };

/** The kind and fields of a verified mail; an invoice's PDFs through the media worker (null: not now, try later). */
async function parse(m: VerifiedMail, address: string[], pdfText: (pdf: Uint8Array) => Promise<MediaOutcome>): Promise<Parsed | null> {
  const k = classify(m.auth.from, m.content.subject);
  if (m.tooLong) return { kind: 'unknown_layout', parser: PARSERS.classify, expected: k.kind, reason: 'too long' };
  switch (k.kind) {
    case 'quote_or_confirm': return parseQuote(m.text, address);
    case 'online_order': case 'click_collect': return parseShop(k.kind, k.number, m.text, address);
    case 'other': return { kind: 'other', parser: PARSERS.classify };
    case 'invoice': {
      if (!m.pdfs.length) return { kind: 'unknown_layout', parser: PARSERS.invoice, expected: 'invoice', reason: 'no PDF' };
      const rows: string[][] = [];
      let truncated = false;
      // The PDF's text is read in the media worker, never here, and is never stored.
      for (const pdf of m.pdfs.slice(0, 5)) {
        let r;
        try { r = await pdfText(pdf); } catch (e) { if (e instanceof MediaUnavailable) return null; throw e; }
        if (!r.ok) {
          if (r.error === 'busy' || r.error === 'timeout') return null;
          return { kind: 'unknown_layout', parser: PARSERS.invoice, expected: 'invoice', reason: `the PDF could not be read (${r.error})` };
        }
        if (r.kind !== 'pdf.text') return null;
        rows.push(...r.rows);
        truncated ||= r.truncated;
      }
      return parseInvoice(k.number, rows, truncated, address);
    }
  }
}

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
  const pdfText = deps.pdfText ?? ((pdf: Uint8Array) => runMediaJob(cfg.workDir ?? null, 'pdf.text', pdf));
  const done = new Set<string>();
  const row = (key: string, v: { kind: string; parsedJson: string | null; authJson: string; accepted: number; parserVersion?: string }, tx: Pick<Db, 'insert'> = db) => {
    const w = { parserVersion: PARSER_VERSION, seenAt: now().toISOString(), ...v };
    tx.insert(t.mailSeen).values({ messageId: key, ...w }).onConflictDoUpdate({ target: t.mailSeen.messageId, set: w }).run();
  };
  /** Parses a verified mail and applies it, with its row, in one transaction; or keeps it waiting for its PDF. */
  const finish = async (m: VerifiedMail, key: string, uid: number, tries: number, unverifiedKey?: string) => {
    done.add(key);
    const where = { ...m.content, uidValidity: box.uidValidity, uid };
    let parsed = await parse(m, address, pdfText);
    if (!parsed && tries + 1 < PDF_TRIES) {
      row(key, { kind: 'pending_pdf', parsedJson: JSON.stringify({ ...where, tries: tries + 1 }), authJson: JSON.stringify(m.auth), accepted: 1 });
      return;
    }
    parsed ??= { kind: 'unknown_layout', parser: PARSERS.invoice, expected: 'invoice', reason: 'the media worker did not read the PDF' };
    const p = parsed;
    db.transaction((tx) => {
      const applied = applyMail(tx, m, p, { key, now: now().toISOString() });
      row(key, { kind: p.kind, parserVersion: `${PARSER_VERSION}/${p.parser}`, parsedJson: JSON.stringify({ ...where, ...applied }), authJson: JSON.stringify(m.auth), accepted: 1 }, tx);
      // Verified now: what was kept of it as unverified goes.
      if (unverifiedKey) tx.delete(t.mailSeen).where(eq(t.mailSeen.messageId, unverifiedKey)).run();
    });
  };
  /**
   * Unfinished mails read again from the mailbox: by the UID kept for them, only under the same UIDVALIDITY (a
   * renumbered folder is read afresh by the window instead), through every check again, and only if the mail there
   * is the same one (its signed Message-ID). A mail that no longer passes is tried a few times, then given up.
   */
  const reread = async () => {
    let n = 0;
    const rows = db.select().from(t.mailSeen).where(and(eq(t.mailSeen.accepted, 1), inArray(t.mailSeen.kind, [...UNFINISHED]))).all()
      .filter((r) => !done.has(r.messageId) && (r.kind !== 'unknown_layout' || !r.parserVersion.startsWith(`${PARSER_VERSION}/`)));
    for (const r of rows.slice(0, REREAD_PER_RUN)) {
      const p = JSON.parse(r.parsedJson ?? '{}') as { uid?: unknown; uidValidity?: unknown; tries?: unknown };
      if (typeof p.uid !== 'number' || p.uidValidity !== box.uidValidity) continue;
      const tries = typeof p.tries === 'number' ? p.tries : 0;
      const raw = await box.source(p.uid, MAIL_LIMITS.message);
      if (!raw) continue;
      const opened = await openVerified(raw, { arcSealers: cfg.arcSealers, recipients, resolver: deps.resolver, address });
      const same = opened.ok && opened.mail.auth.messageId === r.messageId;
      if (!opened.ok || !same) {
        const reason = !opened.ok ? `read again: ${opened.auth.reason}${opened.unreadable ? `; ${opened.unreadable}` : ''}` : 'read again: another mail is at its place in the mailbox';
        const giveUp = opened.ok || tries + 1 >= PDF_TRIES;
        row(r.messageId, { kind: giveUp ? 'reread_refused' : r.kind, parsedJson: JSON.stringify({ ...JSON.parse(r.parsedJson ?? '{}'), tries: tries + 1 }), authJson: JSON.stringify({ accepted: false, reason }), accepted: 1 });
        continue;
      }
      await finish(opened.mail, r.messageId, p.uid, tries);
      n++;
    }
    return n;
  };
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
      // A mail not finished (waiting for its PDF, say) is read again here in full.
      const known = id && db.select({ id: t.mailSeen.messageId }).from(t.mailSeen).where(and(eq(t.mailSeen.messageId, id), eq(t.mailSeen.accepted, 1), ...UNFINISHED.map((k) => ne(t.mailSeen.kind, k)))).get();
      if (known) { already++; advance(m.uid); continue; }
      const raw = m.size <= MAIL_LIMITS.message ? await box.source(m.uid, MAIL_LIMITS.message) : null;
      const unverifiedKey = `unverified:${raw ? hash(raw) : `uid:${box.uidValidity}:${m.uid}`}`;
      const record = (v: { kind: string; parsedJson: null; authJson: string; accepted: 0 }) => row(unverifiedKey, v);
      if (!raw) {
        record({ kind: 'unread', parsedJson: null, authJson: JSON.stringify({ accepted: false, reason: 'larger than 25 MB, not read' }), accepted: 0 });
        notVerified++; advance(m.uid); continue;
      }
      const opened = await openVerified(raw, { arcSealers: cfg.arcSealers, recipients, resolver: deps.resolver, address });
      if (!opened.ok) {
        const unreadable = opened.unreadable ? { kind: 'unreadable', authJson: JSON.stringify({ ...opened.auth, accepted: false, reason: `${opened.auth.reason}; ${opened.unreadable}` }) } : { kind: 'not_verified', authJson: JSON.stringify(opened.auth) };
        record({ ...unreadable, parsedJson: null, accepted: 0 });
        notVerified++; advance(m.uid); continue;
      }
      // A verified mail is keyed by its Message-ID as signed (not the server's envelope of it).
      await finish(opened.mail, opened.mail.auth.messageId || `sha256:${hash(raw)}`, m.uid, 0, unverifiedKey);
      verified++; advance(m.uid);
    }
    const again = await reread();
    return { status: 'done', detail: `${list.length} new: ${verified} verified, ${notVerified} not verified, ${already} seen before${again ? `; ${again} read again` : ''}` };
  } finally {
    await box.close();
  }
}
