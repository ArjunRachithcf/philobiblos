// The AI's jobs (contracts/ai-plugin.md): what each one reads, for whom it runs, and where its output goes. Every call
// goes through runAi (ai/run.ts); every output lands as a proposal or a text, never as an effect a person did not tap.
//
// - readShares: a share's own images, caption and link, for its sharer → the share's found books (the Inbox offers them).
// - tagBooks: an adult book's title, authors and blurb, with the household's idea names → proposed book ideas; then, for
//   each adult with the book in their backlog, their read books (library/ai-context.ts, the only way to takeaways) →
//   proposed links through knowledge/from-run.ts, private to that adult when their takeaways were read; and the
//   household's owned books in the same ideas → a proposed redundancy (counted only once a person confirms it).
// - suggest: an adult's reading map (idea names, counts, layers), their backlog's and the shelf's titles → suggestions in
//   their own Inbox (ai_suggestion items), added to a backlog only by their tap.
// - explain: a kept plan's adult picks → the one-line why the plan shows.
import { lstatSync, openSync, readSync, closeSync, constants, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq, gt, inArray, isNull, notInArray } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Image } from '@shelf/contracts';
import { holdsTakeaways, type Model } from '@shelf/ai';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { household } from '../household/people';
import { SealError, sealingKey, unseal } from '../household/sealed';
import type { Outcome } from '../jobs/books';
import { countedTags } from '../knowledge/tags';
import { getBrain } from '../knowledge/knowledge';
import { proposeBookIdeas, proposeLinks } from '../knowledge/from-run';
import { readBooksForAi } from '../library/ai-context';
import { KIDS_THEMES, bookRef } from '../library/library';
import { addressParts } from '../mail/read';
import { SEALED } from '../routes/month';
import { currentMonth } from '../month/plan';
import { modelFor, type ModelDeps } from './model';
import { AiBudget, AiError, runAi } from './run';
import { getAi } from './settings';

/** How much one run of each job does at most (the budget caps the calls and tokens on top). */
export const PER_RUN = { shares: 20, books: 30, people: 20, picks: 20 } as const;
/** Shares older than this are not read by the AI any more (turned on late, say). */
export const SHARE_AI_DAYS = 30;
/** A kept JPEG of a share, as shares.ts names it. */
const KEPT = /^shares\/[0-9A-HJKMNP-TV-Z]{26}\/\d{2}(?:-\d{2})?\.jpg$/;
const KEPT_MAX = 4 << 20;

export interface AiJobOptions extends ModelDeps {
  budget?: () => AiBudget;
  now?: () => Date;
  /** Tests: the model, instead of the one the settings name. */
  model?: () => Model;
}

/** The delivery address's pieces, for safeField on every answer; none when nothing is sealed or it does not open. */
function address(db: Db, cfg: Pick<Config, 'sealingKey'>): string[] {
  try { return addressParts(unseal(db, sealingKey(cfg), SEALED.deliveryAddress)); } catch (e) { if (e instanceof SealError) return []; throw e; }
}

/** A kept JPEG, read without following links, regular files only, within its size. */
function readKept(dataDir: string, path: string): Buffer | null {
  if (!KEPT.test(path)) return null;
  const p = join(dataDir, path);
  try {
    if (!lstatSync(p).isFile()) return null;
    const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > KEPT_MAX) return null;
      const b = Buffer.alloc(st.size);
      readSync(fd, b, 0, st.size, 0);
      return b;
    } finally { closeSync(fd); }
  } catch { return null; }
}

const done = (detail: string): Outcome => ({ status: 'done', detail });
const stopped = (e: unknown, did: string): Outcome | null => (e instanceof AiError && e.reason === 'budget' ? { status: 'blocked', detail: `${did}; stopped: ${e.message}` } : null);

export class AiJobs {
  private reading: Promise<Outcome> | null = null;
  private again = false;
  constructor(private readonly db: Db, private readonly cfg: Pick<Config, 'ollamaUrl' | 'egress' | 'sealingKey' | 'dataDir' | 'timezone'>, private readonly o: AiJobOptions = {}) {}

