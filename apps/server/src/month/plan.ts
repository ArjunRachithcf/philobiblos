// This month (spec §4, §5): the month's picks per person, chosen by packages/scoring from the scored backlog, within
// the month's budget; then Compose (order-mail.ts). Until a person changes something the plan is computed on each look;
// the first change keeps it as the month's order (status `picked`), and Compose turns it into `drafted`. Who may
// change what follows the Backlog: your own picks and the kids' (adults act for them), not another adult's.
import { and, eq, inArray, ne } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { components } from '@shelf/contracts/openapi';
import { adultPickCount, pickAdults, pickKids, type Mix } from '@shelf/scoring';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { allCandidates, publicView, type Row } from '../backlog/backlog';
import { BUDGET_CEILING_C, getBudget, type Budget } from '../household/budget';
import { actsFor, getPerson, household, view, type Person } from '../household/people';
import { getLibrary } from '../library/library';
import { personSettings } from '../library/settings';
import { mailto, orderText } from './order-mail';

type S = components['schemas'];
type Line = { bookId: string; forPerson: string; move: string | null; estimateC: number | null };

export class MonthError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export function currentMonth(timezone: string, now = new Date()): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(now);
  return `${p.find((x) => x.type === 'year')!.value}-${p.find((x) => x.type === 'month')!.value}`;
}
function checkMonth(month: string) { if (!MONTH.test(month)) throw new MonthError(400, 'month: YYYY-MM'); }
export function nextMonth(month: string): string {
  const n = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)); // the next month's index, 1-based month
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;
}
/**
 * Plans are made for this month and the next (the household's time zone, SHELF_TZ): any other month is 404 for changes,
 * and shows only when it has an order.
 */
export function checkWindow(db: Db, month: string, timezone: string, change: boolean, now = new Date()): void {
  checkMonth(month);
  const cur = currentMonth(timezone, now);
  if (month === cur || month === nextMonth(cur)) return;
  if (!change && orderOf(db, month)) return;
  throw new MonthError(404, change ? 'plans are changed for this month and the next only' : 'no plan for that month');
}
/** Deepen + Connect: every third month one pick becomes Broaden (spec §5). */
export const broadenMonth = (month: string) => (Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1) % 3 === 2;

export function monthBudget(db: Db, month: string): { budget: Budget; isOverride: boolean } {
  const o = db.select().from(t.monthOverride).where(eq(t.monthOverride.month, month)).get();
  const base = getBudget(db);
  if (!o || (o.budgetMinC == null && o.budgetMaxC == null)) return { budget: base, isOverride: false };
  return { budget: { min: o.budgetMinC ?? base.min, max: o.budgetMaxC ?? base.max }, isOverride: true };
}

const adults = (db: Db) => household(db).filter((p) => p.role !== 'kid');
const kids = (db: Db) => household(db).filter((p) => p.role === 'kid');
const orderOf = (db: Db, month: string) => db.select().from(t.order).where(eq(t.order.month, month)).get();
const lineOf = (r: Row): Line => ({ bookId: r.book.id, forPerson: r.personId, move: r.move ?? null, estimateC: r.price ?? null });

/** Rows that may be picked: open, and not already in another month's composed order. */
function pickable(db: Db, month: string, viewer: string): Row[] {
  const ordered = new Set(db.select({ b: t.orderLine.bookId, p: t.orderLine.forPerson }).from(t.orderLine).innerJoin(t.order, eq(t.order.id, t.orderLine.orderId))
    .where(and(ne(t.order.month, month), ne(t.order.status, 'picked'), ne(t.orderLine.state, 'rolled_over'))).all().map((r) => `${r.p}.${r.b}`));
  return allCandidates(db, new Date(), viewer).filter((r) => r.state === 'open' && !ordered.has(r.id));
}

/**
 * Spec §5 steps 2–4. `keep`: lines that stay as they are; `pickFor`: the adults whose picks are made (default: all).
 * The kids' picks are always made again, within the budget left.
 */
