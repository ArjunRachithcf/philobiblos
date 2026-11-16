// The fake provider's outputs, and the fixture in contracts/ai/, validate against contracts/ai/*.schema.json.
import { describe, expect, it } from 'vitest';
import { validateAiOutput, AI_SCHEMAS } from '@shelf/contracts';
import fixture from '../../../contracts/ai/fixture.extract_titles.json' with { type: 'json' };
import { FakeProvider, EXPLAIN_MAX } from '../src';

const book = { id: 'b1', title: 'A Book', authors: ['A. Writer'] };

describe('contracts/ai', () => {
  it('every schema compiles and the extractTitles fixture is valid', () => {
    expect(Object.keys(AI_SCHEMAS).sort()).toEqual(['checkRedundant', 'explainPick', 'extractTitles', 'proposeLinks', 'suggestNext', 'tagBook']);
    expect(validateAiOutput('extractTitles', fixture)).toEqual({ ok: true, errors: [] });
  });
  it('invalid output is rejected with a reason', () => {
    const r = validateAiOutput('tagBook', { audience: 'teens' });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(validateAiOutput('suggestNext', { suggestions: Array(4).fill({ title: 't', author: 'a', move: 'deepen', idea: 'i', why: 'w' }) }).ok).toBe(false);
  });
});

describe('FakeProvider', () => {
  const ai = new FakeProvider();
  it('extractTitles returns the fixture', async () => {
    const out = await ai.extractTitles({ images: [] });
    expect(out).toEqual(fixture);
    expect(validateAiOutput('extractTitles', out).ok).toBe(true);
  });
  it('tagBook, proposeLinks and suggestNext validate', async () => {
    expect(validateAiOutput('tagBook', await ai.tagBook({ book, ideaVocabulary: [], kidsThemes: [] })).ok).toBe(true);
    const links = await ai.proposeLinks({
      candidate: { ...book, ideas: [{ name: 'Value', layer: 'core', confidence: 0.9 }] },
      readBooks: [{ id: 'b2', title: 'Other', ideas: [{ name: 'Value', layer: 'intro', confidence: 1 }] }, { id: 'b3', title: 'Unrelated', ideas: [] }],
    });
    expect(links.links.map((l) => l.toBookId)).toEqual(['b2']);
    expect(validateAiOutput('proposeLinks', links).ok).toBe(true);
    const next = await ai.suggestNext({ brain: { ideas: [] }, backlogTitles: [], owned: [], wildcards: false, max: 3 });
    expect(validateAiOutput('suggestNext', next).ok).toBe(true);
  });
  it('explainPick stays within 140 characters', async () => {
    const { why } = await ai.explainPick({ pick: book, move: 'connect', buildsOn: Array(30).fill('A Long Title Here'), idea: 'Value' });
    expect(why.length).toBeLessThanOrEqual(EXPLAIN_MAX);
  });
  it('records its calls', () => {
    expect(ai.calls.map((c) => c.job)).toContain('extractTitles');
  });
});
