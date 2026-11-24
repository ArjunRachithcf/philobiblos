// The Inbox (spec §4, M3 e): what waits for a person to decide.
//
// - Shares are their sharer's alone: another adult never sees one, not even that it exists (404). What the AI found in a
//   share may rest on its sharer's takeaways (private_to), so this is where that rule holds for shares.
// - The bookshop's mail is the household's (orders and copies are shared): every adult sees the lines of verified mail
//   that matched no book (notBook lines, toys and games, too), the mail that failed closed or waits for the media
//   worker, and the mail that was not verified, of which the Inbox shows Philobiblos's reason and the day only (none of its
//   content is kept, contracts/connectors.md).
// - AI suggestions (M3 g) are their person's alone, like shares: suggestNext's runs for that person, each checked again
//   against its schema when read; adding one puts it in your own backlog (origin ai), never a kid's or another adult's.
//
// Everything shown is data, sent as JSON and rendered as text: no field is ever HTML. Deciding a book is recorded once
// (inbox_decision); adding acts for yourself or a kid, never for another adult (the Backlog's rule).
import { and, count, desc, eq, gt, inArray, isNotNull, lt, lte, max, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { ulid } from 'ulid';
import type { components } from '@philobiblos/contracts/openapi';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { actsFor, getPerson, household, view } from '../household/people';
import { entryWaitLeft, invoiceLines, invoiceOrders, mailEntries, mailItemId, mailLeft, matchBook, maybeTyped, overlap, receive, type Part } from '../mail/effects';
import { MONTHS } from '../month/order-mail';
import { norm } from '../seed/import';
import { foundBooks, keptFiles, ownShare, shareAiNote, type ShareRow } from '../shares/shares';
import { validateAiOutput, type SuggestNextOut } from '@philobiblos/contracts';

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

export { mailItemId };
export const shareItemId = (id: string) => `s_${id}`;
export const aiItemId = (runId: string) => `a_${runId}`;
type AiRow = typeof t.aiRun.$inferSelect;

/** A suggestNext run's suggestions, as untrusted data: valid against the contract, or none. */
function suggestions(r: Pick<AiRow, 'outputJson'>): SuggestNextOut['suggestions'] {
  let o: unknown;
  try { o = JSON.parse(r.outputJson ?? 'null'); } catch { return []; }
  return validateAiOutput('suggestNext', o).ok ? (o as SuggestNextOut).suggestions : [];
}

function aiItem(r: AiRow, decided: Map<number, string> | undefined): InboxItem | null {
  const found = suggestions(r).flatMap((x, index): Found[] => (decided?.has(index) ? [] : [{
    index, title: x.title, author: x.author, verdict: 'add', idea: x.idea, why: x.why, move: x.move, decided: null,
  }]));
  if (!found.length) return null;
  return { id: aiItemId(r.id), kind: 'ai_suggestion', title: `Suggested for you: ${found.length} book${found.length === 1 ? '' : 's'}`, createdAt: r.startedAt, found };
}

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
  const files = keptFiles(s.mediaJson);
  return {
    id: shareItemId(s.id), kind: 'share', ...(by ? { by: view(db, by) } : {}),
    title: s.title ?? (s.url ? new URL(s.url).hostname : s.mediaTotal ? `${s.mediaTotal} file${s.mediaTotal === 1 ? '' : 's'}` : 'A note'),
    createdAt: s.createdAt, mediaCount: kept,
    share: { status: s.status, progress: { done: Math.min(s.mediaTotal, files + s.mediaRefused), total: s.mediaTotal }, refused: s.mediaRefused, url: s.url, note: s.note ?? s.caption, aiNote: shareAiNote(s) },
    found,
  };
}