function compute(db: Db, month: string, viewer: string, o: { keep?: Line[]; pickFor?: string[] } = {}): Line[] {
  const rows = pickable(db, month, viewer);
  const hh = db.select().from(t.householdSettings).where(eq(t.householdSettings.id, 1)).get();
  const { budget } = monthBudget(db, month);
  const out: Line[] = [...(o.keep ?? [])];
  const taken = new Set(out.map((l) => l.bookId));
  for (const p of adults(db).filter((a) => !o.pickFor || o.pickFor.includes(a.id))) {
    const s = personSettings(p);
    const pile = getLibrary(db, p.id, p.id).stats?.unreadPile ?? 0;
    const count = adultPickCount(pile, s.unreadLimit, hh?.adultPicks ?? 2);
    const mine = rows.filter((r) => r.personId === p.id && !taken.has(r.book.id));
    const ids = pickAdults(mine.map((r) => ({ id: r.id, score: r.score ?? null, move: r.move ?? null, excluded: r.score == null, isFiction: r.isFiction })),
      { count, mix: s.mix as Mix, broadenMonth: broadenMonth(month), allowFiction: s.fiction });
    for (const id of ids) { const l = lineOf(mine.find((r) => r.id === id)!); out.push(l); taken.add(l.bookId); }
  }
  const ownedAuthors = new Set(db.selectDistinct({ a: t.book.authorsJson }).from(t.copy).innerJoin(t.book, eq(t.book.id, t.copy.bookId)).all()
    .map((r) => (JSON.parse(r.a) as string[])[0]?.toLowerCase()).filter(Boolean));
  const kidRows = rows.filter((r) => r.role === 'kid' && r.price != null && r.score != null && !taken.has(r.book.id));
  const total = out.reduce((n, l) => n + (l.estimateC ?? 0), 0);
  const { ids } = pickKids(kidRows.map((r) => ({
    id: r.id, kidId: r.personId, score: r.score!, theme: r.themes[0] ?? `none:${r.book.id}`, author: r.authors[0] ?? `none:${r.book.id}`,
    priceC: r.price!, authorOnShelf: Boolean(r.authors[0]) && ownedAuthors.has(r.authors[0]!),
  })), { kids: kids(db).map((k) => k.id), totalC: total, minC: budget.min, maxC: budget.max, skipShelfAuthors: (hh?.newAuthorsOnly ?? 1) === 1 });
  out.push(...ids.map((id) => lineOf(kidRows.find((r) => r.id === id)!)));
  return out;
}

/** The month's order with its lines; made from the computed plan the first time something changes. */
function keep(db: Db, month: string, viewer: string) {
  const existing = orderOf(db, month);
  if (existing) return existing;
  const row = { id: ulid(), month, status: 'picked' as const, createdAt: new Date().toISOString() };
  const lines = compute(db, month, viewer);
  db.transaction((tx) => {
    tx.insert(t.order).values(row).run();
    if (lines.length) tx.insert(t.orderLine).values(lines.map((l) => ({ ...l, orderId: row.id }))).run();
  });
  return orderOf(db, month)!;
}

function editable(o: typeof t.order.$inferSelect) {
  if (o.status !== 'picked' && o.status !== 'drafted') throw new MonthError(409, 'the bookshop has this order already; changes come with its reply');
}

function mayChange(db: Db, me: string, personId: string) {
  const may = actsFor(db, me, personId);
  if (may === 'none') throw new MonthError(404, 'no such person');
  if (may === 'other') throw new MonthError(403, 'only they change their own picks');
}

const why = (r: Row): string => {
  const on = r.buildsOn?.[0]?.book?.title;
  if (r.role === 'kid') return r.theme ? `A book about ${r.theme.toLowerCase()}` : 'From the kids’ list';
  const idea = r.ideas?.[0]?.name;
  switch (r.move) {
    case 'connect': return on ? `Connects ${idea ?? 'two ideas'} with what ${on} started` : `Connects ${idea ?? 'two ideas'}`;
    case 'deepen': return `Goes deeper into ${idea ?? 'an idea you have read about'}`;
    case 'counterpoint': return `The strongest critique of ${idea ?? 'an idea you know'}`;
    case 'broaden': return `Starts a new idea: ${idea ?? 'something new'}`;
    case 'wildcard': return 'A wildcard: an island of its own, for now';
    default: return on ? `Builds on ${on}` : idea ? `An introduction to ${idea}` : 'From your backlog';
  }
};

const MOVE_VERB: Record<string, string> = { deepen: 'Deepen', connect: 'Connect', broaden: 'Start', counterpoint: 'Question', wildcard: 'Wander into', intro: 'Begin', fiction: 'Enjoy' };

