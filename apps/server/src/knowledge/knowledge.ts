// Ideas, layers and links (ADR 0005, spec §6). Proposals (from the AI, or the seed's guesses) stay proposals until a
// person confirms or rejects them; nothing else changes their state, and the reviewer is recorded.
//
// Privacy (shelf#3): a link or book idea written from someone's takeaways carries `private_to` (set when the AI writes
// it, kept whatever happens to the run): only that person sees its reason and decides it; for everyone else it does
// not exist as a proposal (404, not 403: no hint that it is there). A decided private link still counts for scores (a
// link between two books is the household's); others see a neutral reason in its place.
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { ulid } from 'ulid';
import type { components } from '@shelf/contracts/openapi';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { getPerson } from '../household/people';
import { allCandidates } from '../backlog/backlog';
import { bookRef } from '../library/library';
import { countedTags, type Reader } from './tags';
import { confirmIdeaProposal } from './from-run';

type S = components['schemas'];
type Layer = 'intro' | 'core' | 'deep' | 'counterpoint';
export const LAYERS: Layer[] = ['intro', 'core', 'deep', 'counterpoint'];
export const PRIVATE_REASON = 'Proposed from someone’s own reading';

export class KnowledgeError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}

/** A link's reason as this viewer may see it. */
export function visibleReason(link: { reason: string; privateTo: string | null }, viewer: string): string {
  return link.privateTo && link.privateTo !== viewer ? PRIVATE_REASON : link.reason;
}

const hidden = (row: { privateTo: string | null }, viewer: string) => row.privateTo !== null && row.privateTo !== viewer;

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
  if (!link || hidden(link, viewer)) throw new KnowledgeError(404, 'no such link');
  db.update(t.bookLink).set({ state: state!, reviewedBy: viewer, reviewedAt: now.toISOString() })
    .where(and(eq(t.bookLink.fromBook, from), eq(t.bookLink.toBook, to))).run();
  return { state: state!, reason: visibleReason(link, viewer) };
}

/** PUT /books/{book}/ideas/{idea}: a person confirms or rejects a book's idea, or puts it in another layer (which confirms it). */
export function reviewBookIdea(db: Db, viewer: string, bookId: string, ideaId: string, body: unknown, now = new Date()) {
  const u = parseReview(body, true);
  const row = db.select().from(t.bookIdea).where(and(eq(t.bookIdea.bookId, bookId), eq(t.bookIdea.ideaId, ideaId))).get();
  if (!row || hidden(row, viewer)) throw new KnowledgeError(404, 'no such idea on that book');
  const next = { state: u.state ?? 'confirmed' as const, layer: u.layer ?? row.layer };
  db.update(t.bookIdea).set({ ...next, reviewedBy: viewer, reviewedAt: now.toISOString() })
    .where(and(eq(t.bookIdea.bookId, bookId), eq(t.bookIdea.ideaId, ideaId))).run();
  return next;
}

