// The Inbox (spec §4, M3 e): what waits for a person to decide.
//
// - Shares are their sharer's alone: another adult never sees one, not even that it exists (404). What the AI found in a
//   share may rest on its sharer's takeaways (private_to), so this is where that rule holds for shares.
// - The bookshop's mail is the household's (orders and copies are shared): every adult sees the lines of verified mail
//   that matched no book (notBook lines, toys and games, too), the mail that failed closed or waits for the media
//   worker, and the mail that was not verified, of which the Inbox shows Shelf's reason and the day only (none of its
//   content is kept, contracts/connectors.md).
// - AI suggestions arrive with M3 g.
//
// Everything shown is data, sent as JSON and rendered as text: no field is ever HTML. Deciding a book is recorded once
// (inbox_decision); adding acts for yourself or a kid, never for another adult (the Backlog's rule).
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { components } from '@shelf/contracts/openapi';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { BacklogError, addToBacklog } from '../backlog/actions';
import { getPerson, view } from '../household/people';
import { norm } from '../seed/import';
import { foundBooks, ownShare, type ShareRow } from '../shares/shares';

type S = components['schemas'];
export type InboxItem = S['InboxItem'];
type Found = InboxItem['found'][number];
export type Filter = 'all' | 'ai' | 'shared' | 'mail';
export const FILTERS: Filter[] = ['all', 'ai', 'shared', 'mail'];

export class InboxError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}

/** Kinds of a mail_seen row that failed closed, or wait; and the unverified ones (accepted = 0). */
const FAILED = ['unknown_layout', 'reread_refused'];
const WAITING = ['pending_pdf'];
const LINES: Record<string, InboxItem['kind']> = { invoice: 'unmatched_invoice_line', bookshop_quote: 'unmatched_quote_line', online_order: 'unmatched_shop_line', click_collect: 'unmatched_shop_line' };
const MAIL_TITLE: Record<string, string> = { invoice: 'Invoice', bookshop_quote: 'Quote', online_order: 'Online order', click_collect: 'Click & collect' };

export const mailItemId = (key: string) => `m_${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32)}`;
export const shareItemId = (id: string) => `s_${id}`;

type MailRow = typeof t.mailSeen.$inferSelect;
interface Line { bookId?: string | null; title?: unknown; author?: unknown; ean?: unknown; notBook?: unknown; eanUnreadable?: unknown; qty?: unknown; priceC?: unknown; totalC?: unknown }
const str = (v: unknown, max = 300) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const json = (s: string | null): Record<string, unknown> => { try { const o = JSON.parse(s ?? '{}') as unknown; return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, unknown> : {}; } catch { return {}; } };

function decisions(db: Db, items: string[]): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>();
  if (!items.length) return out;
  for (const d of db.select().from(t.inboxDecision).where(inArray(t.inboxDecision.item, items)).all()) {
    if (!out.has(d.item)) out.set(d.item, new Map());
    out.get(d.item)!.set(d.idx, d.decision);
  }
  return out;
}

function shareItem(db: Db, s: ShareRow, decided: Map<number, string> | undefined): InboxItem {
  const by = getPerson(db, s.personId);
  const found = foundBooks(s).map((b, index): Found => ({
    index, title: b.title, author: b.author, verdict: b.offTheme ? 'skip_off_theme' : 'add',
    decided: (decided?.get(index) as Found['decided']) ?? null,
  }));
  const kept = (JSON.parse(s.mediaJson) as unknown[]).length;
  return {
    id: shareItemId(s.id), kind: 'share', ...(by ? { by: view(db, by) } : {}),
    title: s.title ?? (s.url ? new URL(s.url).hostname : s.mediaTotal ? `${s.mediaTotal} image${s.mediaTotal === 1 ? '' : 's'}` : 'A note'),
    createdAt: s.createdAt, mediaCount: kept,
    share: { status: s.status, progress: { done: Math.min(s.mediaTotal, kept + s.mediaRefused), total: s.mediaTotal }, refused: s.mediaRefused, url: s.url, note: s.note ?? s.caption },
    found,
  };
}

