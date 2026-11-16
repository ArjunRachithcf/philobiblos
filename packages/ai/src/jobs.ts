// What each job sends and what it may answer (contracts/ai-plugin.md, ADR 0009).
//
// - `split` is the job's data minimisation: it picks the fields the job needs, bounded, and says which are Shelf's own
//   (`data`) and which came from outside (`untrusted`, by source). Nothing else of the input reaches a provider.
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

/** How much of a list a job sends at most. */
export const SEND = { readBooks: 60, owned: 200, backlog: 300, ideas: 60, vocabulary: 200, blurb: 2000, caption: 5000, takeaway: 300, images: 30 } as const;

type Clean<O> = { ok: true; out: O } | { ok: false; error: string };
interface Spec<I, O> {
  prompt: string;
  version: number;
  maxTokens: number;
  split(i: I): { data: Record<string, unknown>; untrusted: [string, unknown][] };
  clean(o: O, i: I, images: number): Clean<O>;
}

const extractTitles: Spec<ExtractTitlesIn, ExtractTitlesOut> = {
  prompt: 'extract_titles', version: 1, maxTokens: 4096,
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
  prompt: 'tag_book', version: 1, maxTokens: 1024,
  split: (i) => ({
    data: { ideaVocabulary: i.ideaVocabulary.slice(0, SEND.vocabulary), kidsThemes: i.kidsThemes },
    untrusted: [['book', books(i.book)], ['blurb', line(i.blurb, SEND.blurb)]],
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
  split: (i) => ({
    data: { wildcards: i.wildcards, max: Math.min(i.max, 3), brain: { ideas: i.brain.ideas.slice(0, SEND.ideas).map((x) => ({ name: line(x.name, 60), readCount: x.readCount, layersFilled: x.layersFilled, gaps: x.gaps })) } },
    untrusted: [['owned', i.owned.slice(0, SEND.owned).map((t) => line(t, 300))], ['backlogTitles', i.backlogTitles.slice(0, SEND.backlog).map((t) => line(t, 300))]],
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
  prompt: 'explain_pick', version: 1, maxTokens: 512,
  split: (i) => ({ data: { move: i.move, idea: line(i.idea, 60) }, untrusted: [['book', books(i.pick)], ['buildsOn', i.buildsOn.slice(0, 10).map((t) => line(t, 300))]] }),
  clean(o) {
    const why = line(o.why, EXPLAIN_MAX);
    return why ? { ok: true, out: { why } } : { ok: false, error: 'an empty why' };
  },
};

const checkRedundant: Spec<CheckRedundantIn, CheckRedundantOut> = {
  prompt: 'check_redundant', version: 1, maxTokens: 512,
  split: (i) => ({ data: {}, untrusted: [['book', books(i.candidate)], ['owned', i.owned.slice(0, SEND.owned).map(books)]] }),
  clean(o, i) {
    const ids = new Set(i.owned.slice(0, SEND.owned).map((b) => b.id));
    ids.delete(i.candidate.id);
    const reason = line(o.reason, 120);
    // An id the input did not name repeats nothing.
    return { ok: true, out: o.repeats && ids.has(o.repeats) ? { repeats: o.repeats, ...(reason ? { reason } : {}) } : {} };
  },
};

/** True when the input carries a person's takeaway (only proposeLinks sends them, from library/ai-context.ts). */
export function holdsTakeaways<J extends JobName>(job: J, input: JobIO[J][0]): boolean {
  if (job !== 'proposeLinks') return false;
  return (input as ProposeLinksIn).readBooks.slice(0, SEND.readBooks).some((b) => Boolean(line(b.takeaway, SEND.takeaway)));
}

export const JOBS: { [J in JobName]: Spec<JobIO[J][0], JobIO[J][1]> } = { extractTitles, tagBook, proposeLinks, suggestNext, explainPick, checkRedundant };