/** GET /proposals: what is waiting for a person's decision, as this viewer may see it (others' private ones left out). */
export function listProposals(db: Db, viewer: string) {
  const links = db.select().from(t.bookLink).where(eq(t.bookLink.state, 'proposed')).all().filter((l) => !hidden(l, viewer));
  // A proposal on a merged idea shows under the idea it went into; it is reviewed by its own row (idea.id).
  const into = alias(t.idea, 'into_idea');
  const ideas = db.select({ row: t.bookIdea, name: t.idea.name, intoId: into.id, intoName: into.name }).from(t.bookIdea)
    .innerJoin(t.idea, eq(t.idea.id, t.bookIdea.ideaId)).leftJoin(into, eq(into.id, t.idea.mergedInto))
    .where(eq(t.bookIdea.state, 'proposed')).all().filter((r) => !hidden(r.row, viewer));
  // New ideas the AI proposed: a name on a proposal, no idea yet (knowledge/from-run.ts).
  const fresh = db.select().from(t.ideaProposal).where(eq(t.ideaProposal.state, 'proposed')).all().filter((r) => !hidden(r, viewer));
  const ids = [...new Set([...links.flatMap((l) => [l.fromBook, l.toBook]), ...ideas.map((r) => r.row.bookId), ...fresh.map((r) => r.bookId)])];
  const books = new Map(ids.length ? db.select().from(t.book).where(inArray(t.book.id, ids)).all().map((b) => [b.id, bookRef(b)]) : []);
  return {
    links: links.map((l) => ({ from: books.get(l.fromBook)!, to: books.get(l.toBook)!, reason: l.reason, confidence: l.confidence, fromAi: l.aiRunId !== null || l.privateTo !== null, onlyYou: l.privateTo === viewer }))
      .sort((a, b) => b.confidence - a.confidence),
    ideas: ideas.map(({ row, name, intoName }) => ({ book: books.get(row.bookId)!, idea: { id: row.ideaId, name: intoName ?? name }, layer: row.layer, confidence: row.confidence, fromAi: row.aiRunId !== null || row.privateTo !== null, onlyYou: row.privateTo === viewer }))
      .sort((a, b) => b.confidence - a.confidence),
    newIdeas: fresh.map((r) => ({ id: r.id, book: books.get(r.bookId)!, name: r.name, layer: r.layer, confidence: r.confidence, fromAi: true, onlyYou: r.privateTo === viewer }))
      .sort((a, b) => b.confidence - a.confidence),
  };
}

/**
 * PUT /idea-proposals/{id}: a person confirms a new idea the AI proposed for a book (it becomes an idea, or the one of
 * that name, and the book's tag in it, confirmed: from-run.ts), or rejects it (no idea is ever made of it). Moving it
 * to another layer confirms it there. Same privacy as links.
 */
export function reviewIdeaProposal(db: Db, viewer: string, proposalId: string, body: unknown, now = new Date()) {
  const u = parseReview(body, true);
  const row = db.select().from(t.ideaProposal).where(eq(t.ideaProposal.id, proposalId)).get();
  if (!row || hidden(row, viewer)) throw new KnowledgeError(404, 'no such proposal');
  if (row.state !== 'proposed') throw new KnowledgeError(409, 'already decided');
  const layer = u.layer ?? row.layer;
  if (u.state === 'rejected') {
    db.update(t.ideaProposal).set({ state: 'rejected', reviewedBy: viewer, reviewedAt: now.toISOString() }).where(eq(t.ideaProposal.id, row.id)).run();
    return { state: 'rejected' as const, layer };
  }
  const ideaId = confirmIdeaProposal(db, row, layer, viewer, now);
  return { state: 'confirmed' as const, layer, idea: { id: ideaId, name: db.select({ n: t.idea.name }).from(t.idea).where(eq(t.idea.id, ideaId)).get()!.n } };
}

const NAME_MAX = 60;

/** PATCH /ideas/{id}: rename an idea, or merge it into another (the household's shared vocabulary, ADR 0005). */
export function editIdea(db: Db, ideaId: string, body: unknown, by: string | null = null, now = new Date()) {
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
  // No row changes: a merge decides nothing (a private proposal stays its owner's, waiting). The idea points at the
  // other one, and so do the ideas that pointed at it (one step); the log keeps what changed, for an admin's undo.
  db.transaction((tx) => {
    const repointed = tx.select({ id: t.idea.id }).from(t.idea).where(eq(t.idea.mergedInto, ideaId)).all().map((r) => r.id);
    tx.update(t.idea).set({ mergedInto: into.id }).where(eq(t.idea.mergedInto, ideaId)).run();
    tx.update(t.idea).set({ mergedInto: into.id }).where(eq(t.idea.id, ideaId)).run();
    tx.insert(t.ideaMerge).values({ id: ulid(), ideaId, intoId: into.id, repointedJson: JSON.stringify(repointed), mergedBy: by, mergedAt: now.toISOString() }).run();
  });
  return { id: into.id, name: into.name };
}