/** The mail's item, or null when nothing of it waits (every line matched or decided, or nothing to say). */
function mailItem(r: MailRow, decided: Map<number, string> | undefined): InboxItem | null {
  const id = mailItemId(r.messageId);
  if (r.accepted !== 1) {
    // Not verified: the reason and the day only.
    return { id, kind: 'mail_unverified', title: 'A mail that was not verified', createdAt: r.seenAt, mail: { reason: str(json(r.authJson).reason, 500) }, found: [] };
  }
  const p = json(r.parsedJson);
  const date = str(p.date, 40);
  const number = str(p.invoiceNumber, 40) ?? str(p.orderNumber, 40);
  if (FAILED.includes(r.kind)) {
    const reason = r.kind === 'reread_refused' ? str(json(r.authJson).reason, 500) : str(p.reason, 500);
    return { id, kind: 'mail_failed', title: str(p.subject) ?? 'A bookshop mail Shelf could not read', createdAt: r.seenAt, mail: { reason, expected: str(p.expected, 40), date, number }, found: [] };
  }
  if (WAITING.includes(r.kind)) {
    const tries = typeof p.tries === 'number' ? p.tries : 0;
    return { id, kind: 'mail_waiting', title: str(p.subject) ?? 'An invoice', createdAt: r.seenAt, mail: { reason: `its PDF waits for the media worker (tried ${tries} times)`, date, number }, found: [] };
  }
  const kind = LINES[r.kind];
  if (!kind || !Array.isArray(p.lines)) return null;
  const found = (p.lines as Line[]).flatMap((l, index): Found[] => {
    if (!l || typeof l !== 'object' || l.bookId || decided?.has(index)) return [];
    return [{
      index, title: str(l.title), author: str(l.author, 200), ean: str(l.ean, 13), decided: null,
      ...(l.notBook === true ? { notBook: true } : {}), ...(l.eanUnreadable === true ? { eanUnreadable: true } : {}),
      ...(typeof l.qty === 'number' ? { qty: l.qty } : {}),
      priceC: typeof l.totalC === 'number' ? l.totalC : typeof l.priceC === 'number' ? l.priceC : null,
    }];
  });
  if (!found.length) return null;
  return { id, kind, title: `${MAIL_TITLE[r.kind]}${number ? ` ${number}` : ''}`, createdAt: r.seenAt, mail: { date, number }, found };
}

