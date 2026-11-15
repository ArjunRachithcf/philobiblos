// The seed importer (`pnpm seed [folder]`): a seed folder's files → the database. Idempotent: running it twice
// changes nothing the second time. File shapes: seed-sample/README.md.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/open';
import * as t from '../db/schema';

export interface SeedCounts {
  people: number; books: number; copies: number; readings: number; offers: number; candidates: number;
  links: number; ideas: number; bookIdeas: number; themes: number; shares: number;
  /** Rows the files describe but the schema cannot hold yet (see `notes`). */
  skipped: number;
  notes: string[];
}

interface Owned { title: string; author: string; src?: string }
interface Wish { t: string; a: string; fmt?: string; p?: string; av?: string; d?: string; id?: string; tobuy?: boolean }
interface Thread { id: string; name: string; owned: [string, string][]; next: [string, string][] }
interface Curation { adultThreads?: Thread[]; redundant?: Record<string, string>; kids?: Record<string, { topic?: string; next?: string } | string> }
interface HouseholdEntry { handle?: string; name: string; role: 'admin' | 'adult' | 'kid'; birthYear?: number }

export function norm(s: string): string {
  return s.toLowerCase()
    .replace(/^[a-z-]+, [a-z]\.?: /, '') // "Surname, F: Title"
    .replace(/\(.*?\)/g, '')
    .normalize('NFKD').replace(/[^a-z0-9]/g, '');
}

/** "Fr.25.90" → 2590 centimes. */
export function parsePriceC(p: string | undefined): number | null {
  const m = /(\d+)(?:[.,](\d{1,2}))?/.exec(p ?? '');
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}

/** "15.11.26" → "2026-11-15T00:00:00.000Z". */
export function parseSeedDate(d: string | undefined, fallback: string): string {
  const m = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(d ?? '');
  return m ? `20${m[3]}-${m[2]}-${m[1]}T00:00:00.000Z` : fallback;
}

function readJson<T>(dir: string, file: string, fallback: T): T {
  const p = join(dir, file);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : fallback;
}

const PLACEHOLDER_HOUSEHOLD: HouseholdEntry[] = [
  { handle: 'adult1', name: 'Adult 1', role: 'admin' },
  { handle: 'adult2', name: 'Adult 2', role: 'adult' },
  { handle: 'kid1', name: 'Kid 1', role: 'kid' },
];