/** GET /ideas/merges: the merge log, newest first (who, when, what; undone or not). */
export function listMerges(db: Db) {
  const a = alias(t.idea, 'a');
  const b = alias(t.idea, 'b');
  const who = alias(t.person, 'who');
  return db.select({ m: t.ideaMerge, idea: a.name, into: b.name, by: who.name }).from(t.ideaMerge)
    .innerJoin(a, eq(a.id, t.ideaMerge.ideaId)).innerJoin(b, eq(b.id, t.ideaMerge.intoId)).leftJoin(who, eq(who.id, t.ideaMerge.mergedBy))
    .orderBy(desc(t.ideaMerge.mergedAt)).all()
    .map(({ m, idea, into, by }) => ({ id: m.id, idea: { id: m.ideaId, name: idea }, into: { id: m.intoId, name: into }, mergedBy: by ?? null, mergedAt: m.mergedAt, undone: m.undoneAt !== null }));
}

/** POST /ideas/merges/{id}/undo (admins): the idea stands on its own again, with the ideas the merge re-pointed. */
export function undoMerge(db: Db, mergeId: string, by: string, now = new Date()) {
  const m = db.select().from(t.ideaMerge).where(eq(t.ideaMerge.id, mergeId)).get();
  if (!m) throw new KnowledgeError(404, 'no such merge');
  if (m.undoneAt) throw new KnowledgeError(409, 'already undone');
  const idea = db.select().from(t.idea).where(eq(t.idea.id, m.ideaId)).get()!;
  if (idea.mergedInto !== m.intoId) throw new KnowledgeError(409, 'the idea has been merged again since: undo that first');
  db.transaction((tx) => {
    tx.update(t.idea).set({ mergedInto: null }).where(eq(t.idea.id, m.ideaId)).run();
    const back = JSON.parse(m.repointedJson) as string[];
    if (back.length) tx.update(t.idea).set({ mergedInto: m.ideaId }).where(and(inArray(t.idea.id, back), eq(t.idea.mergedInto, m.intoId))).run();
    tx.update(t.ideaMerge).set({ undoneBy: by, undoneAt: now.toISOString() }).where(eq(t.ideaMerge.id, mergeId)).run();
  });
  return { id: m.ideaId, name: idea.name };
}

/**
 * GET /people/{id}/brain: an adult's ideas with their layers, and the edges between ideas (ADR 0005). `reader`: an AI
 * run's (ai/jobs.ts suggest), which leaves out book ideas private to anyone but that run's person.
 */
export function getBrain(db: Db, personId: string, reader?: Reader): S['Brain'] {
  const p = getPerson(db, personId);
  if (!p) throw new KnowledgeError(404, 'no such person');
  if (p.role === 'kid') throw new KnowledgeError(404, 'kids have an emotional map, not a brain (see their library)');

  const read = new Set(db.select({ id: t.reading.bookId }).from(t.reading).where(and(eq(t.reading.personId, p.id), eq(t.reading.status, 'read'))).all().map((r) => r.id));
  const notUnread = new Set(db.select({ id: t.reading.bookId, s: t.reading.status }).from(t.reading).where(eq(t.reading.personId, p.id)).all().filter((r) => r.s !== 'to_read').map((r) => r.id));
  const owned = new Set(db.selectDistinct({ id: t.copy.bookId }).from(t.copy).all().map((r) => r.id));
  // The person's open candidates with their scores (packages/scoring, as the Backlog shows them): the best one fills
  // each layer's "next".
  const candScore = new Map(allCandidates(db).filter((c) => c.personId === p.id && c.state === 'open').map((c) => [c.book.id, c.score ?? -Infinity]));

  // What counts (spec §6, knowledge/tags.ts): merged ideas read under the idea they went into; rejected never counts.
  const tags = countedTags(db, undefined, reader);
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