  private start(job: 'read' | 'link' | 'suggest' | 'explain'): { why: string } | { why?: undefined; model: Model; budget: AiBudget; address: string[]; wildcards: boolean } {
    const s = getAi(this.db);
    if (!s.jobs[job]) return { why: 'this job is turned off (Settings)' };
    const m = this.o.model ? { model: this.o.model(), why: '' } : modelFor(this.db, this.cfg, this.o);
    if (!m.model) return { why: m.why ?? 'no AI model' };
    const model: Model = m.model;
    return { model, budget: this.o.budget?.() ?? new AiBudget(), address: address(this.db, this.cfg), wildcards: s.jobs.wildcards };
  }
  private now() { return (this.o.now ?? (() => new Date()))(); }

  /** Starts reading shares unless a pass is going (which then looks again). */
  kickShares(): Promise<Outcome> {
    if (this.reading) { this.again = true; return this.reading; }
    this.reading = (async () => {
      let out: Outcome;
      do { this.again = false; out = await this.readShares(); } while (this.again);
      return out;
    })().finally(() => { this.reading = null; });
    return this.reading;
  }

  /** extractTitles on shares the media worker is done with and the AI has not read. */
  async readShares(): Promise<Outcome> {
    const s = this.start('read');
    if (s.why !== undefined) return done(`shares not read: ${s.why}`);
    const since = new Date(this.now().getTime() - SHARE_AI_DAYS * 86_400_000).toISOString();
    const rows = this.db.select().from(t.share).where(and(eq(t.share.status, 'done'), isNull(t.share.foundJson), gt(t.share.createdAt, since))).orderBy(t.share.createdAt).limit(PER_RUN.shares).all();
    let n = 0;
    for (const r of rows) {
      const kept = (JSON.parse(r.mediaJson) as { path: string; at?: number }[]).slice(0, 30);
      const images = kept.map((k) => readKept(this.cfg.dataDir, k.path)).filter((b): b is Buffer => b !== null);
      const input = { images: kept.map((k): Image => ({ path: k.path, mimeType: 'image/jpeg', ...(k.at != null ? { atSeconds: k.at } : {}) })), ...(r.caption ? { caption: r.caption } : {}), ...(r.url ? { url: r.url } : {}) };
      let found: Record<string, unknown>;
      try {
        const { output } = await runAi(this.db, s.model, 'extractTitles', input, { budget: s.budget, personId: r.personId, images, address: s.address });
        // What the AI could look at, in Shelf's words, for the Inbox.
        found = { ...output, readFrom: images.length && s.model.supportsVision ? 'images' : 'caption' };
      } catch (e) {
        const stop = stopped(e, `${n} shares read`);
        if (stop) return stop;
        if (!(e instanceof AiError)) throw e;
        found = { books: [], unread: 'The AI could not read this share; add its books by hand.' };
      }
      this.db.update(t.share).set({ foundJson: JSON.stringify(found) }).where(eq(t.share.id, r.id)).run();
      n++;
    }
    return done(`${n} shares read`);
  }

