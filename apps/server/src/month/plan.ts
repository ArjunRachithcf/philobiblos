// This month (spec §4, §5): the month's picks per person, chosen by packages/scoring from the scored backlog, within
// the month's budget; then Compose (order-mail.ts). Until a person changes something the plan is computed on each look;
// the first change keeps it as the month's order (status `picked`), and Compose turns it into `drafted`. Who may
// change what follows the Backlog: your own picks and the kids' (adults act for them), not another adult's.
import { and, eq, inArray, ne } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { components } from '@philobiblos/contracts/openapi';
import { adultPickCount, pickAdults, pickKids, type Mix } from '@philobiblos/scoring';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { allCandidates, publicView, type Row } from '../backlog/backlog';
import { getBudget, type Budget } from '../household/budget';
import { amountProblem, getMoney } from '../household/money';
import { actsFor, getPerson, household, view, type Person } from '../household/people';
import { getLibrary } from '../library/library';
import { personSettings } from '../library/settings';
import { householdZone } from '../jobs/schedule';
import { listCsv, listText } from '../orders/list';
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
/** "This month": the household's (its zone, Settings), the one source for the page, add_to_month, the plan and the AI. */
export const thisMonth = (db: Db, now = new Date()): string => currentMonth(householdZone(db), now);
function checkMonth(month: string) { if (!MONTH.test(month)) throw new MonthError(400, 'month: YYYY-MM'); }
export function nextMonth(month: string): string {
  const n = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)); // the next month's index, 1-based month
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;
}
/**
 * Plans are made for this month and the next (the household's time zone): any other month is 404 for changes, and shows
 * only when it has an order.
 */