export function getMonth(db: Db, month: string, viewer: string): S['MonthPlan'] {
  checkMonth(month);
  const o = orderOf(db, month);
  const lines: Line[] = o ? db.select().from(t.orderLine).where(eq(t.orderLine.orderId, o.id)).all() : compute(db, month, viewer);
  const rows = new Map(allCandidates(db, new Date(), viewer).map((r) => [`${r.personId}.${r.book.id}`, r]));
  const picks = (p: Person) => lines.filter((l) => l.forPerson === p.id).flatMap((l) => {
    const r = rows.get(`${l.forPerson}.${l.bookId}`);
    if (!r) return [];
    return [{ candidate: publicView(r), ...(l.move ? { move: l.move as S['Move'] } : {}), why: why(r), idea: p.role === 'kid' ? r.theme ?? undefined : r.ideas?.[0]?.name }];
  });
  const { budget, isOverride } = monthBudget(db, month);
  const mine = lines.filter((l) => l.forPerson === viewer).map((l) => rows.get(`${l.forPerson}.${l.bookId}`)).filter((r): r is Row => Boolean(r));
  return {
    month, budget, budgetIsOverride: isOverride,
    total: lines.reduce((n, l) => n + (l.estimateC ?? 0), 0),
    adults: adults(db).map((p) => {
      const stats = getLibrary(db, p.id, p.id).stats ?? {};
      return { person: view(db, p), picks: picks(p), unreadPile: stats.unreadPile ?? 0, unreadLimit: stats.unreadLimit ?? 0 };
    }),
    kids: kids(db).map((p) => ({ person: view(db, p), picks: picks(p) })),
    // Where the viewer's brain grows this month: their picks and the ideas they add to.
    focus: mine.map((r) => {
      const ideas = [...new Set((r.ideas ?? []).map((i) => i.name!))].slice(0, 3);
      const verb = MOVE_VERB[r.move ?? 'intro'] ?? 'Read';
      return { ...(r.move ? { move: r.move } : {}), ideas, bookId: r.book.id, sentence: ideas.length ? `${verb} ${ideas.slice(0, 2).join(' and ')} with ${r.book.title}.` : `${r.book.title}: ${why(r).charAt(0).toLowerCase()}${why(r).slice(1)}.` };
    }),
    nextBroaden: null,
    order: o ? orderView(db, o) : null,
  };
}

function orderView(db: Db, o: typeof t.order.$inferSelect): S['Order'] {
  const lines = db.select().from(t.orderLine).where(eq(t.orderLine.orderId, o.id)).all();
  const books = new Map(lines.length ? db.select().from(t.book).where(inArray(t.book.id, lines.map((l) => l.bookId))).all().map((b) => [b.id, b]) : []);
  return {
    id: o.id, month: o.month, status: o.status,
    ...(o.estimateC != null ? { estimate: o.estimateC } : {}), ...(o.quotedC != null ? { quoted: o.quotedC } : {}), ...(o.invoicedC != null ? { invoiced: o.invoicedC } : {}),
    lines: lines.map((l) => {
      const b = books.get(l.bookId)!;
      return { book: { id: b.id, title: b.title, authors: JSON.parse(b.authorsJson) as string[] }, for: l.forPerson, ...(l.estimateC != null ? { estimate: l.estimateC } : {}), state: l.state };
    }),
  };
}

export function getOrder(db: Db, id: string): S['Order'] {
  const o = db.select().from(t.order).where(eq(t.order.id, id)).get();
  if (!o) throw new MonthError(404, 'no such order');
  return orderView(db, o);
}

const refs = (v: unknown, name: string): { bookId: string; for: string }[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 50 || !v.every((x) => x && typeof x === 'object' && typeof x.bookId === 'string' && typeof x.for === 'string')) {
    throw new MonthError(400, `${name}: up to 50 { bookId, for }`);
  }
  return v as { bookId: string; for: string }[];
};

/** POST /month/{month}/picks: add, remove, or start again from the scoring (recompute). */
export function changePicks(db: Db, month: string, me: string, body: unknown): S['MonthPlan'] {
  checkMonth(month);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MonthError(400, 'a JSON object is needed');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!['add', 'remove', 'recompute'].includes(k)) throw new MonthError(400, `unknown field ${k}`);
  if (b.recompute !== undefined && typeof b.recompute !== 'boolean') throw new MonthError(400, 'recompute: true or false');
  const add = refs(b.add, 'add'), remove = refs(b.remove, 'remove');
  if (!add.length && !remove.length && !b.recompute) throw new MonthError(400, 'add, remove or recompute');
  for (const r of [...add, ...remove]) mayChange(db, me, r.for);
  const rows = new Map(pickable(db, month, me).map((r) => [r.id, r]));
  const adding = add.map((r) => {
    const row = rows.get(`${r.for}.${r.bookId}`);
    if (!row) throw new MonthError(404, 'no open candidate for that person and book');
    return lineOf(row);
  });
  const o = keep(db, month, me);
  editable(o);
  // Pick again: your own picks and the kids'; another adult's stay as they are (theirs to change).
  const kidIds = new Set(kids(db).map((k) => k.id));
  const others = () => db.select().from(t.orderLine).where(eq(t.orderLine.orderId, o.id)).all()
    .filter((l) => l.forPerson !== me && !kidIds.has(l.forPerson)).map(({ bookId, forPerson, move, estimateC }) => ({ bookId, forPerson, move, estimateC }));
  const fresh = b.recompute ? compute(db, month, me, { keep: others(), pickFor: [me] }) : null;
  db.transaction((tx) => {
    if (fresh) {
      tx.delete(t.orderLine).where(eq(t.orderLine.orderId, o.id)).run();
      if (fresh.length) tx.insert(t.orderLine).values(fresh.map((l) => ({ ...l, orderId: o.id }))).run();
    }
    for (const r of remove) tx.delete(t.orderLine).where(and(eq(t.orderLine.orderId, o.id), eq(t.orderLine.bookId, r.bookId), eq(t.orderLine.forPerson, r.for))).run();
    if (adding.length) tx.insert(t.orderLine).values(adding.map((l) => ({ ...l, orderId: o.id }))).onConflictDoNothing().run();
    tx.update(t.order).set({ status: 'picked' }).where(eq(t.order.id, o.id)).run(); // changed after Compose: compose again
  });
  return getMonth(db, month, me);
}

