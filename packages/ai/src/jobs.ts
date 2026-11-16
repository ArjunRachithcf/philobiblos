// What each job sends and what it may answer (contracts/ai-plugin.md, ADR 0009).
//
// - `split` is the job's data minimisation: it picks the fields the job needs, bounded, and says which are Shelf's own
//   (`data`: numbers, enums, its fixed lists and settings) and which came from outside or from a model (`untrusted`, by
//   source: titles, blurbs, captions, takeaways, and idea names, which a model may first have proposed). Nothing else of
//   the input reaches a provider.
// - `clean` runs after the answer validated against the contract schema: the answer is data from a model that may have
//   read hostile text, so every id must be one the input named, every text is one line of plain characters within its
//   bound, and what Shelf decides (a new idea, a wildcard, the count) is Shelf's, never the model's word.
import type { CheckRedundantOut, ExplainPickOut, ExtractTitlesOut, ProposeLinksOut, SuggestNextOut, TagBookOut } from '@shelf/contracts';
import type { CheckRedundantIn, ExplainPickIn, ExtractTitlesIn, JobIO, JobName, ProposeLinksIn, SuggestNextIn, TagBookIn } from './provider';
import { EXPLAIN_MAX } from './provider';

/** One line of plain text: NFKC, no control or format characters, white space collapsed, trimmed, at most `max`. */
export function line(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return s || null;
}
const norm = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const books = (b: { id: string; title: string; authors?: string[] }) => ({ id: b.id, title: line(b.title, 300) ?? '', authors: (b.authors ?? []).slice(0, 5).map((a) => line(a, 200)).filter(Boolean) });

/**
 * What can leave Shelf, field by field, in the words Settings shows (Settings.ai.leaves, the list an admin accepts before
 * Claude is on). Each job's `sends` names the field of every key its request holds, and buildPrompt refuses a request
 * holding a key its job does not name: the list and the requests are built from the same table, so they cannot drift.
 * The order here is the order of Settings' lines.
 */
export const FIELDS = {
  share: "A shared post's images (as Shelf re-encoded them), caption and link, for the person who shared it, one share per request",
  backlogBook: "Each book in an adult's backlog, one book per request: its title, authors and description",
  bookIdeas: 'The ideas proposed for that book',
  ideaNames: "The names of the household's ideas",
  kidsThemes: "Shelf's list of kids' themes",
  readBooks: "One adult's read books, up to 60 (titles, authors and ideas), one person per request, without their name",
  takeaways: 'With them, the takeaways of an adult who turned on "Takeaways to the AI" (nobody else\'s)',
  readingMap: "One adult's reading map (the names of their ideas, how many books they read in each, which layers are empty), one person per request, without their name",
  backlogTitles: "With it, the titles in that adult's backlog, up to 300",
  ownedTitles: "The titles of the household's owned books, up to 200",
  ownedBooks: "The household's owned books in the same ideas as a backlog book (titles and authors), up to 200",
  pick: "Each adult's pick for this month, one pick per request: its title, authors, its idea and what it does there (intro, deepen, …), without their name",
  buildsOn: "With it, the titles of that adult's read books the pick builds on, up to 10",
  ids: "Shelf's own ids of those books (they mean nothing outside Shelf)",
  jobSettings: "A job's own settings (how many suggestions, whether a wildcard may be one)",
} as const;
export type Field = keyof typeof FIELDS;

/** How much of a list a job sends at most. */
export const SEND = { readBooks: 60, owned: 200, backlog: 300, ideas: 60, vocabulary: 200, blurb: 2000, caption: 5000, takeaway: 300, images: 30 } as const;

type Clean<O> = { ok: true; out: O } | { ok: false; error: string };
interface Spec<I, O> {
  prompt: string;
  version: number;
  maxTokens: number;
  /** The field (FIELDS) of every key path the request may hold: `a.b` is key b in a's objects (or its array's items). */
  sends: Record<string, Field>;
  split(i: I): { data: Record<string, unknown>; untrusted: [string, unknown][] };
  clean(o: O, i: I, images: number): Clean<O>;
}

const extractTitles: Spec<ExtractTitlesIn, ExtractTitlesOut> = {
  prompt: 'extract_titles', version: 1, maxTokens: 4096,
  sends: { images: 'share', caption: 'share', link: 'share' },
  split: (i) => ({ data: { images: Math.min(i.images.length, SEND.images) }, untrusted: [['caption', line(i.caption, SEND.caption)], ['link', line(i.url, 2000)]] }),
  clean(o, _i, images) {
    const out = o.books.slice(0, 50).flatMap((b) => {
      const title = line(b.title, 300);
      if (!title) return [];
      const seenIn = [...new Set((b.seenIn ?? []).filter((n) => Number.isInteger(n) && n >= 0 && n < images))];
      return [{
        title, author: line(b.author, 200), confidence: b.confidence, ...(seenIn.length ? { seenIn } : {}),
        ...(b.audienceGuess ? { audienceGuess: b.audienceGuess } : {}), offTheme: b.offTheme === true,
        ...(b.offTheme === true && line(b.offThemeReason, 200) ? { offThemeReason: line(b.offThemeReason, 200)! } : {}),
      }];
    });
    // The model's notes are not kept: nothing shows them, and they would be text nobody asked for.
    return { ok: true, out: { books: out, framesRead: Math.min(o.framesRead ?? images, images) } };
  },
};