  /** tagBook, then proposeLinks and checkRedundant, on adults' backlog books with no ideas yet. */
  async tagBooks(): Promise<Outcome> {
    const s = this.start('link');
    if (s.why !== undefined) return done(`books not tagged: ${s.why}`);
    const db = this.db;
    const tagged = db.selectDistinct({ id: t.bookIdea.bookId }).from(t.bookIdea).all().map((r) => r.id);
    const adults = household(db).filter((p) => p.role !== 'kid');
    const wanted = db.selectDistinct({ id: t.candidate.bookId }).from(t.candidate)
      .where(and(eq(t.candidate.state, 'active'), inArray(t.candidate.personId, adults.length ? adults.map((p) => p.id) : ['']), tagged.length ? notInArray(t.candidate.bookId, tagged) : undefined)).all().map((r) => r.id);
    const books = wanted.length ? db.select().from(t.book).where(and(inArray(t.book.id, wanted), eq(t.book.audience, 'adult'))).orderBy(t.book.id).limit(PER_RUN.books).all() : [];
    let n = 0, links = 0, ideas = 0;
    for (const b of books) {
      try {
        const vocabulary = db.select({ name: t.idea.name }).from(t.idea).where(isNull(t.idea.mergedInto)).all().map((r) => r.name).sort();
        const blurb = db.select({ d: t.bookMeta.description }).from(t.bookMeta).where(eq(t.bookMeta.bookId, b.id)).get()?.d ?? undefined;
        const ref = bookRef(b);
        const tag = await runAi(db, s.model, 'tagBook', { book: ref, ...(blurb ? { blurb } : {}), ideaVocabulary: vocabulary, kidsThemes: [...KIDS_THEMES] }, { budget: s.budget, address: s.address });
        const rows = (tag.output.ideas ?? []).map((x) => ({ bookId: b.id, ideaId: ideaId(db, x.name), layer: x.layer, confidence: x.confidence }));
        ideas += proposeBookIdeas(db, tag.runId, rows);
        const candIdeas = (tag.output.ideas ?? []).map((x) => ({ name: x.name, layer: x.layer, confidence: x.confidence }));
        const names = new Set(candIdeas.map((x) => x.name));
        // Each adult whose backlog holds it: their read books, theirs only, through the one gate.
        for (const p of adults) {
          if (!db.select({ x: t.candidate.bookId }).from(t.candidate).where(and(eq(t.candidate.personId, p.id), eq(t.candidate.bookId, b.id), eq(t.candidate.state, 'active'))).get()) continue;
          const read = readBooksForAi(db, p.id).filter((r) => r.id !== b.id);
          // The same ideas first, then the rest, at most 60.
          const ordered = [...read.filter((r) => r.ideas.some((i) => names.has(i))), ...read.filter((r) => !r.ideas.some((i) => names.has(i)))].slice(0, 60);
          if (!ordered.length) continue;
          const layers = new Map(countedTags(db, ordered.map((r) => r.id)).map((x) => [`${x.bookId}\u0000${x.name}`, x.layer]));
          const readBooks = ordered.map((r) => ({ ...r, ideas: r.ideas.map((name) => ({ name, layer: layers.get(`${r.id}\u0000${name}`) ?? 'core' as const, confidence: 1 })) }));
          const input = { candidate: { ...ref, ideas: candIdeas }, readBooks };
          // Their takeaways are in it only if they turned that on (ai-context.ts); the run then says whose.
          const run = await runAi(db, s.model, 'proposeLinks', input, { budget: s.budget, personId: p.id, takeawaysOf: holdsTakeaways('proposeLinks', input) ? p.id : null, address: s.address });
          links += proposeLinks(db, run.runId, run.output.links.map((l) => ({ fromBook: b.id, toBook: l.toBookId, reason: l.reason, confidence: l.confidence })));
        }
        // The household's owned books in the same ideas: does it repeat one?
        const ownedIds = db.selectDistinct({ id: t.copy.bookId }).from(t.copy).all().map((r) => r.id).filter((id) => id !== b.id);
        const sameIdea = new Set(countedTags(db, ownedIds).filter((x) => names.has(x.name)).map((x) => x.bookId));
        const owned = ownedIds.filter((id) => sameIdea.has(id));
        if (owned.length) {
          const refs = db.select().from(t.book).where(inArray(t.book.id, owned)).all().map(bookRef);
          const red = await runAi(db, s.model, 'checkRedundant', { candidate: ref, owned: refs }, { budget: s.budget, address: s.address });
          if (red.output.repeats) db.insert(t.redundancy).values({ bookId: b.id, repeatsBook: red.output.repeats, reason: red.output.reason ?? 'The AI thinks it repeats this book', state: 'proposed' }).onConflictDoNothing().run();
        }
        n++;
      } catch (e) {
        const stop = stopped(e, `${n} books tagged`);
        if (stop) return stop;
        if (!(e instanceof AiError)) throw e;
      }
    }
    return done(`${n} of ${books.length} books tagged; ${ideas} ideas and ${links} links proposed`);
  }