/** PUT /month/{month}/budget (admins): this month only, or null to go back to the household's; the kids' picks refill. */
export function setMonthBudget(db: Db, month: string, me: string, body: unknown): S['MonthPlan'] {
  checkMonth(month);
  if (body !== null) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MonthError(400, 'budget: { min, max } in centimes, or null');
    const b = body as Record<string, unknown>;
    for (const k of Object.keys(b)) if (k !== 'min' && k !== 'max') throw new MonthError(400, `budget: unknown field ${k}`);
    for (const k of ['min', 'max'] as const) {
      if (!Number.isInteger(b[k]) || (b[k] as number) < 0 || (b[k] as number) > BUDGET_CEILING_C) throw new MonthError(400, `budget.${k}: whole centimes from 0 to ${BUDGET_CEILING_C}`);
    }
    if ((b.min as number) > (b.max as number)) throw new MonthError(400, 'budget: the minimum is above the maximum');
  }
  const o = keep(db, month, me);
  editable(o);
  const b = body as { min: number; max: number } | null;
  db.transaction((tx) => {
    if (b) tx.insert(t.monthOverride).values({ month, budgetMinC: b.min, budgetMaxC: b.max }).onConflictDoUpdate({ target: t.monthOverride.month, set: { budgetMinC: b.min, budgetMaxC: b.max } }).run();
    else tx.delete(t.monthOverride).where(eq(t.monthOverride.month, month)).run();
  });
  // The adults' picks stay as they are; the kids' are made again within the new range.
  const kidIds = new Set(kids(db).map((k) => k.id));
  const kept = db.select().from(t.orderLine).where(eq(t.orderLine.orderId, o.id)).all().filter((l) => !kidIds.has(l.forPerson));
  const lines = compute(db, month, me, { keep: kept.map(({ bookId, forPerson, move, estimateC }) => ({ bookId, forPerson, move, estimateC })), pickFor: [] });
  db.transaction((tx) => {
    tx.delete(t.orderLine).where(eq(t.orderLine.orderId, o.id)).run();
    if (lines.length) tx.insert(t.orderLine).values(lines.map((l) => ({ ...l, orderId: o.id }))).run();
    tx.update(t.order).set({ status: 'picked' }).where(eq(t.order.id, o.id)).run();
  });
  return getMonth(db, month, me);
}

export interface OrderPlaces { bookshopEmail: string | null; deliveryAddress: string | null }

/** POST /orders: the month's picks as an order, and its Compose link (never sent by Shelf). */
export function composeOrder(db: Db, month: string, me: string, places: OrderPlaces): S['Order'] {
  checkMonth(month);
  if (!places.bookshopEmail) throw new MonthError(409, 'an admin adds the bookshop’s address in Settings first');
  const o = keep(db, month, me);
  editable(o);
  const lines = db.select().from(t.orderLine).where(eq(t.orderLine.orderId, o.id)).all();
  if (!lines.length) throw new MonthError(409, 'nothing is picked this month');
  const books = new Map(db.select().from(t.book).where(inArray(t.book.id, lines.map((l) => l.bookId))).all().map((b) => [b.id, b]));
  const { subject, body } = orderText({
    month, deliveryAddress: places.deliveryAddress, signedBy: getPerson(db, me)!.name,
    lines: lines.map((l) => { const b = books.get(l.bookId)!; return { title: b.title, authors: JSON.parse(b.authorsJson) as string[], isbn13: b.isbn13 }; }),
  });
  const link = mailto(places.bookshopEmail, subject, body);
  const estimate = lines.reduce((n, l) => n + (l.estimateC ?? 0), 0);
  db.update(t.order).set({ status: 'drafted', estimateC: estimate }).where(eq(t.order.id, o.id)).run();
  return { ...orderView(db, orderOf(db, month)!), composeUrl: link.url, composeComplete: link.complete, composeTo: places.bookshopEmail, composeSubject: subject, composeText: body };
}
