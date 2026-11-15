// Ideas, layers and links (ADR 0005, spec §6). Proposals (from the AI, or the seed's guesses) stay proposals until a
// person confirms or rejects them; nothing else changes their state, and the reviewer is recorded.
//
// Privacy (shelf#3): a proposal from an AI run whose input held someone's takeaways (ai_run.takeaways_of) is that
// person's: only they see its reason, and only they decide it. Everyone else never sees the reason; such a link still
// counts for scores (a link between two books is the household's), with a neutral reason in its place.
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { components } from '@shelf/contracts/openapi';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { getPerson } from '../household/people';
import { allCandidates } from '../backlog/backlog';
import { bookRef } from '../library/library';

type S = components['schemas'];
type Layer = 'intro' | 'core' | 'deep' | 'counterpoint';
export const LAYERS: Layer[] = ['intro', 'core', 'deep', 'counterpoint'];
export const PRIVATE_REASON = 'Proposed from someone’s own reading';

export class KnowledgeError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}

/** run id → the person whose takeaways its input held (only runs that held any). */
export function privateRuns(db: Db): Map<string, string> {
  return new Map(db.select({ id: t.aiRun.id, of: t.aiRun.takeawaysOf }).from(t.aiRun).all().filter((r) => r.of).map((r) => [r.id, r.of!]));
}

/** A link's reason as this viewer may see it. */
export function visibleReason(link: { reason: string; aiRunId: string | null }, viewer: string, runs: Map<string, string>): string {
  const owner = link.aiRunId ? runs.get(link.aiRunId) : undefined;
  return owner && owner !== viewer ? PRIVATE_REASON : link.reason;
}

function ownerOrThrow(aiRunId: string | null, viewer: string, runs: Map<string, string>): void {
  const owner = aiRunId ? runs.get(aiRunId) : undefined;
  if (owner && owner !== viewer) throw new KnowledgeError(403, 'this proposal came from someone else’s reading: only they decide it');
}

function parseReview(body: unknown, allowLayer: boolean): { state?: 'confirmed' | 'rejected'; layer?: Layer } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new KnowledgeError(400, 'a JSON object is needed');
  const b = body as Record<string, unknown>;
  const out: { state?: 'confirmed' | 'rejected'; layer?: Layer } = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === 'state') {
      if (v !== 'confirmed' && v !== 'rejected') throw new KnowledgeError(400, 'state: confirmed or rejected');
      out.state = v;
    } else if (k === 'layer' && allowLayer) {
      if (!LAYERS.includes(v as Layer)) throw new KnowledgeError(400, 'layer: intro, core, deep or counterpoint');
      out.layer = v as Layer;
    } else throw new KnowledgeError(400, `unknown field ${k}`);
  }
  if (!out.state && !out.layer) throw new KnowledgeError(400, allowLayer ? 'state or layer is needed' : 'state is needed');
  return out;
}

/** PUT /links/{from}/{to}: a person confirms or rejects a link (and may change their mind later). */
export function reviewLink(db: Db, viewer: string, from: string, to: string, body: unknown, now = new Date()) {
  const { state } = parseReview(body, false);
  const link = db.select().from(t.bookLink).where(and(eq(t.bookLink.fromBook, from), eq(t.bookLink.toBook, to))).get();
  if (!link) throw new KnowledgeError(404, 'no such link');
  const runs = privateRuns(db);
  ownerOrThrow(link.aiRunId, viewer, runs);
  db.update(t.bookLink).set({ state: state!, reviewedBy: viewer, reviewedAt: now.toISOString() })
    .where(and(eq(t.bookLink.fromBook, from), eq(t.bookLink.toBook, to))).run();
  return { state: state!, reason: visibleReason(link, viewer, runs) };
}

/** PUT /books/{book}/ideas/{idea}: a person confirms or rejects a book's idea, or puts it in another layer (which confirms it). */
export function reviewBookIdea(db: Db, viewer: string, bookId: string, ideaId: string, body: unknown, now = new Date()) {
  const u = parseReview(body, true);
  const row = db.select().from(t.bookIdea).where(and(eq(t.bookIdea.bookId, bookId), eq(t.bookIdea.ideaId, ideaId))).get();
  if (!row) throw new KnowledgeError(404, 'no such idea on that book');
  ownerOrThrow(row.aiRunId, viewer, privateRuns(db));
  const next = { state: u.state ?? 'confirmed' as const, layer: u.layer ?? row.layer };
  db.update(t.bookIdea).set({ ...next, reviewedBy: viewer, reviewedAt: now.toISOString() })
    .where(and(eq(t.bookIdea.bookId, bookId), eq(t.bookIdea.ideaId, ideaId))).run();
  return next;
}

