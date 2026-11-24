// The Backlog (spec §4): every candidate of the household, scored by packages/scoring (spec §6; the AI never sets a
// score, ADR 0004), filtered by the query language of contracts/backlog-query.md (parsed by packages/contracts),
// sorted, counted per tab and per facet. The backlog is shared by design (docs/security.md): every adult sees it.
import { eq, inArray } from 'drizzle-orm';
import { parseQuery, type ParsedQuery, type Term } from '@philobiblos/contracts';
import type { components } from '@philobiblos/contracts/openapi';
import { DEFAULT_KID_SETTINGS, householdWeights, scoreAdult, scoreKid, type Layer, type ScorePart } from '@philobiblos/scoring';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { getMoney, ownPriceLimits } from '../household/money';
import { household, view } from '../household/people';
import { visibleReason } from '../knowledge/knowledge';
import { COUNTED, countedTags, fromAi } from '../knowledge/tags';
import { bookRef } from '../library/library';

type S = components['schemas'];
type Candidate = S['Candidate'];
type Closed = NonNullable<Candidate['closedReason']>;
const DAY = 86_400_000;


/** A candidate's id in the API: the person and the book it joins. */
export const candidateId = (personId: string, bookId: string) => `${personId}.${bookId}`;
export function parseCandidateId(id: unknown): { personId: string; bookId: string } | null {
  if (typeof id !== 'string' || id.length > 200) return null;
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(id);
  return m ? { personId: m[1]!, bookId: m[2]! } : null;
}

export interface Row extends Candidate {
  book: S['BookRef']; id: string; personId: string; handle: string | null; role: 'admin' | 'adult' | 'kid'; addedBy: string | null;
  authors: string[]; isFiction: boolean; audience: 'adult' | 'kids'; links: number; score?: number;
  ideaNames: string[]; layers: Layer[]; themes: string[];
}

/** One candidate as the API shows it. */
export function getCandidate(db: Db, id: string, viewer: string, now = new Date()): Candidate | null {
  const r = allCandidates(db, now, viewer).find((c) => c.id === id);
  return r ? publicView(r) : null;
}