export function listInbox(db: Db, me: string, filter: Filter = 'all'): InboxItem[] {
  const out: InboxItem[] = [];
  if (filter === 'all' || filter === 'shared') {
    const shares = db.select().from(t.share).where(eq(t.share.personId, me)).orderBy(desc(t.share.createdAt)).all();
    const d = decisions(db, shares.map((s) => shareItemId(s.id)));
    for (const s of shares) {
      const dd = d.get(shareItemId(s.id));
      if (dd?.has(-1)) continue;
      const item = shareItem(db, s, dd);
      // A share whose every book is decided has nothing left to ask.
      if (item.found.length && item.found.every((f) => f.decided)) continue;
      out.push(item);
    }
  }
  if (filter === 'all' || filter === 'mail') {
    const rows = db.select().from(t.mailSeen).orderBy(desc(t.mailSeen.seenAt)).all();
    const d = decisions(db, rows.map((r) => mailItemId(r.messageId)));
    for (const r of rows) {
      const dd = d.get(mailItemId(r.messageId));
      if (dd?.has(-1)) continue;
      const item = mailItem(r, dd);
      if (item) out.push(item);
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The item `id` names, as `me` may see it; else 404 (another adult's share included). */
function resolve(db: Db, me: string, id: string): { kind: 'share'; share: ShareRow } | { kind: 'mail'; row: MailRow } {
  if (/^s_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
    const share = ownShare(db, me, id.slice(2));
    if (share) return { kind: 'share', share };
  } else if (/^m_[0-9a-f]{32}$/.test(id)) {
    const row = db.select().from(t.mailSeen).all().find((r) => mailItemId(r.messageId) === id);
    if (row) return { kind: 'mail', row };
  }
  throw new InboxError(404, 'no such item');
}

function itemNow(db: Db, me: string, id: string): InboxItem {
  const it = resolve(db, me, id);
  const dd = decisions(db, [id]).get(id);
  if (it.kind === 'share') return shareItem(db, it.share, dd);
  return mailItem(it.row, dd) ?? { id, kind: LINES[it.row.kind] ?? 'mail_failed', title: MAIL_TITLE[it.row.kind] ?? 'A bookshop mail', createdAt: it.row.seenAt, found: [] };
}

/** POST /inbox/{itemId}/books/{index}: add or skip one book; returns the item as it is now. */
export function decide(db: Db, me: string, id: string, index: number, body: unknown, now = new Date()): InboxItem {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InboxError(400, 'a JSON object is needed');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!['action', 'for'].includes(k)) throw new InboxError(400, `unknown field ${k}`);
  if (b.action !== 'add' && b.action !== 'skip') throw new InboxError(400, 'action: add or skip');
  if (b.for !== undefined && (typeof b.for !== 'string' || b.for.length > 40)) throw new InboxError(400, 'for: a handle or me');
  if (!Number.isInteger(index) || index < 0 || index > 1000) throw new InboxError(404, 'no such book in this item');
  const it = resolve(db, me, id);
  if (db.select().from(t.inboxDecision).where(and(eq(t.inboxDecision.item, id), inArray(t.inboxDecision.idx, [index, -1]))).get()) throw new InboxError(409, 'decided already');

  let book: { title: string | null; author: string | null; ean: string | null; notBook?: boolean; invoice?: { qty: number; unitC: number; date: string | null } } | undefined;
  let origin: 'share' | 'manual' = 'manual';
  if (it.kind === 'share') {
    const f = foundBooks(it.share)[index];
    if (f) book = { title: f.title, author: f.author, ean: null };
    origin = 'share';
  } else {
    const p = json(it.row.parsedJson);
    const l = it.row.accepted === 1 && LINES[it.row.kind] && Array.isArray(p.lines) ? (p.lines as Line[])[index] : undefined;
    if (l && typeof l === 'object' && !l.bookId) {
      const qty = typeof l.qty === 'number' && l.qty > 0 ? l.qty : 1;
      book = {
        title: str(l.title), author: str(l.author, 200), ean: str(l.ean, 13), notBook: l.notBook === true,
        ...(it.row.kind === 'invoice' && typeof l.totalC === 'number' ? { invoice: { qty, unitC: Math.round(l.totalC / qty), date: str(p.date, 40) } } : {}),
      };
    }
  }
  if (!book) throw new InboxError(404, 'no such book in this item');

  const record = (decision: 'added' | 'skipped', bookId: string | null) =>
    db.insert(t.inboxDecision).values({ item: id, idx: index, decision, personId: me, bookId, decidedAt: now.toISOString() }).run();

  if (b.action === 'skip') { record('skipped', null); return itemNow(db, me, id); }
  if (book.notBook) throw new InboxError(400, 'not a book (its EAN is no ISBN): skip it');
  if (!book.title) throw new InboxError(400, 'no title to add it by: skip it, and add the book by hand');
  const isbn = book.ean && /^97[89]\d{10}$/.test(book.ean) ? book.ean : null;

  if (book.invoice) {
    // The invoice says the household bought it: a copy, as the invoice's effect would have made had the book been known.
    const inv = book.invoice;
    const bookId = findOrCreateBook(db, { title: book.title, author: book.author, isbn }, now);
    const acquired = inv.date && !Number.isNaN(Date.parse(inv.date)) ? new Date(inv.date).toISOString() : now.toISOString();
    db.transaction((tx) => {
      for (let i = 0; i < Math.min(inv.qty, 20); i++) tx.insert(t.copy).values({ id: ulid(), bookId, source: 'invoice', priceC: inv.unitC, acquiredAt: acquired }).run();
      tx.insert(t.inboxDecision).values({ item: id, idx: index, decision: 'added', personId: me, bookId, decidedAt: now.toISOString() }).run();
    });
    return itemNow(db, me, id);
  }

  // To a backlog: yourself or a kid (the Backlog's rule: never another adult's).
  let bookId: string;
  try {
    const cid = addToBacklog(db, me, { title: book.title, ...(book.author ? { author: book.author } : {}), ...(isbn ? { isbn13: isbn } : {}), ...(b.for ? { for: b.for } : {}) }, now,
      { origin, shareId: it.kind === 'share' ? it.share.id : null });
    bookId = cid.slice(cid.indexOf('.') + 1);
  } catch (e) {
    if (!(e instanceof BacklogError)) throw e;
    if (e.status !== 409) throw new InboxError(e.status, e.message);
    // Already in that backlog: added all the same.
    bookId = findOrCreateBook(db, { title: book.title, author: book.author, isbn }, now);
  }
  record('added', bookId);
  return itemNow(db, me, id);
}

function findOrCreateBook(db: Db, b: { title: string; author: string | null; isbn: string | null }, now: Date): string {
  const key = `${norm(b.title)}|${norm(b.author ?? '')}`;
  const found = (b.isbn ? db.select().from(t.book).where(eq(t.book.isbn13, b.isbn)).get() : undefined) ?? db.select().from(t.book).where(eq(t.book.normKey, key)).get();
  if (found) return found.id;
  const id = ulid();
  db.insert(t.book).values({ id, title: b.title, authorsJson: JSON.stringify(b.author ? [b.author] : []), isbn13: b.isbn, audience: 'adult', normKey: key, createdAt: now.toISOString() }).run();
  return id;
}

/** POST /inbox/{itemId}/dismiss: the whole item out of the Inbox. */
export function dismiss(db: Db, me: string, id: string, now = new Date()): void {
  resolve(db, me, id);
  db.insert(t.inboxDecision).values({ item: id, idx: -1, decision: 'dismissed', personId: me, bookId: null, decidedAt: now.toISOString() }).onConflictDoNothing().run();
}