  /** suggestNext for each adult: up to 3 books to their own Inbox. */
  async suggest(): Promise<Outcome> {
    const s = this.start('suggest');
    if (s.why !== undefined) return done(`no suggestions: ${s.why}`);
    const db = this.db;
    const ownedTitles = db.selectDistinct({ title: t.book.title }).from(t.copy).innerJoin(t.book, eq(t.book.id, t.copy.bookId)).all().map((r) => r.title);
    let n = 0;
    for (const p of household(db).filter((x) => x.role !== 'kid').slice(0, PER_RUN.people)) {
      const brain = getBrain(db, p.id);
      const ideas = brain.ideas.map((i) => {
        const layers = i.layers as Record<string, { books?: unknown[] }>;
        const filled = (['intro', 'core', 'deep', 'counterpoint'] as const).filter((l) => (layers[l]?.books?.length ?? 0) > 0);
        return { name: i.name, readCount: i.readCount, layersFilled: filled, gaps: (['intro', 'core', 'deep', 'counterpoint'] as const).filter((l) => !filled.includes(l)) };
      });
      const backlog = db.select({ title: t.book.title }).from(t.candidate).innerJoin(t.book, eq(t.book.id, t.candidate.bookId)).where(eq(t.candidate.personId, p.id)).all().map((r) => r.title);
      try {
        await runAi(db, s.model, 'suggestNext', { brain: { ideas }, backlogTitles: backlog, owned: ownedTitles, wildcards: s.wildcards, max: 3 }, { budget: s.budget, personId: p.id, address: s.address });
        n++;
      } catch (e) {
        const stop = stopped(e, `${n} people`);
        if (stop) return stop;
        if (!(e instanceof AiError)) throw e;
      }
    }
    return done(`suggestions for ${n} people`);
  }

  /** explainPick for this month's kept plan: each adult pick's one-line why. */
  async explain(): Promise<Outcome> {
    const s = this.start('explain');
    if (s.why !== undefined) return done(`no picks explained: ${s.why}`);
    const db = this.db;
    const month = currentMonth(this.cfg.timezone, this.now());
    const order = db.select().from(t.order).where(eq(t.order.month, month)).orderBy(desc(t.order.createdAt)).get();
    if (!order) return done('no plan kept for this month yet');
    const adults = new Set(household(db).filter((p) => p.role !== 'kid').map((p) => p.id));
    const lines = db.select().from(t.orderLine).where(and(eq(t.orderLine.orderId, order.id), isNull(t.orderLine.why))).all().filter((l) => adults.has(l.forPerson)).slice(0, PER_RUN.picks);
    let n = 0;
    for (const l of lines) {
      const b = db.select().from(t.book).where(eq(t.book.id, l.bookId)).get();
      if (!b) continue;
      const idea = countedTags(db, [b.id])[0]?.name ?? 'a new idea';
      // The read books it builds on, by the links that count, as the person sees them.
      const read = new Set(readBooksForAi(db, l.forPerson).map((r) => r.id));
      const to = db.select({ to: t.bookLink.toBook, state: t.bookLink.state, c: t.bookLink.confidence, priv: t.bookLink.privateTo }).from(t.bookLink).where(eq(t.bookLink.fromBook, b.id)).all()
        .filter((x) => read.has(x.to) && x.state !== 'rejected' && (x.state === 'confirmed' || x.c >= 0.8) && (!x.priv || x.priv === l.forPerson)).map((x) => x.to);
      const buildsOn = to.length ? db.select({ title: t.book.title }).from(t.book).where(inArray(t.book.id, to)).all().map((x) => x.title) : [];
      try {
        const { output } = await runAi(db, s.model, 'explainPick', { pick: bookRef(b), move: (l.move ?? 'intro') as never, buildsOn, idea }, { budget: s.budget, personId: l.forPerson, address: s.address });
        db.update(t.orderLine).set({ why: output.why }).where(and(eq(t.orderLine.orderId, order.id), eq(t.orderLine.bookId, b.id))).run();
        n++;
      } catch (e) {
        const stop = stopped(e, `${n} picks explained`);
        if (stop) return stop;
        if (!(e instanceof AiError)) throw e;
      }
    }
    return done(`${n} picks explained`);
  }
}

/** The idea of that name (as it reads now, merges followed), or a new one: a proposal names it, a person confirms it. */
function ideaId(db: Db, name: string): string {
  const all = db.select().from(t.idea).all();
  const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const hit = all.find((i) => norm(i.name) === norm(name));
  if (hit) return hit.mergedInto ?? hit.id;
  const id = ulid();
  db.insert(t.idea).values({ id, name }).run();
  return id;
}