/** The mail's item, or null when nothing of it waits (every line matched or decided, or nothing to say). */
function mailItem(db: Db, r: MailRow, decided: Map<number, string> | undefined): InboxItem | null {
  const id = mailItemId(r.messageId);
  if (r.accepted !== 1) return null; // unverified mail is one item for all of it (unverifiedItem)
  const p = json(r.parsedJson);
  const date = str(p.date, 40);
  const number = str(p.invoiceNumber, 40) ?? str(p.orderNumber, 40);
  if (r.kind === 'invoice' && typeof p.maybeTyped === 'string') return maybeTypedItem(db, r, p, p.maybeTyped, { date, number });
  if (FAILED.includes(r.kind)) {
    const reason = r.kind === 'reread_refused' ? str(json(r.authJson).reason, 500) : str(p.reason, 500);
    return { id, kind: 'mail_failed', title: str(p.subject) ?? 'A bookshop mail Philobiblos could not read', createdAt: r.seenAt, mail: { reason, expected: str(p.expected, 40), date, number }, found: [] };
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

/** A page of the Inbox: at most `max` items; at most `scan` rows read for one page (the rest on the next). */
export const PAGE = { default: 50, max: 100, scan: 2000, batch: 200 } as const;
/** The one item that stands for every unverified mail since it was last dismissed. */
export const UNVERIFIED_ID = 'm_unverified';

interface Pos { at: string; tag: 'a' | 'm' | 's'; key: string }
const encode = (p: Pos) => Buffer.from(JSON.stringify([p.at, p.tag, p.key])).toString('base64url');
export function parseCursor(v: unknown): Pos | null {
  if (typeof v !== 'string' || v.length > 600) return null;
  try {
    const a = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(a) && a.length === 3 && typeof a[0] === 'string' && (a[1] === 'a' || a[1] === 'm' || a[1] === 's') && typeof a[2] === 'string') return { at: a[0], tag: a[1], key: a[2] };
  } catch { /* not a cursor */ }
  return null;
}
const before = (a: Pos, b: Pos) => a.at < b.at || (a.at === b.at && (a.tag < b.tag || (a.tag === b.tag && a.key < b.key)));

/** Rows of one source after `after` (in the Inbox's order: newest first), a batch at a time. */
type Source = { tag: 'a' | 'm' | 's'; read: (after: Pos | null) => { pos: Pos; item: () => InboxItem | null }[]; done: boolean; buf: { pos: Pos; item: () => InboxItem | null }[]; last: Pos | null };

/** The condition "(at, key) comes after the cursor" for a source with this tag (the cursor names any source). */
function after(at: AnySQLiteColumn, key: AnySQLiteColumn, tag: 'a' | 'm' | 's', c: Pos | null) {
  if (!c) return undefined;
  if (tag < c.tag) return lte(at, c.at);
  if (tag > c.tag) return lt(at, c.at);
  return sql`(${at}, ${key}) < (${c.at}, ${c.key})`;
}

function unverifiedItem(db: Db): InboxItem | null {
  const since = db.select().from(t.inboxDecision).where(and(eq(t.inboxDecision.item, UNVERIFIED_ID), eq(t.inboxDecision.idx, -1))).get()?.decidedAt ?? '';
  const where = and(eq(t.mailSeen.accepted, 0), gt(t.mailSeen.seenAt, since));
  const head = db.select({ n: count(), latest: max(t.mailSeen.seenAt) }).from(t.mailSeen).where(where).get();
  if (!head?.n || !head.latest) return null;
  const reason = sql<string | null>`json_extract(${t.mailSeen.authJson}, '$.reason')`;
  const reasons = db.select({ reason, n: count() }).from(t.mailSeen).where(where).groupBy(reason).orderBy(desc(count())).limit(5).all()
    .map((r) => ({ reason: str(r.reason, 200) ?? 'no reason recorded', count: r.n }));
  return {
    id: UNVERIFIED_ID, kind: 'mail_unverified', title: `${head.n} mail${head.n === 1 ? '' : 's'} not verified`, createdAt: head.latest,
    mail: { reason: reasons[0]?.reason ?? null }, unverified: { count: head.n, reasons }, found: [],
  };
}

/**
 * GET /inbox, a page at a time (newest first). Every source is read in batches with its decisions for that batch only,
 * so no query grows with the mailbox; unverified mail is one item, however much of it there is.
 */
export function listInbox(db: Db, me: string, filter: Filter = 'all', o: { cursor?: Pos | null; limit?: number } = {}): { items: InboxItem[]; nextCursor: string | null } {
  const limit = Math.min(o.limit ?? PAGE.default, PAGE.max);
  const cursor = o.cursor ?? null;
  const items: InboxItem[] = [];
  const sources: Source[] = [];
  if (filter === 'all' || filter === 'shared') {
    sources.push({ tag: 's', done: false, buf: [], last: null, read: (c) => {
      const rows = db.select().from(t.share).where(and(eq(t.share.personId, me), after(t.share.createdAt, t.share.id, 's', c)))
        .orderBy(desc(t.share.createdAt), desc(t.share.id)).limit(PAGE.batch).all();
      const ids = rows.map((r) => shareItemId(r.id));
      const d = decisions(db, ids);
      const inBacklog = new Set(rows.length ? db.selectDistinct({ id: t.candidate.shareId }).from(t.candidate).where(inArray(t.candidate.shareId, rows.map((r) => r.id))).all().map((x) => x.id) : []);
      return rows.map((r) => ({ pos: { at: r.createdAt, tag: 's' as const, key: r.id }, item: () => {
        const dd = d.get(shareItemId(r.id));
        if (dd?.has(-1)) return null;
        const it = shareItem(db, r, dd);
        // A share whose every book is decided has nothing left to ask; nor has one (imported, say) whose books are in a
        // backlog already and that offers none.
        if (it.found.length && it.found.every((f) => f.decided)) return null;
        if (!it.found.length && r.status === 'done' && inBacklog.has(r.id)) return null;
        return it;
      } }));
    } });
  }
  if (filter === 'all' || filter === 'ai') {
    sources.push({ tag: 'a', done: false, buf: [], last: null, read: (c) => {
      const rows = db.select().from(t.aiRun).where(and(eq(t.aiRun.job, 'suggestNext'), eq(t.aiRun.personId, me), isNotNull(t.aiRun.outputJson), after(t.aiRun.startedAt, t.aiRun.id, 'a', c)))
        .orderBy(desc(t.aiRun.startedAt), desc(t.aiRun.id)).limit(PAGE.batch).all();
      const d = decisions(db, rows.map((r) => aiItemId(r.id)));
      return rows.map((r) => ({ pos: { at: r.startedAt, tag: 'a' as const, key: r.id }, item: () => {
        const dd = d.get(aiItemId(r.id));
        return dd?.has(-1) ? null : aiItem(r, dd);
      } }));
    } });
  }
  if (filter === 'all' || filter === 'mail') {
    if (!cursor) { const u = unverifiedItem(db); if (u) items.push(u); }
    sources.push({ tag: 'm', done: false, buf: [], last: null, read: (c) => {
      const rows = db.select().from(t.mailSeen).where(and(eq(t.mailSeen.accepted, 1), inArray(t.mailSeen.kind, [...Object.keys(LINES), ...FAILED, ...WAITING]), after(t.mailSeen.seenAt, t.mailSeen.messageId, 'm', c)))
        .orderBy(desc(t.mailSeen.seenAt), desc(t.mailSeen.messageId)).limit(PAGE.batch).all();
      const d = decisions(db, rows.map((r) => mailItemId(r.messageId)));
      return rows.map((r) => ({ pos: { at: r.seenAt, tag: 'm' as const, key: r.messageId }, item: () => {
        const dd = d.get(mailItemId(r.messageId));
        return dd?.has(-1) ? null : mailItem(db, r, dd);
      } }));
    } });
  }
  let scanned = 0;
  let last: Pos | null = null;
  for (;;) {
    for (const src of sources) {
      if (src.buf.length || src.done) continue;
      const got = src.read(src.last ?? cursor);
      if (got.length < PAGE.batch) src.done = true;
      src.buf = got;
      if (got.length) src.last = got[got.length - 1]!.pos;
    }
    const live = sources.filter((x) => x.buf.length);
    if (!live.length) return { items, nextCursor: null };
    if (items.length >= limit || scanned >= PAGE.scan) return { items, nextCursor: last ? encode(last) : null };
    // The newest of the sources' heads.
    const src = live.reduce((a, b) => (before(a.buf[0]!.pos, b.buf[0]!.pos) ? b : a));
    const row = src.buf.shift()!;
    scanned++;
    last = row.pos;
    const it = row.item();
    if (it) items.push(it);
  }
}

/** The item `id` names, as `me` may see it; else 404 (another adult's share included). */
function resolve(db: Db, me: string, id: string): { kind: 'share'; share: ShareRow } | { kind: 'mail'; row: MailRow } | { kind: 'ai'; run: AiRow } {
  if (/^a_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
    // Only your own suggestions: another adult's are not there for you.
    const run = db.select().from(t.aiRun).where(and(eq(t.aiRun.id, id.slice(2)), eq(t.aiRun.job, 'suggestNext'), eq(t.aiRun.personId, me), isNotNull(t.aiRun.outputJson))).get();
    if (run) return { kind: 'ai', run };
  } else if (/^s_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
    const share = ownShare(db, me, id.slice(2));
    if (share) return { kind: 'share', share };
  } else if (/^m_[0-9a-f]{32}$/.test(id)) {
    // Verified mail only: an unverified one is never an item of its own (unverifiedItem), so it has nothing to decide.
    const key = db.select({ id: t.mailSeen.messageId }).from(t.mailSeen).where(eq(t.mailSeen.accepted, 1)).all().find((r) => mailItemId(r.id) === id);
    const row = key && db.select().from(t.mailSeen).where(eq(t.mailSeen.messageId, key.id)).get();
    if (row) return { kind: 'mail', row };
  }
  throw new InboxError(404, 'no such item');
}

function itemNow(db: Db, me: string, id: string): InboxItem {
  const it = resolve(db, me, id);
  const dd = decisions(db, [id]).get(id);
  if (it.kind === 'share') return shareItem(db, it.share, dd);
  if (it.kind === 'ai') return aiItem(it.run, dd) ?? { id, kind: 'ai_suggestion', title: 'Suggested for you', createdAt: it.run.startedAt, found: [] };
  return mailItem(db, it.row, dd) ?? { id, kind: LINES[it.row.kind] ?? 'mail_failed', title: MAIL_TITLE[it.row.kind] ?? 'A bookshop mail', createdAt: it.row.seenAt, found: [] };
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
  // A mail held as maybe a typed invoice changes nothing, a line of it neither, until it is answered (philobiblos#64).
  if (it.kind === 'mail' && waitsForAnswer(it.row)) throw new InboxError(409, 'answer it first: the same invoice as the one typed, or another purchase');

  let book: { title: string | null; author: string | null; ean: string | null; notBook?: boolean; eanUnreadable?: boolean; invoice?: { qty: number; unitC: number; totalC: number; date: string | null; day: string | null; readAt: string } } | undefined;
  let shareId: string | null = null;
  let origin: 'share' | 'manual' | 'ai' = 'manual';
  if (it.kind === 'ai') {
    const x = suggestions(it.run)[index];
    if (x) book = { title: x.title, author: x.author, ean: null };
    // A suggestion grows its person's brain: for them, never for a kid (or another adult).
    if (b.for !== undefined && b.for !== 'me' && b.action === 'add') throw new InboxError(400, 'a suggestion is for yourself: add it without for');
    origin = 'ai';
  } else if (it.kind === 'share') {
    const f = foundBooks(it.share)[index];
    if (f) book = { title: f.title, author: f.author, ean: null };
    shareId = it.share.id;
    origin = 'share';
  } else {
    const p = json(it.row.parsedJson);
    const l = LINES[it.row.kind] && Array.isArray(p.lines) ? (p.lines as Line[])[index] : undefined;
    if (l && typeof l === 'object' && !l.bookId) {
      const qty = typeof l.qty === 'number' && l.qty > 0 ? l.qty : 1;
      book = {
        title: str(l.title), author: str(l.author, 200), ean: str(l.ean, 13), notBook: l.notBook === true, eanUnreadable: l.eanUnreadable === true,
        ...(it.row.kind === 'invoice' && typeof l.totalC === 'number' ? { invoice: { qty, unitC: Math.round(l.totalC / qty), totalC: l.totalC, date: str(p.date, 40), day: DAY.test(str(p.day, 24) ?? '') ? str(p.day, 24) : null, readAt: it.row.seenAt } } : {}),
      };
    }
  }
  if (!book) throw new InboxError(404, 'no such book in this item');

  const record = (tx: Pick<Db, 'insert'>, decision: 'added' | 'skipped', bookId: string | null) =>
    tx.insert(t.inboxDecision).values({ item: id, idx: index, decision, personId: me, bookId, decidedAt: now.toISOString() }).run();

  if (b.action === 'skip') { record(db, 'skipped', null); return itemNow(db, me, id); }
  if (book.notBook) throw new InboxError(400, 'not a book (its EAN is no ISBN): skip it');
  // A row read whole but for its EAN may be a position number or a page row as much as a book: skip only.
  if (book.eanUnreadable) throw new InboxError(400, 'its EAN could not be read: skip it, and add the book by hand');
  if (!book.title) throw new InboxError(400, 'no title to add it by: skip it, and add the book by hand');
  const isbn = book.ean && /^97[89]\d{10}$/.test(book.ean) ? book.ean : null;

  // For yourself or a kid (the Backlog's rule: never another adult's).
  const forWho = typeof b.for === 'string' && b.for && b.for !== 'me' ? b.for : null;
  const target = forWho ? household(db).find((p) => p.handle === forWho) : getPerson(db, me);
  if (!target) throw new InboxError(404, 'no one in the household has that handle');
  if (actsFor(db, me, target.id) !== 'yes') throw new InboxError(403, 'only they change their own books');
  const iso = now.toISOString();

  db.transaction((tx) => {
    const bookId = findOrCreateBook(tx, { title: book.title!, author: book.author, isbn, audience: target.role === 'kid' ? 'kids' : 'adult' }, iso);
    if (book.invoice) {
      // The invoice says the household bought it: copies and the price paid, as the invoice's effect would have made
      // had the book been known (the order line it was ordered in delivered), and on the to-read pile of whoever it is for.
      const inv = book.invoice;
      // An invoice with no date it can read counts from when its mail was read, never from this decision (philobiblos#53).
      const acquired = inv.date && !Number.isNaN(Date.parse(inv.date)) ? new Date(inv.date).toISOString() : inv.readAt;
      // A line of more copies than one makes is invoiced for the copies made, at the price of one (philobiblos#53).
      const copies = Math.min(inv.qty, MAX_COPIES);
      const orderId = receive(tx, { bookId, qty: copies, unitC: inv.unitC, acquiredAt: acquired, source: 'invoice', day: inv.day }, iso);
      if (orderId) invoiceOrders(tx, new Map([[orderId, copies === inv.qty ? inv.totalC : inv.unitC * copies]]));
      if (forWho) tx.insert(t.reading).values({ personId: target.id, bookId, status: 'to_read', updatedAt: iso }).onConflictDoNothing().run();
    } else {
      // Already in that backlog: added all the same.
      tx.insert(t.candidate).values({ personId: target.id, bookId, origin, shareId, addedAt: iso, touchedAt: iso }).onConflictDoNothing().run();
    }
    record(tx, 'added', bookId);
  });
  return itemNow(db, me, id);
}

/** A mail's day as read.ts `mailDay` keeps it (a mail read before it was kept has none: the UTC day of its date). */
export const DAY = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/;

/** Copies an invoice line added from the Inbox makes at most (a line's quantity is two digits). */
export const MAX_COPIES = 20;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** The one book the line names, as the mail's effects match it (EAN, then title and author); else a new one. */
function findOrCreateBook(tx: Tx, b: { title: string; author: string | null; isbn: string | null; audience: 'adult' | 'kids' }, iso: string): string {
  const books = tx.select().from(t.book).all().map((x) => ({ id: x.id, title: x.title, authors: JSON.parse(x.authorsJson) as string[], isbn13: x.isbn13 }));
  const found = matchBook(books, { ean: b.isbn, title: b.title, author: b.author });
  if (found) return found;
  const id = ulid();
  tx.insert(t.book).values({ id, title: b.title, authorsJson: JSON.stringify(b.author ? [b.author] : []), isbn13: b.isbn, audience: b.audience, normKey: `${norm(b.title)}|${norm(b.author ?? '')}`, createdAt: iso }).run();
  return id;
}

/** POST /inbox/{itemId}/dismiss: the whole item out of the Inbox. */
export function dismiss(db: Db, me: string, id: string, now = new Date()): void {
  if (id === UNVERIFIED_ID) {
    // Every unverified mail until now; newer ones bring the item back.
    const v = { decision: 'dismissed' as const, personId: me, bookId: null, decidedAt: now.toISOString() };
    db.insert(t.inboxDecision).values({ item: id, idx: -1, ...v }).onConflictDoUpdate({ target: [t.inboxDecision.item, t.inboxDecision.idx], set: v }).run();
    return;
  }
  const it = resolve(db, me, id);
  if (it.kind === 'mail' && waitsForAnswer(it.row)) throw new InboxError(409, 'answer it: the same invoice as the one typed, or another purchase');
  db.insert(t.inboxDecision).values({ item: id, idx: -1, decision: 'dismissed', personId: me, bookId: null, decidedAt: now.toISOString() }).onConflictDoNothing().run();
}

/** A verified invoice held because it may be one typed in already (mail/effects.ts maybeTyped), not answered yet. */
const waitsForAnswer = (r: MailRow) => r.accepted === 1 && r.kind === 'invoice' && typeof json(r.parsedJson).maybeTyped === 'string';

/** "2026-11-16T10:00:00.000Z" → "16 November 2026" (its UTC day). */
export const longDay = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/**
 * A mailed invoice that may be the one typed in on that day (philobiblos#45): its books and the typed entry, for a
 * person to answer (answerTyped). It has changed nothing yet.
 */
function maybeTypedItem(db: Db, r: MailRow, p: Record<string, unknown>, entryId: string, mail: { date: string | null; number: string | null }): InboxItem {
  const e = db.select().from(t.orderEntry).where(eq(t.orderEntry.id, entryId)).get();
  const by = e?.personId ? getPerson(db, e.personId) : null;
  const lines = Array.isArray(p.lines) ? (p.lines as Line[]) : [];
  // What of each is left to ask about: a mail answered the same as another typed one already (philobiblos#64) shows
  // only the books that one does not count, and the typed one only what no other mail counts.
  const mine = mailLeft(db as unknown as Tx, r) ?? [];
  const left = e ? entryWaitLeft(db as unknown as Tx, e, r.messageId) : [];
  const o = e ? overlap(left, mine) : null;
  // The copies the same would add: a line it cannot place waits in the Inbox after the answer, and is not one of them.
  const more = o?.rest.reduce((n, l) => n + (l.bookId ? l.qty : 0), 0) ?? 0;
  const found = mine.flatMap((m): Found[] => {
    const l = lines[m.index];
    return l && typeof l === 'object' ? [{ index: m.index, title: str(l.title), author: str(l.author, 200), ean: str(l.ean, 13), decided: null, qty: m.qty, priceC: m.totalC }] : [];
  });
  return {
    id: mailItemId(r.messageId), kind: 'maybe_typed_invoice', createdAt: r.seenAt, mail, found,
    title: e ? `Maybe the invoice typed on ${longDay(e.createdAt)}` : 'Maybe an invoice typed in already',
    ...(e ? { typed: { entryId: e.id, createdAt: e.createdAt, number: e.number, shop: e.shop || null, totalC: left.reduce((n, l) => n + l.totalC, 0), ...(by ? { by: view(db, by) } : {}), ...(more ? { more } : {}), ...(o?.holds === 'part' ? { part: true as const } : {}) } } : {}),
  };
}

/**
 * Where an answer to a held mail is kept (inbox_decision.idx): who answered, and how. Not -1, the whole item dismissed:
 * a line of the mail Philobiblos could not place still waits for a person after it (philobiblos#64), as any such line.
 */
const ANSWERED = -2;

/**
 * POST /inbox/{itemId}/typed: the answer to a mailed invoice that may be one typed in (philobiblos#45), by any adult
 * (the bookshop's mail is the household's). `same`: the mail counts as the typed one (duplicateOf the entry, as a typed
 * invoice of the connector's number makes it) and nothing else changes but the copies it holds beyond the typed ones
 * (philobiblos#64), which have a mail's effect (a line it could not place stays for the Inbox, as any); `another`: another purchase, so the mail's
 * effect now, as when it was read (its copies owned at the price paid, the price learnt, its order lines delivered
 * and invoiced). Once: the item is gone, and a second answer is 409.
 */
export function answerTyped(db: Db, me: string, id: string, body: unknown, now = new Date()): InboxItem {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InboxError(400, 'a JSON object is needed');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'answer') throw new InboxError(400, `unknown field ${k.slice(0, 40)}`);
  if (b.answer !== 'same' && b.answer !== 'another') throw new InboxError(400, 'answer: same or another');
  const it = resolve(db, me, id);
  if (it.kind !== 'mail') throw new InboxError(409, 'this item asks nothing about a typed invoice');
  const iso = now.toISOString();
  db.transaction((tx) => {
    const row = tx.select().from(t.mailSeen).where(eq(t.mailSeen.messageId, it.row.messageId)).get()!;
    if (!waitsForAnswer(row)) throw new InboxError(409, 'this item asks nothing about a typed invoice, or it is answered already');
    const p = json(row.parsedJson);
    const entry = p.maybeTyped as string;
    // What of the mail no typed entry counts as yet: all of it, unless it was answered the same as one already (below).
    const mine = mailLeft(tx, row) ?? [];
    let count: Part[] = mine;
    delete p.maybeTyped;
    if (b.answer === 'same') {
      // Only what it holds beyond the typed one counts; with nothing beyond it (the same, or part of it), nothing. The
      // copies they share are kept, so the rest may be asked about as another entry, never counted twice.
      const e = tx.select().from(t.orderEntry).where(eq(t.orderEntry.id, entry)).get();
      const o = e ? overlap(entryWaitLeft(tx, e, row.messageId), mine) : null;
      // With copies of the mail left that the typed one no longer fits, the same would count them twice, or drop them.
      if (!o && mine.some((l) => l.bookId)) throw new InboxError(409, 'the typed invoice no longer fits this mail: answer another purchase, or check the typed one');
      if (typeof p.duplicateOf !== 'string') p.duplicateOf = `entry:${entry}`;
      const shared = p.shared && typeof p.shared === 'object' ? p.shared as Record<string, unknown> : {};
      p.shared = { ...shared, [entry]: [...(Array.isArray(shared[entry]) ? shared[entry] : []), ...(o?.shared ?? [])] };
      count = o?.rest ?? [];
    } else {
      // Another purchase than that one: never asked about it again.
      p.notTyped = [...(Array.isArray(p.notTyped) ? p.notTyped : []), entry];
    }
    // What is left may be another typed invoice (a mail of two purchases typed apart, or one typed while this waited):
    // asked about in its turn, never counted twice. The ones it was answered about are not asked again.
    const asked = [...mailEntries(p), ...(Array.isArray(p.notTyped) ? (p.notTyped as string[]) : [])];
    const next = count.length ? maybeTyped(tx, { connector: String(json(row.authJson).connector ?? ''), number: typeof p.invoiceNumber === 'string' ? p.invoiceNumber : null, key: row.messageId }, count, iso, asked) : null;
    if (next) { p.maybeTyped = next.id; count = []; }
    invoiceLines(tx, count.flatMap((l) => (l.bookId ? [{ bookId: l.bookId, qty: l.qty, totalC: l.totalC }] : [])), { date: str(p.date, 40), day: DAY.test(str(p.day, 24) ?? '') ? str(p.day, 24) : null, readAt: row.seenAt }, iso);
    tx.update(t.mailSeen).set({ parsedJson: JSON.stringify(p) }).where(eq(t.mailSeen.messageId, row.messageId)).run();
    const v = { decision: b.answer === 'same' ? 'skipped' as const : 'added' as const, personId: me, bookId: null, decidedAt: iso };
    tx.insert(t.inboxDecision).values({ item: id, idx: ANSWERED, ...v }).onConflictDoUpdate({ target: [t.inboxDecision.item, t.inboxDecision.idx], set: v }).run();
  }, { behavior: 'immediate' });
  return itemNow(db, me, id);
}