export function checkWindow(db: Db, month: string, change: boolean, now = new Date()): void {
  checkMonth(month);
  const cur = thisMonth(db, now);
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
// A price nobody knows counts as the household's unknown price for the budget (ADR 0008, Settings); the screen still
// says it is unknown.
const lineOf = (unknownC: number) => (r: Row): Line => ({ bookId: r.book.id, forPerson: r.personId, move: r.move ?? null, estimateC: r.price ?? unknownC });

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
  const unknownC = getMoney(db).unknownPrice;
  const line = lineOf(unknownC);
  const out: Line[] = [...(o.keep ?? [])];
  const taken = new Set(out.map((l) => l.bookId));
  for (const p of adults(db).filter((a) => !o.pickFor || o.pickFor.includes(a.id))) {
    const s = personSettings(p);
    const pile = getLibrary(db, p.id, p.id).stats?.unreadPile ?? 0;
    const count = adultPickCount(pile, s.unreadLimit, hh?.adultPicks ?? 2);
    const mine = rows.filter((r) => r.personId === p.id && !taken.has(r.book.id));
    const ids = pickAdults(mine.map((r) => ({ id: r.id, score: r.score ?? null, move: r.move ?? null, excluded: r.score == null, isFiction: r.isFiction })),
      { count, mix: s.mix as Mix, broadenMonth: broadenMonth(month), allowFiction: s.fiction });
    for (const id of ids) { const l = line(mine.find((r) => r.id === id)!); out.push(l); taken.add(l.bookId); }
  }
  const ownedAuthors = new Set(db.selectDistinct({ a: t.book.authorsJson }).from(t.copy).innerJoin(t.book, eq(t.book.id, t.copy.bookId)).all()
    .map((r) => (JSON.parse(r.a) as string[])[0]?.toLowerCase()).filter(Boolean));
  const kidRows = rows.filter((r) => r.role === 'kid' && r.score != null && !taken.has(r.book.id));
  const total = out.reduce((n, l) => n + (l.estimateC ?? 0), 0);
  const { ids } = pickKids(kidRows.map((r) => ({
    id: r.id, kidId: r.personId, score: r.score!, theme: r.themes[0] ?? `none:${r.book.id}`, author: r.authors[0] ?? `none:${r.book.id}`,
    priceC: r.price ?? unknownC, authorOnShelf: Boolean(r.authors[0]) && ownedAuthors.has(r.authors[0]!),
  })), { kids: kids(db).map((k) => k.id), totalC: total, minC: budget.min, maxC: budget.max, skipShelfAuthors: (hh?.newAuthorsOnly ?? 1) === 1 });
  out.push(...ids.map((id) => line(kidRows.find((r) => r.id === id)!)));
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

/**
 * The monthly refresh's plan (spec §5 steps 2–4): the month's picks kept as its order, made with no one's view (a reason
 * private to someone is never read for it; the lines hold books and moves only). A plan kept already stays as it is.
 */
export function keepPlan(db: Db, month: string): { kept: boolean; lines: number } {
  checkMonth(month);
  const had = orderOf(db, month);
  const o = keep(db, month, '');
  return { kept: !had, lines: db.select({ b: t.orderLine.bookId }).from(t.orderLine).where(eq(t.orderLine.orderId, o.id)).all().length };
}

function editable(db: Db, o: typeof t.order.$inferSelect) {
  if (o.status !== 'picked' && o.status !== 'drafted') throw new MonthError(409, 'the bookshop has this order already; changes come with its reply');
  // A book bought from the list (a tap) is in the library: picking again would drop its line and the tap's undo.
  const bought = db.select({ b: t.orderLine.bookId }).from(t.orderLine).where(and(eq(t.orderLine.orderId, o.id), eq(t.orderLine.state, 'delivered'))).get();
  if (bought) throw new MonthError(409, 'a book of this order is in the library already; undo “Owned” first to change the picks');
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
    // A kept line's why is the AI's one line when it wrote one (explainPick, ai/jobs.ts), else Philobiblos's own words. One
    // built on something private to the pick's person (why_audience) is theirs to read; everyone else gets Philobiblos's.
    const mayRead = !('whyAudience' in l) || !l.whyAudience || l.whyAudience === viewer;
    const said = 'why' in l && typeof l.why === 'string' && l.why && mayRead ? l.why : null;
    return [{ candidate: publicView(r), ...(l.move ? { move: l.move as S['Move'] } : {}), why: said ?? why(r), idea: p.role === 'kid' ? r.theme ?? undefined : r.ideas?.[0]?.name }];
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
      return {
        book: { id: b.id, title: b.title, authors: JSON.parse(b.authorsJson) as string[], ...(b.isbn13 ? { isbn13: b.isbn13 } : {}) }, for: l.forPerson,
        ...(l.estimateC != null ? { estimate: l.estimateC } : {}), ...(l.quotedC != null ? { quoted: l.quotedC } : {}), state: l.state, ownedByTap: l.state === 'delivered' && l.copyId != null,
      };
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
  const lineFor = lineOf(getMoney(db).unknownPrice);
  const adding = add.map((r) => {
    const row = rows.get(`${r.for}.${r.bookId}`);
    if (!row) throw new MonthError(404, 'no open candidate for that person and book');
    return lineFor(row);
  });
  const o = keep(db, month, me);
  editable(db, o);
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MonthError(400, 'budget: { min, max } in hundredths of the household currency, or null');
    const b = body as Record<string, unknown>;
    for (const k of Object.keys(b)) if (k !== 'min' && k !== 'max') throw new MonthError(400, `budget: unknown field ${k}`);
    const { currency } = getMoney(db);
    for (const k of ['min', 'max'] as const) {
      const problem = amountProblem(b[k], currency);
      if (problem) throw new MonthError(400, `budget.${k}: ${problem}`);
    }
    if ((b.min as number) > (b.max as number)) throw new MonthError(400, 'budget: the minimum is above the maximum');
  }
  const o = keep(db, month, me);
  editable(db, o);
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

/**
 * POST /orders: the month's picks as an order, and its Compose link (never sent by Philobiblos). `places: 'list'` is
 * no-shop mode (philobiblos#27 slice 5): the plain list for any shop or none, its mail text to no one and without the
 * delivery address (orders/list.ts), so it needs no address and opens nothing sealed.
 */
export function composeOrder(db: Db, month: string, me: string, places: OrderPlaces | 'list'): S['Order'] {
  checkMonth(month);
  const list = places === 'list';
  if (!list && !places.bookshopEmail) throw new MonthError(409, 'an admin adds the bookshop’s address in Settings first, or make a plain list');
  // A composed order's list is read again (after a reload, or once books are bought): its books still to buy, and
  // nothing changes, so it never needs the picks to be editable.
  const had = orderOf(db, month);
  if (list && had && had.status !== 'picked') return listOf(db, had);
  const o = keep(db, month, me);
  editable(db, o);
  const lines = db.select().from(t.orderLine).where(eq(t.orderLine.orderId, o.id)).all();
  if (!lines.length) throw new MonthError(409, 'nothing is picked this month');
  const estimate = lines.reduce((n, l) => n + (l.estimateC ?? 0), 0);
  db.update(t.order).set({ status: 'drafted', estimateC: estimate }).where(eq(t.order.id, o.id)).run();
  if (list) return listOf(db, orderOf(db, month)!);
  const { subject, body } = orderText({ month, signedBy: getPerson(db, me)!.name, deliveryAddress: places.deliveryAddress, lines: lineTexts(db, lines) });
  const link = mailto(places.bookshopEmail!, subject, body);
  return { ...orderView(db, orderOf(db, month)!), composeUrl: link.url, composeComplete: link.complete, composeTo: places.bookshopEmail!, composeSubject: subject, composeText: body };
}

type LineRow = typeof t.orderLine.$inferSelect;
const lineTexts = (db: Db, lines: LineRow[]) => {
  const books = new Map(lines.length ? db.select().from(t.book).where(inArray(t.book.id, lines.map((l) => l.bookId))).all().map((b) => [b.id, b]) : []);
  return lines.map((l) => { const b = books.get(l.bookId)!; return { title: b.title, authors: JSON.parse(b.authorsJson) as string[], isbn13: b.isbn13 }; });
};
/** The books of an order still to buy: its planned and quoted lines. */
const toBuy = (db: Db, orderId: string) => db.select().from(t.orderLine).where(and(eq(t.orderLine.orderId, orderId), inArray(t.orderLine.state, ['planned', 'quoted']))).all();

/** A composed order as its plain list: the mail text of the books still to buy, to no one, unsigned, no address. */
function listOf(db: Db, o: typeof t.order.$inferSelect): S['Order'] {
  const { subject, body } = listText({ month: o.month, lines: lineTexts(db, toBuy(db, o.id)) });
  const link = mailto(null, subject, body);
  return { ...orderView(db, o), listUrl: link.url, listComplete: link.complete, listSubject: subject, listText: body };
}

/** GET /orders/{id}/list.csv: the books still to buy (planned or quoted), once the list or the mail is made. */
export function orderListCsv(db: Db, id: string): { month: string; csv: string } {
  const o = db.select().from(t.order).where(eq(t.order.id, id)).get();
  if (!o) throw new MonthError(404, 'no such order');
  if (o.status === 'picked') throw new MonthError(409, 'make the list first: the picks may still change');
  const lines = toBuy(db, o.id);
  const books = new Map(lines.length ? db.select().from(t.book).where(inArray(t.book.id, lines.map((l) => l.bookId))).all().map((b) => [b.id, b]) : []);
  return {
    month: o.month,
    csv: listCsv(lines.map((l) => {
      const b = books.get(l.bookId)!;
      return { title: b.title, authors: JSON.parse(b.authorsJson) as string[], isbn13: b.isbn13, estimateC: l.quotedC ?? l.estimateC };
    })),
  };
}

/**
 * PUT /orders/{id}/lines/{bookId}: a book of a composed order bought with no invoice to record, marked owned by a tap
 * (`owned: true`): one copy (manual, of this order, priced as the shop quoted it or not at all; nothing learnt), the line
 * delivered. Only a planned or quoted line, so a second tap changes nothing (409). `owned: false` undoes a tap while its
 * copy is the tap's: the copy removed, the line as it was. A line an invoice delivered is never undone here.
 */
export function markOwned(db: Db, id: string, bookId: string, body: unknown, now = new Date()): S['Order'] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MonthError(400, 'a JSON object is needed: { owned }');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'owned') throw new MonthError(400, `unknown field ${k.slice(0, 40)}`);
  if (typeof b.owned !== 'boolean') throw new MonthError(400, 'owned: true or false');
  const owned = b.owned;
  db.transaction((tx) => {
    const o = tx.select().from(t.order).where(eq(t.order.id, id)).get();
    if (!o) throw new MonthError(404, 'no such order');
    const l = tx.select().from(t.orderLine).where(and(eq(t.orderLine.orderId, id), eq(t.orderLine.bookId, bookId))).get();
    if (!l) throw new MonthError(404, 'no such book in this order');
    const at = and(eq(t.orderLine.orderId, id), eq(t.orderLine.bookId, bookId));
    if (owned) {
      if (o.status === 'picked') throw new MonthError(409, 'make the list first: the picks may still change');
      if (l.state !== 'planned' && l.state !== 'quoted') throw new MonthError(409, l.state === 'delivered' ? 'it is in the library already' : 'the shop could not deliver it: it goes to next month');
      const copyId = ulid();
      tx.insert(t.copy).values({ id: copyId, bookId, source: 'manual', orderId: id, priceC: l.state === 'quoted' ? l.quotedC : null, acquiredAt: now.toISOString() }).run();
      tx.update(t.orderLine).set({ state: 'delivered', copyId, tappedFrom: l.state }).where(at).run();
    } else {
      if (l.state !== 'delivered' || !l.copyId) throw new MonthError(409, 'only a book marked owned here can be unmarked; an invoice’s copies stay');
      tx.update(t.orderLine).set({ state: l.tappedFrom === 'quoted' ? 'quoted' : 'planned', copyId: null, tappedFrom: null }).where(at).run();
      tx.delete(t.copy).where(eq(t.copy.id, l.copyId)).run();
    }
  }, { behavior: 'immediate' });
  return getOrder(db, id);
}