/** Every candidate, scored, with what the filters need. `now` is injectable for tests. */
export function allCandidates(db: Db, now = new Date(), viewer = ''): Row[] {
  const people = new Map(household(db).map((p) => [p.id, p]));
  const cands = db.select().from(t.candidate).all();
  const bookIds = [...new Set(cands.map((c) => c.bookId))];
  if (!bookIds.length) return [];
  const books = new Map(db.select().from(t.book).where(inArray(t.book.id, bookIds)).all().map((b) => [b.id, b]));
  // A price nobody knows is scored at the household's unknown price (Settings, household/money.ts), as the plan counts it,
  // and the price limits are the household's own, or follow that price (philobiblos#40): no currency's sizes.
  const money = getMoney(db);
  const { adult: adultWeights, kid: kidWeights } = householdWeights({ unknownPriceC: money.unknownPrice, priceLimits: ownPriceLimits(money) });
  // The cheapest price known; a free one (0: a gift, a promotion) says nothing of what the book costs (philobiblos#53).
  const offers = new Map<string, number>();
  for (const o of db.select().from(t.bookOffer).where(inArray(t.bookOffer.bookId, bookIds)).all()) {
    if (o.priceC != null && o.priceC > 0 && (!offers.has(o.bookId) || o.priceC < offers.get(o.bookId)!)) offers.set(o.bookId, o.priceC);
  }
  const owned = new Set(db.selectDistinct({ id: t.copy.bookId }).from(t.copy).all().map((r) => r.id));
  // A repeat counts once a person confirmed it: the AI's (checkRedundant) are proposals, and close nothing by themselves.
  const repeats = new Set(db.select({ id: t.redundancy.bookId }).from(t.redundancy).where(eq(t.redundancy.state, 'confirmed')).all().map((r) => r.id));
  const sharers = new Map(db.select({ id: t.share.id, personId: t.share.personId }).from(t.share).all().map((s) => [s.id, s.personId]));

  // Ideas with their layer, for candidates and for read books (main idea = the first counted one).
  const tags = countedTags(db);
  const ideasOfBook = new Map<string, typeof tags>();
  for (const r of tags) ideasOfBook.set(r.bookId, [...(ideasOfBook.get(r.bookId) ?? []), r]);
  const themesOfBook = new Map<string, string[]>();
  for (const r of db.select().from(t.bookTheme).orderBy(t.bookTheme.theme).all()) themesOfBook.set(r.bookId, [...(themesOfBook.get(r.bookId) ?? []), r.theme]);
  // A reason from someone's takeaways is theirs (philobiblos#3): everyone else sees a neutral one.
  const linksFrom = new Map<string, { to: string; reason: string; confidence: number; state: string }[]>();
  for (const l of db.select().from(t.bookLink).all()) {
    if (l.state === 'confirmed' || (l.state === 'proposed' && !fromAi(l) && l.confidence >= COUNTED)) linksFrom.set(l.fromBook, [...(linksFrom.get(l.fromBook) ?? []), { to: l.toBook, reason: visibleReason(l, viewer), confidence: l.confidence, state: l.state }]);
  }
  // Each person's readings: what they have read (with when), and kids' feedback.
  const readBy = new Map<string, Map<string, { finished: string; feedback: string | null }>>();
  for (const r of db.select({ personId: t.reading.personId, bookId: t.reading.bookId, status: t.reading.status, feedback: t.reading.feedback, finishedAt: t.reading.finishedAt, updatedAt: t.reading.updatedAt }).from(t.reading).all()) {
    if (r.status !== 'read') continue;
    if (!readBy.has(r.personId)) readBy.set(r.personId, new Map());
    readBy.get(r.personId)!.set(r.bookId, { finished: r.finishedAt ?? r.updatedAt.slice(0, 10), feedback: r.feedback });
  }
  const firstAuthor = (bookId: string) => (JSON.parse(books.get(bookId)?.authorsJson ?? '[]') as string[])[0]?.toLowerCase() ?? '';
  const ownedAuthors = new Set([...owned].map(firstAuthor).filter(Boolean));
  const months = (from: string) => Math.max(0, (now.getTime() - new Date(from).getTime()) / (30 * DAY));
  const allBookRefs = (ids: string[]) => new Map(ids.length ? db.select().from(t.book).where(inArray(t.book.id, ids)).all().map((b) => [b.id, bookRef(b)]) : []);
  const linkedBooks = allBookRefs([...new Set([...linksFrom.values()].flat().map((l) => l.to))]);

  const rows: Row[] = [];
  for (const c of cands) {
    const p = people.get(c.personId);
    const b = books.get(c.bookId);
    if (!p || !b) continue;
    const read = readBy.get(p.id) ?? new Map();
    const ideas = ideasOfBook.get(b.id) ?? [];
    const themes = (themesOfBook.get(b.id) ?? []).slice(0, 2);
    const priceC = offers.get(b.id) ?? null;
    const waitingDays = Math.max(0, (now.getTime() - new Date(c.addedAt).getTime()) / DAY);

    // State: owned and repeats close a candidate whatever its own state; an expired snooze opens it again.
    let closed: Closed | null = null;
    if (owned.has(b.id)) closed = 'owned';
    else if (repeats.has(b.id)) closed = 'repeats';
    else if (c.state === 'snoozed' && !(c.snoozedUntil && c.snoozedUntil <= now.toISOString())) closed = 'snoozed';
    else if (c.state !== 'active' && c.state !== 'snoozed') closed = c.state as Closed;

    const links = (linksFrom.get(b.id) ?? []).filter((l) => read.has(l.to));
    let score: number | undefined;
    let parts: ScorePart[];
    let move: Candidate['move'];
    if (p.role === 'kid') {
      const theme = themes[0];
      const inTheme = [...read].filter(([id, r]) => theme && (themesOfBook.get(id) ?? []).includes(theme) && (r.feedback === 'loved' || r.feedback === 'meh'));
      const author = firstAuthor(b.id);
      const k = scoreKid({
        themeBooks: inTheme.length, themeBooksWeighted: inTheme.reduce((n, [, r]) => n + (r.feedback === 'loved' ? 2 : 1), 0),
        authorOnShelf: Boolean(author) && ownedAuthors.has(author),
        lovedAuthor: Boolean(author) && [...read].some(([id, r]) => id !== b.id && r.feedback === 'loved' && firstAuthor(id) === author),
        toBuy: c.origin === 'to_buy', fromShare: c.origin === 'share', waitingDays, priceC,
      }, DEFAULT_KID_SETTINGS, kidWeights);
      score = Math.round(k.score * 10) / 10;
      parts = k.parts;
    } else {
      const main = ideas[0];
      const readIn = (ideaId: string) => [...read].filter(([id]) => (ideasOfBook.get(id) ?? []).some((x) => x.ideaId === ideaId));
      const mainRead = main ? readIn(main.ideaId) : [];
      const layersRead = new Set(mainRead.flatMap(([id]) => (ideasOfBook.get(id) ?? []).filter((x) => x.ideaId === main!.ideaId).map((x) => x.layer)));
      const touched = new Set(links.flatMap((l) => (ideasOfBook.get(l.to) ?? []).map((x) => x.ideaId)));
      const last = mainRead.map(([, r]) => r.finished).sort().at(-1);
      const a = scoreAdult({
        links: links.length, bridge: Math.max(0, touched.size - 1),
        fillsLayer: main && main.layer !== 'intro' && !layersRead.has(main.layer) ? main.layer : null,
        introAndCoreRead: layersRead.has('intro') && layersRead.has('core'),
        staleMonths: last ? months(last) : 0,
        newIdea: Boolean(main) && mainRead.length === 0,
        toBuy: c.origin === 'to_buy', fromShare: c.origin === 'share', waitingDays,
        untouchedMonths: months(c.touchedAt), priceC,
        ideasDense: [...touched].every((id) => readIn(id).length >= 2),
        isFiction: b.isFiction === 1,
      }, adultWeights);
      if (!a.excluded) { score = Math.round(a.score! * 10) / 10; move = a.move ?? undefined; }
      parts = a.parts;
    }

    rows.push({
      id: candidateId(p.id, b.id), personId: p.id, handle: p.handle, role: p.role,
      addedBy: c.shareId ? sharers.get(c.shareId) ?? null : c.personId,
      book: bookRef(b), for: view(db, p), state: closed ? 'closed' : 'open', closedReason: closed,
      ...(move ? { move } : {}),
      ideas: ideas.map((x) => ({ id: x.ideaId, name: x.name, layer: x.layer })), theme: themes[0] ?? null,
      buildsOn: links.map((l) => ({ book: linkedBooks.get(l.to)!, reason: l.reason, confidence: l.confidence, state: l.state as 'proposed' | 'confirmed' })),
      source: c.origin, addedAt: c.addedAt, ...(priceC != null ? { price: priceC } : {}), priceIsEstimate: priceC != null,
      ...(score != null ? { score } : {}), scoreParts: parts,
      authors: (JSON.parse(b.authorsJson) as string[]).map((x) => x.toLowerCase()), isFiction: b.isFiction === 1, audience: b.audience,
      links: links.length, ideaNames: ideas.map((x) => x.name.toLowerCase()), layers: ideas.map((x) => x.layer), themes: themes.map((x) => x.toLowerCase()),
    });
  }
  return rows;
}