const tagBook: Spec<TagBookIn, TagBookOut> = {
  prompt: 'tag_book', version: 1, maxTokens: 2048,
  sends: { ideaVocabulary: 'ideaNames', kidsThemes: 'kidsThemes', book: 'backlogBook', 'book.id': 'ids', 'book.title': 'backlogBook', 'book.authors': 'backlogBook', blurb: 'backlogBook' },
  split: (i) => ({
    // Idea names are the household's, but a person may have confirmed one a model first proposed: untrusted, like
    // anything a model wrote. Only Shelf's own list of kids' themes is the input.
    data: { kidsThemes: i.kidsThemes },
    untrusted: [['ideaVocabulary', i.ideaVocabulary.slice(0, SEND.vocabulary).map((n) => line(n, 60))], ['book', books(i.book)], ['blurb', line(i.blurb, SEND.blurb)]],
  }),
  clean(o, i) {
    const known = new Map(i.ideaVocabulary.map((n) => [norm(n), n]));
    const seen = new Set<string>();
    const ideas = (o.ideas ?? []).flatMap((x) => {
      const name = line(x.name, 60);
      if (!name || name.split(' ').length > 6 || seen.has(norm(name))) return [];
      seen.add(norm(name));
      const k = known.get(norm(name));
      // Whether an idea is new is Shelf's to say: a name the vocabulary has is that idea, spelt as the household does.
      return [{ name: k ?? name, layer: x.layer, confidence: Math.min(1, Math.max(0, x.confidence)), isNewIdea: !k }];
    });
    const themes = (o.kidsThemes ?? []).filter((t) => i.kidsThemes.includes(t)).slice(0, 2);
    return { ok: true, out: { audience: o.audience, isFiction: o.isFiction, ideas: ideas.slice(0, 4), kidsThemes: themes, ageBand: o.ageBand ?? null } };
  },
};

const proposeLinks: Spec<ProposeLinksIn, ProposeLinksOut> = {
  prompt: 'propose_links', version: 1, maxTokens: 2048,
  sends: {
    book: 'backlogBook', 'book.id': 'ids', 'book.title': 'backlogBook', 'book.authors': 'backlogBook', 'book.ideas': 'bookIdeas', 'book.ideas.name': 'bookIdeas', 'book.ideas.layer': 'bookIdeas',
    readBooks: 'readBooks', 'readBooks.id': 'ids', 'readBooks.title': 'readBooks', 'readBooks.authors': 'readBooks', 'readBooks.ideas': 'readBooks', 'readBooks.ideas.name': 'readBooks', 'readBooks.ideas.layer': 'readBooks',
    'readBooks.takeaway': 'takeaways',
  },
  split: (i) => ({
    data: {},
    untrusted: [
      ['book', { ...books(i.candidate), ideas: i.candidate.ideas.slice(0, 4).map((t) => ({ name: t.name, layer: t.layer })) }],
      ['readBooks', i.readBooks.slice(0, SEND.readBooks).map((b) => ({ ...books(b), ideas: b.ideas.slice(0, 4).map((t) => ({ name: t.name, layer: t.layer })), ...(b.takeaway ? { takeaway: line(b.takeaway, SEND.takeaway) } : {}) }))],
    ],
  }),
  clean(o, i) {
    const ids = new Set(i.readBooks.slice(0, SEND.readBooks).map((b) => b.id));
    ids.delete(i.candidate.id);
    const seen = new Set<string>();
    const links = o.links.flatMap((l) => {
      const reason = line(l.reason, 120);
      if (!ids.has(l.toBookId) || seen.has(l.toBookId) || !reason) return [];
      seen.add(l.toBookId);
      return [{ toBookId: l.toBookId, reason, confidence: l.confidence }];
    });
    return { ok: true, out: { links: links.slice(0, 10) } };
  },
};