export function importSeed(db: Db, dir: string, now = new Date().toISOString()): SeedCounts {
  const c: SeedCounts = { people: 0, books: 0, copies: 0, readings: 0, offers: 0, candidates: 0, links: 0, ideas: 0, bookIdeas: 0, themes: 0, shares: 0, skipped: 0, notes: [] };
  const owned = readJson<Owned[]>(dir, 'owned.json', []);
  const wish = readJson<Wish[]>(dir, 'wishlist.json', []);
  const network = readJson<Record<string, [string, string][] | string>>(dir, 'network.json', {});
  const cur = readJson<Curation>(dir, 'curation.json', {});
  const cats = readJson<Record<string, string[]>>(dir, 'cats_raw.json', {});
  const household = readJson<HouseholdEntry[]>(dir, 'household.json', PLACEHOLDER_HOUSEHOLD);
  // Kids' topics in the seed → the themes of docs/spec.md §7 (the seed's own map; topics without a theme get none).
  const themeOfTopic = new Map(Object.entries(readJson<Record<string, string>>(dir, 'topics.json', {})).map(([k, v]) => [k.toLowerCase(), v]));
  const igPath = join(dir, 'ig_carousel.txt');
  const ig = existsSync(igPath)
    ? readFileSync(igPath, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'))
      .map((l) => l.split('|').map((x) => x.trim()) as [string, string, string])
    : [];

  const catOf = new Map<string, string>();
  for (const [cat, titles] of Object.entries(cats)) for (const title of titles) catOf.set(norm(title), cat);
  const kidsMeta = new Map<string, { topic?: string }>();
  for (const [title, v] of Object.entries(cur.kids ?? {})) if (!title.startsWith('_') && typeof v === 'object') kidsMeta.set(norm(title), v);
  const isKids = (title: string) => kidsMeta.has(norm(title)) || (catOf.get(norm(title)) ?? '').startsWith('Kids');
  const isFiction = (title: string) => /^fiction\b/i.test(catOf.get(norm(title)) ?? '');

  db.transaction((tx) => {
    // People ---------------------------------------------------------------
    const personId = new Map<string, string>();
    for (const h of household) {
      const existing = tx.select().from(t.person).where(eq(t.person.name, h.name)).get();
      if (existing) { personId.set(h.name, existing.id); continue; }
      const id = ulid();
      tx.insert(t.person).values({ id, name: h.name, role: h.role, birthYear: h.birthYear ?? null, settingsJson: JSON.stringify(h.handle ? { handle: h.handle } : {}) }).run();
      personId.set(h.name, id);
      c.people++;
    }
    const firstAdult = household.find((h) => h.role !== 'kid');
    const kids = household.filter((h) => h.role === 'kid');
    // seed/README.md: kids' candidates go to the youngest kid until the household knows every kid's birth year.
    const youngest = [...kids].sort((a, b) => (b.birthYear ?? 0) - (a.birthYear ?? 0))[0];
    if (!firstAdult) throw new Error('the household needs an adult');
    const adultId = personId.get(firstAdult.name)!;
    const kidId = youngest ? personId.get(youngest.name)! : adultId;

    // Books ------------------------------------------------------------------
    const byTitle = new Map<string, string>(); // norm(title) → book id
    for (const b of tx.select({ id: t.book.id, title: t.book.title }).from(t.book).all()) byTitle.set(norm(b.title), b.id);
    const findBook = (title: string): string | undefined => {
      const n = norm(title);
      if (byTitle.has(n)) return byTitle.get(n);
      if (n.length > 10) for (const [k, id] of byTitle) if (k.startsWith(n) || n.startsWith(k)) return id;
      return undefined;
    };
    // New books match existing ones exactly (by normalised title): a prefix would merge "Vol I" with "Vol II".
    const ensureBook = (title: string, author: string): string => {
      const found = byTitle.get(norm(title));
      if (found) return found;
      const id = ulid();
      const authors = author ? author.split(/,\s*/).filter(Boolean) : [];
      tx.insert(t.book).values({
        id, title, authorsJson: JSON.stringify(authors), audience: isKids(title) ? 'kids' : 'adult',
        isFiction: isFiction(title) ? 1 : 0, normKey: `${norm(title)}|${norm(authors[0] ?? '')}`, createdAt: now,
      }).run();
      byTitle.set(norm(title), id);
      c.books++;
      return id;
    };

    const ownedIds = new Set<string>();
    for (const o of owned) {
      const bookId = ensureBook(o.title, o.author);
      ownedIds.add(bookId);
      if (!tx.select().from(t.copy).where(and(eq(t.copy.bookId, bookId), eq(t.copy.source, 'seed'))).get()) {
        tx.insert(t.copy).values({ id: ulid(), bookId, source: 'seed', acquiredAt: now }).run();
        c.copies++;
      }
      // Reading status is unknown in the seed: `read` for the first adult (adults' books) until asked on first run.
      const reader = isKids(o.title) ? kidId : adultId;
      const r = tx.insert(t.reading).values({ personId: reader, bookId, status: 'read', updatedAt: now }).onConflictDoNothing().run();
      c.readings += r.changes;
    }

    // Wishlist: one candidate per title; the To buy flag wins; the first printed edition's offer.
    for (const w of wish) {
      const bookId = ensureBook(w.t, w.a);
      if (ownedIds.has(bookId)) continue;
      const isEbook = /ebook/i.test(w.fmt ?? '');
      if (!isEbook && w.id) {
        const r = tx.insert(t.bookOffer).values({ bookId, source: 'orellfuessli', externalId: w.id, priceC: parsePriceC(w.p), availability: w.av ?? null, seenAt: now }).onConflictDoNothing().run();
        c.offers += r.changes;
      }
      const forId = isKids(w.t) ? kidId : adultId;
      const addedAt = parseSeedDate(w.d, now);
      const origin = w.tobuy ? 'to_buy' : 'wishlist';
      const existing = tx.select().from(t.candidate).where(and(eq(t.candidate.personId, forId), eq(t.candidate.bookId, bookId))).get();
      if (!existing) {
        tx.insert(t.candidate).values({ personId: forId, bookId, origin, addedAt, touchedAt: addedAt }).run();
        c.candidates++;
      } else if (origin === 'to_buy' && existing.origin === 'wishlist') {
        tx.update(t.candidate).set({ origin }).where(and(eq(t.candidate.personId, forId), eq(t.candidate.bookId, bookId))).run();
      }
    }

    // Instagram finds: one share per post, a candidate per book not owned.
    const posts = new Map<string, string>();
    for (const [post, title, author] of ig) {
      if (!post || !title) continue;
      let shareId = posts.get(post);
      if (!shareId) {
        const url = `https://www.instagram.com/p/${post}/`;
        const existing = tx.select().from(t.share).where(eq(t.share.url, url)).get();
        shareId = existing?.id ?? ulid();
        if (!existing) {
          tx.insert(t.share).values({ id: shareId, personId: adultId, url, status: 'done', createdAt: now }).run();
          c.shares++;
        }
        posts.set(post, shareId);
      }
      const bookId = ensureBook(title, author ?? '');
      if (ownedIds.has(bookId)) continue;
      const forId = isKids(title) ? kidId : adultId;
      const r = tx.insert(t.candidate).values({ personId: forId, bookId, origin: 'share', shareId, addedAt: now, touchedAt: now }).onConflictDoNothing().run();
      c.candidates += r.changes;
    }

    // Hand-made links: confirmed.
    for (const [title, links] of Object.entries(network)) {
      if (title.startsWith('_') || !Array.isArray(links)) continue;
      const from = findBook(title);
      for (const [toTitle, reason] of links) {
        const to = findBook(toTitle);
        if (!from || !to || !ownedIds.has(to)) { c.skipped++; continue; }
        const r = tx.insert(t.bookLink).values({ fromBook: from, toBook: to, reason, confidence: 1, state: 'confirmed' }).onConflictDoNothing().run();
        c.links += r.changes;
      }
    }

    // Ideas: the curated threads first; the categories as a fallback (proposed, below the 0.8 that counts).
    const ideaId = (name: string): string => {
      const existing = tx.select().from(t.idea).where(eq(t.idea.name, name)).get();
      if (existing) return existing.id;
      const id = ulid();
      tx.insert(t.idea).values({ id, name }).run();
      c.ideas++;
      return id;
    };
    const tag = (bookId: string, idea: string, state: 'confirmed' | 'proposed', confidence: number) => {
      const r = tx.insert(t.bookIdea).values({ bookId, ideaId: ideaId(idea), layer: 'core', confidence, state }).onConflictDoNothing().run();
      c.bookIdeas += r.changes;
    };
    const tagged = new Set<string>();
    for (const th of cur.adultThreads ?? []) {
      for (const [title] of th.owned) {
        const b = findBook(title);
        if (b) { tag(b, th.name, 'confirmed', 1); tagged.add(b); } else c.skipped++;
      }
      for (const [title] of th.next) {
        const b = findBook(title);
        if (b) { tag(b, th.name, 'proposed', 0.5); tagged.add(b); } else c.skipped++;
      }
    }
    for (const [cat, titles] of Object.entries(cats)) {
      if (cat.startsWith('Kids') || /^fiction\b/i.test(cat)) continue;
      for (const title of titles) {
        const b = findBook(title);
        if (b && !tagged.has(b)) tag(b, cat, 'proposed', 0.5);
      }
    }

    // Kids' themes.
    for (const [n, meta] of kidsMeta) {
      const theme = themeOfTopic.get((meta.topic ?? '').toLowerCase());
      const b = byTitle.get(n) ?? findBook(n);
      if (!b || !theme) continue;
      const r = tx.insert(t.bookTheme).values({ bookId: b, theme }).onConflictDoNothing().run();
      c.themes += r.changes;
    }

    // Redundancies: the seed names the repeating book but not the book it repeats, which `redundancy` requires.
    const red = Object.keys(cur.redundant ?? {}).filter((k) => !k.startsWith('_')).length;
    if (red) {
      c.skipped += red;
      c.notes.push(`${red} redundancies not imported: the seed has no "repeats" book for them`);
    }
  });
  return c;
}