const SOURCE: Record<string, string> = { instagram: 'share', wishlist: 'wishlist', 'to-buy': 'to_buy', ai: 'ai', manual: 'manual' };
const REASON: Record<string, Closed> = { 'not-for-me': 'not_for_me', snoozed: 'snoozed', owned: 'owned', repeats: 'repeats', picked: 'picked' };

function compare(a: number | undefined, cmp: string, b: number): boolean {
  if (a == null) return false;
  switch (cmp) { case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b; default: return a === b; }
}

/** Whether a row matches one term (before negation). */
function matches(r: Row, term: Term, me: string, handles: Map<string, string>, now: Date): boolean {
  const who = (v: string) => (v === 'me' ? me : handles.get(v) ?? `?${v}`);
  switch (term.key) {
    case 'is':
      return term.value === 'open' || term.value === 'closed' ? true // the tab, applied separately
        : term.value === 'adult' ? r.audience === 'adult' : term.value === 'kids' ? r.audience === 'kids' : r.isFiction;
    case 'for': return r.personId === who(term.value);
    case 'by': return r.addedBy === who(term.value);
    case 'move': return r.move === term.value;
    case 'idea': return r.ideaNames.some((n) => n.includes(term.value));
    case 'layer': return r.layers.includes(term.value);
    case 'theme': return r.themes.some((n) => n.includes(term.value));
    case 'source': return term.value === 'manual' ? r.source === 'manual' || r.source === 'seed' : r.source === SOURCE[term.value];
    case 'reason': return r.closedReason === REASON[term.value];
    case 'author': return r.authors.some((a) => a.includes(term.value));
    case 'score': return compare(r.score, term.cmp, term.value);
    case 'price': return compare(r.price == null ? undefined : r.price / 100, term.cmp, term.value);
    case 'links': return compare(r.links, term.cmp, term.value);
    case 'added': return compare((now.getTime() - new Date(r.addedAt!).getTime()) / DAY, term.cmp, term.days);
    case 'text': return r.book.title.toLowerCase().includes(term.value) || r.authors.some((a) => a.includes(term.value));
  }
}