const suggestNext: Spec<SuggestNextIn, SuggestNextOut> = {
  prompt: 'suggest_next', version: 1, maxTokens: 2048,
  sends: {
    wildcards: 'jobSettings', max: 'jobSettings', brain: 'readingMap', 'brain.ideas': 'readingMap', 'brain.ideas.name': 'readingMap', 'brain.ideas.readCount': 'readingMap', 'brain.ideas.layersFilled': 'readingMap', 'brain.ideas.gaps': 'readingMap',
    backlogTitles: 'backlogTitles', owned: 'ownedTitles',
  },
  split: (i) => ({
    data: { wildcards: i.wildcards, max: Math.min(i.max, 3) },
    untrusted: [['brain', { ideas: i.brain.ideas.slice(0, SEND.ideas).map((x) => ({ name: line(x.name, 60), readCount: x.readCount, layersFilled: x.layersFilled, gaps: x.gaps })) }], ['owned', i.owned.slice(0, SEND.owned).map((t) => line(t, 300))], ['backlogTitles', i.backlogTitles.slice(0, SEND.backlog).map((t) => line(t, 300))]],
  }),
  clean(o, i) {
    const taken = new Set([...i.owned, ...i.backlogTitles].map(norm));
    let wild = 0;
    const out = o.suggestions.flatMap((s) => {
      const title = line(s.title, 300), author = line(s.author, 200), idea = line(s.idea, 60), why = line(s.why, 200);
      if (!title || !author || !idea || !why || taken.has(norm(title))) return [];
      if (s.move === 'wildcard' && (!i.wildcards || wild++ > 0)) return [];
      taken.add(norm(title));
      const ideas2 = line(s.ideas2, 60), futureLink = line(s.futureLink, 300);
      return [{ title, author, move: s.move, idea, why, ...(ideas2 ? { ideas2 } : {}), ...(futureLink ? { futureLink } : {}) }];
    });
    return { ok: true, out: { suggestions: out.slice(0, Math.max(0, Math.min(i.max, 3))) } };
  },
};

const explainPick: Spec<ExplainPickIn, ExplainPickOut> = {
  prompt: 'explain_pick', version: 1, maxTokens: 2048,
  sends: { move: 'pick', idea: 'pick', book: 'pick', 'book.id': 'ids', 'book.title': 'pick', 'book.authors': 'pick', buildsOn: 'buildsOn' },
  split: (i) => ({ data: { move: i.move }, untrusted: [['idea', line(i.idea, 60)], ['book', books(i.pick)], ['buildsOn', i.buildsOn.slice(0, 10).map((t) => line(t, 300))]] }),
  clean(o) {
    const why = line(o.why, EXPLAIN_MAX);
    return why ? { ok: true, out: { why } } : { ok: false, error: 'an empty why' };
  },
};

const checkRedundant: Spec<CheckRedundantIn, CheckRedundantOut> = {
  prompt: 'check_redundant', version: 1, maxTokens: 2048,
  sends: { book: 'backlogBook', 'book.id': 'ids', 'book.title': 'backlogBook', 'book.authors': 'backlogBook', owned: 'ownedBooks', 'owned.id': 'ids', 'owned.title': 'ownedBooks', 'owned.authors': 'ownedBooks' },
  split: (i) => ({ data: {}, untrusted: [['book', books(i.candidate)], ['owned', i.owned.slice(0, SEND.owned).map(books)]] }),
  clean(o, i) {
    const ids = new Set(i.owned.slice(0, SEND.owned).map((b) => b.id));
    ids.delete(i.candidate.id);
    const reason = line(o.reason, 120);
    // An id the input did not name repeats nothing.
    return { ok: true, out: o.repeats && ids.has(o.repeats) ? { repeats: o.repeats, ...(reason ? { reason } : {}) } : {} };
  },
};

/** Every key path of a value (`a.b`: key b of a's objects, or of its array's items), the root's own name first; null values included. */
export function keyPaths(root: string, v: unknown, out = new Set<string>()): Set<string> {
  if (root) out.add(root);
  if (Array.isArray(v)) { for (const x of v) keyPaths(root, x, out); return out; }
  if (v && typeof v === 'object') {
    // A key sent as null is still sent: it is checked like any other (only undefined, which JSON drops, is not).
    for (const [k, x] of Object.entries(v)) if (x !== undefined) keyPaths(root ? `${root}.${k}` : k, x, out);
  }
  return out;
}

/** The fields (FIELDS) a job may send: what Settings lists for it. */
export function fieldsOf(job: JobName): Set<Field> {
  return new Set(Object.values(JOBS[job].sends));
}

/** True when the input carries a person's takeaway (only proposeLinks sends them, from library/ai-context.ts). */
export function holdsTakeaways<J extends JobName>(job: J, input: JobIO[J][0]): boolean {
  if (job !== 'proposeLinks') return false;
  return (input as ProposeLinksIn).readBooks.slice(0, SEND.readBooks).some((b) => Boolean(line(b.takeaway, SEND.takeaway)));
}

export const JOBS: { [J in JobName]: Spec<JobIO[J][0], JobIO[J][1]> } = { extractTitles, tagBook, proposeLinks, suggestNext, explainPick, checkRedundant };