/** GET /proposals: what is waiting for a person's decision, as this viewer may see it (others' private ones left out). */
export function listProposals(db: Db, viewer: string) {
  const runs = privateRuns(db);
  const mine = (aiRunId: string | null) => !aiRunId || !runs.has(aiRunId) || runs.get(aiRunId) === viewer;
  const links = db.select().from(t.bookLink).where(eq(t.bookLink.state, 'proposed')).all().filter((l) => mine(l.aiRunId));
  const ideas = db.select({ row: t.bookIdea, name: t.idea.name }).from(t.bookIdea).innerJoin(t.idea, eq(t.idea.id, t.bookIdea.ideaId))
    .where(and(eq(t.bookIdea.state, 'proposed'), isNull(t.idea.mergedInto))).all().filter((r) => mine(r.row.aiRunId));
  const ids = [...new Set([...links.flatMap((l) => [l.fromBook, l.toBook]), ...ideas.map((r) => r.row.bookId)])];
  const books = new Map(ids.length ? db.select().from(t.book).where(inArray(t.book.id, ids)).all().map((b) => [b.id, bookRef(b)]) : []);
  return {
    links: links.map((l) => ({ from: books.get(l.fromBook)!, to: books.get(l.toBook)!, reason: l.reason, confidence: l.confidence, fromAi: l.aiRunId !== null }))
      .sort((a, b) => b.confidence - a.confidence),
    ideas: ideas.map(({ row, name }) => ({ book: books.get(row.bookId)!, idea: { id: row.ideaId, name }, layer: row.layer, confidence: row.confidence, fromAi: row.aiRunId !== null }))
      .sort((a, b) => b.confidence - a.confidence),
  };
}

const NAME_MAX = 60;

/** PATCH /ideas/{id}: rename an idea, or merge it into another (the household's shared vocabulary, ADR 0005). */
export function editIdea(db: Db, ideaId: string, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new KnowledgeError(400, 'a JSON object is needed');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'name' && k !== 'mergeInto') throw new KnowledgeError(400, `unknown field ${k}`);
  if ((b.name === undefined) === (b.mergeInto === undefined)) throw new KnowledgeError(400, 'either name or mergeInto');
  const idea = db.select().from(t.idea).where(eq(t.idea.id, ideaId)).get();
  if (!idea || idea.mergedInto) throw new KnowledgeError(404, 'no such idea');

  if (b.name !== undefined) {
    const name = typeof b.name === 'string' ? b.name.replace(/\s+/g, ' ').trim() : '';
    if (!name || name.length > NAME_MAX) throw new KnowledgeError(400, `name: 1 to ${NAME_MAX} characters`);
    if (db.select().from(t.idea).where(and(eq(t.idea.name, name), ne(t.idea.id, ideaId))).get()) throw new KnowledgeError(409, 'another idea has that name: merge into it instead');
    db.update(t.idea).set({ name }).where(eq(t.idea.id, ideaId)).run();
    return { id: ideaId, name };
  }

  const into = typeof b.mergeInto === 'string' ? db.select().from(t.idea).where(eq(t.idea.id, b.mergeInto)).get() : undefined;
  if (!into || into.mergedInto) throw new KnowledgeError(404, 'no such idea to merge into');
  if (into.id === ideaId) throw new KnowledgeError(400, 'an idea cannot merge into itself');
  const rank = { confirmed: 2, proposed: 1, rejected: 0 } as const;
  db.transaction((tx) => {
    for (const row of tx.select().from(t.bookIdea).where(eq(t.bookIdea.ideaId, ideaId)).all()) {
      const there = tx.select().from(t.bookIdea).where(and(eq(t.bookIdea.bookId, row.bookId), eq(t.bookIdea.ideaId, into.id))).get();
      // A book in both keeps the stronger decision: confirmed over proposed over rejected.
      if (!there) tx.insert(t.bookIdea).values({ ...row, ideaId: into.id }).run();
      else if (rank[row.state] > rank[there.state]) tx.update(t.bookIdea).set({ state: row.state, layer: row.layer, reviewedBy: row.reviewedBy, reviewedAt: row.reviewedAt }).where(and(eq(t.bookIdea.bookId, row.bookId), eq(t.bookIdea.ideaId, into.id))).run();
      tx.delete(t.bookIdea).where(and(eq(t.bookIdea.bookId, row.bookId), eq(t.bookIdea.ideaId, ideaId))).run();
    }
    tx.update(t.idea).set({ mergedInto: into.id }).where(eq(t.idea.mergedInto, ideaId)).run();
    tx.update(t.idea).set({ mergedInto: into.id }).where(eq(t.idea.id, ideaId)).run();
  });
  return { id: into.id, name: into.name };
}