export const LIMIT_MAX = 200;

export function listBacklog(db: Db, me: string, o: { q?: string; cursor?: string; limit?: number; now?: Date }) {
  const now = o.now ?? new Date();
  const parsed: ParsedQuery = parseQuery(o.q ?? 'is:open sort:score');
  const handles = new Map(household(db).filter((p) => p.handle).map((p) => [p.handle!, p.id]));
  const rows = allCandidates(db, now, me).filter((r) => parsed.terms.every((term) => matches(r, term, me, handles, now) !== term.negated));
  const counts = { open: rows.filter((r) => r.state === 'open').length, closed: rows.filter((r) => r.state === 'closed').length };
  const tab = rows.filter((r) => r.state === parsed.state);

  const { field, dir } = parsed.sort;
  const key = (r: Row): number | string | undefined => field === 'title' ? r.book.title.toLowerCase() : field === 'added' ? r.addedAt
    : field === 'price' ? r.price : field === 'links' ? r.links : r.score;
  tab.sort((a, b) => {
    const x = key(a), y = key(b);
    if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1; // unknown last, either way
    const c = x < y ? -1 : x > y ? 1 : 0;
    return (dir === 'asc' ? c : -c) || a.book.title.localeCompare(b.book.title);
  });

  const facets: Record<string, { value: string; count: number }[]> = {};
  const count = (name: string, values: (string | null | undefined)[]) => {
    const m = new Map<string, number>();
    for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
    facets[name] = [...m].map(([value, n]) => ({ value, count: n })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  };
  count('for', tab.map((r) => r.handle));
  count('move', tab.map((r) => r.move));
  count('idea', tab.flatMap((r) => (r.ideas ?? []).map((i) => i.name)));
  count('source', tab.map((r) => Object.entries(SOURCE).find(([, v]) => v === r.source)?.[0] ?? (r.source === 'seed' ? 'manual' : r.source)));

  const limit = Math.min(Math.max(1, o.limit ?? 50), LIMIT_MAX);
  const start = /^\d{1,6}$/.test(o.cursor ?? '') ? Number(o.cursor) : 0;
  const page = tab.slice(start, start + limit);
  return {
    items: page.map(publicView),
    counts, facets,
    nextCursor: start + limit < tab.length ? String(start + limit) : null,
    queryErrors: parsed.errors,
  };
}

/** The API's Candidate: the filter fields stay inside. */
export function publicView(r: Row): Candidate {
  const { personId: _p, handle: _h, role: _r, addedBy: _a, authors: _au, isFiction: _f, audience: _au2, links: _l, ideaNames: _i, layers: _ly, themes: _t, ...c } = r;
  return c;
}

