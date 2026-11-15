// A provider for tests: deterministic, offline, every output valid against contracts/ai/*.schema.json.
import extractTitlesFixture from '../../../contracts/ai/fixture.extract_titles.json' with { type: 'json' };
import type { ExtractTitlesOut, ProposeLinksOut, SuggestNextOut, TagBookOut } from '@shelf/contracts';
import { EXPLAIN_MAX, type AiProvider, type CheckRedundantIn, type ExplainPickIn, type ProposeLinksIn, type SuggestNextIn, type TagBookIn } from './provider';

export interface FakeFixtures {
  extractTitles: ExtractTitlesOut;
  tagBook: TagBookOut;
  proposeLinks?: ProposeLinksOut;
  suggestNext: SuggestNextOut;
}

/** contracts/ai/ has a fixture for extractTitles only; the others are small made-up outputs. */
export const DEFAULT_FIXTURES: FakeFixtures = {
  extractTitles: extractTitlesFixture as ExtractTitlesOut,
  tagBook: { audience: 'adult', isFiction: false, ideas: [{ name: 'Parenting', layer: 'intro', confidence: 0.9 }] },
  suggestNext: {
    suggestions: [{ title: 'An Example Book', author: 'A. Writer', move: 'deepen', idea: 'Parenting', why: 'Fills the core layer of Parenting.' }],
  },
};

export class FakeProvider implements AiProvider {
  readonly id = 'fake' as const;
  readonly model = 'fake-1';
  readonly supportsVision = true;
  readonly calls: { job: string; input: unknown }[] = [];

  constructor(private readonly fixtures: FakeFixtures = DEFAULT_FIXTURES) {}

  private log(job: string, input: unknown) { this.calls.push({ job, input }); }

  async extractTitles(i: unknown) { this.log('extractTitles', i); return structuredClone(this.fixtures.extractTitles); }
  async tagBook(i: TagBookIn) { this.log('tagBook', i); return structuredClone(this.fixtures.tagBook); }
  async proposeLinks(i: ProposeLinksIn): Promise<ProposeLinksOut> {
    this.log('proposeLinks', i);
    if (this.fixtures.proposeLinks) return structuredClone(this.fixtures.proposeLinks);
    // One link to each read book sharing an idea with the candidate.
    const names = new Set(i.candidate.ideas.map((t) => t.name));
    return {
      links: i.readBooks
        .filter((b) => b.ideas.some((t) => names.has(t.name)))
        .map((b) => ({ toBookId: b.id, reason: `Shares an idea with ${b.title}`.slice(0, 120), confidence: 0.85 })),
    };
  }
  async suggestNext(i: SuggestNextIn): Promise<SuggestNextOut> {
    this.log('suggestNext', i);
    const s = this.fixtures.suggestNext.suggestions.filter((x) => i.wildcards || x.move !== 'wildcard');
    return { suggestions: s.slice(0, Math.min(i.max, 3)) };
  }
  async explainPick(i: ExplainPickIn) {
    this.log('explainPick', i);
    const why = i.buildsOn.length ? `${i.move}: builds on ${i.buildsOn.join(', ')} in ${i.idea}` : `${i.move} in ${i.idea}`;
    return { why: why.slice(0, EXPLAIN_MAX) };
  }
  async checkRedundant(i: CheckRedundantIn) { this.log('checkRedundant', i); return {}; }
}