/** GET /people/{id}/brain: an adult's ideas with their layers, and the edges between ideas (ADR 0005). */
export function getBrain(db: Db, personId: string): S['Brain'] {
  const p = getPerson(db, personId);
  if (!p) throw new KnowledgeError(404, 'no such person');
  if (p.role === 'kid') throw new KnowledgeError(404, 'kids have an emotional map, not a brain (see their library)');

  const read = new Set(db.select({ id: t.reading.bookId }).from(t.reading).where(and(eq(t.reading.personId, p.id), eq(t.reading.status, 'read'))).all().map((r) => r.id));
  const notUnread = new Set(db.select({ id: t.reading.bookId, s: t.reading.status }).from(t.reading).where(eq(t.reading.personId, p.id)).all().filter((r) => r.s !== 'to_read').map((r) => r.id));
  const owned = new Set(db.selectDistinct({ id: t.copy.bookId }).from(t.copy).all().map((r) => r.id));
  // The person's open candidates with their scores (packages/scoring, as the Backlog shows them): the best one fills
  // each layer's "next".
  const candScore = new Map(allCandidates(db).filter((c) => c.personId === p.id && c.state === 'open').map((c) => [c.book.id, c.score ?? -Infinity]));

  // What counts (spec §6): confirmed, or proposed with confidence ≥ 0.8; never rejected; merged ideas are gone.
  const tags = db.select({ bookId: t.bookIdea.bookId, ideaId: t.idea.id, name: t.idea.name, layer: t.bookIdea.layer, state: t.bookIdea.state, confidence: t.bookIdea.confidence })
    .from(t.bookIdea).innerJoin(t.idea, eq(t.idea.id, t.bookIdea.ideaId)).where(isNull(t.idea.mergedInto)).all()
    .filter((r) => r.state === 'confirmed' || (r.state === 'proposed' && r.confidence >= 0.8));
  const mineTags = tags.filter((r) => read.has(r.bookId) || (owned.has(r.bookId) && !notUnread.has(r.bookId)) || candScore.has(r.bookId));
  const bookIds = [...new Set(mineTags.map((r) => r.bookId))];
  const books = new Map(bookIds.length ? db.select().from(t.book).where(inArray(t.book.id, bookIds)).all().map((b) => [b.id, bookRef(b)]) : []);

  const byIdea = new Map<string, { id: string; name: string; rows: typeof mineTags }>();
  for (const r of mineTags) {
    if (!byIdea.has(r.ideaId)) byIdea.set(r.ideaId, { id: r.ideaId, name: r.name, rows: [] });
    byIdea.get(r.ideaId)!.rows.push(r);
  }
  const ideas = [...byIdea.values()].map((i) => {
    const readRows = i.rows.filter((r) => read.has(r.bookId));
    const layers = Object.fromEntries(LAYERS.map((layer) => {
      const best = i.rows.filter((r) => r.layer === layer && candScore.has(r.bookId)).sort((a, b) => candScore.get(b.bookId)! - candScore.get(a.bookId)!)[0];
      return [layer, { books: readRows.filter((r) => r.layer === layer).map((r) => books.get(r.bookId)!), next: best ? books.get(best.bookId)! : null }];
    }));
    return {
      id: i.id, name: i.name, readCount: readRows.length,
      unreadOwned: i.rows.filter((r) => owned.has(r.bookId) && !read.has(r.bookId) && !notUnread.has(r.bookId)).length,
      isNew: readRows.length === 0, layers,
    };
  }).sort((a, b) => b.readCount - a.readCount || a.name.localeCompare(b.name));

  // Edges: read books tagged with two ideas (thickness = count); a wished-for book with two ideas is a future edge.
  const edges = new Map<string, { a: string; b: string; weight: number; via: string[]; kind: 'read' | 'future' }>();
  const ideasOfBook = new Map<string, string[]>();
  for (const r of mineTags) ideasOfBook.set(r.bookId, [...new Set([...(ideasOfBook.get(r.bookId) ?? []), r.ideaId])]);
  for (const [bookId, ids] of ideasOfBook) {
    const kind = read.has(bookId) ? 'read' : candScore.has(bookId) ? 'future' : null;
    if (!kind) continue;
    const sorted = [...ids].sort();
    for (let x = 0; x < sorted.length; x++) for (let y = x + 1; y < sorted.length; y++) {
      const key = `${kind}:${sorted[x]}:${sorted[y]}`;
      const e = edges.get(key) ?? { a: sorted[x]!, b: sorted[y]!, weight: 0, via: [], kind };
      e.weight++;
      e.via.push(books.get(bookId)!.title);
      edges.set(key, e);
    }
  }
  return { ideas, edges: [...edges.values()].sort((a, b) => b.weight - a.weight) };
}
