# AI plugin contract

One TypeScript interface, two providers (Ollama, Claude) and a fake for tests. Jobs take structured input and must
return JSON that validates against `ai/<job>.schema.json`; invalid output is retried once, then the job fails and is
logged in `ai_run`. The AI never writes scores or picks (ADR 0004).

**Ollama is the default** for a new household (`household_settings.ai_provider = 'ollama'`). Claude is an explicit
opt-in in Settings, which shows exactly what leaves the server before it is turned on (below).

**AI output is data only** (ADR 0009): it is schema-validated and stored; it never triggers an action, a request or a
URL fetch, and its text is shown as plain text. A person confirms what it proposes. Inputs that come from mail, shares
or web pages are untrusted: prompts mark them as such (quoted, inside clearly delimited blocks, with the instruction to
treat them as data), and nothing in them can change the job, the schema or the provider.

```ts
export interface AiProvider {
  id: 'claude' | 'ollama' | 'fake';
  model: string;
  supportsVision: boolean;
  extractTitles(i: { images: Image[]; caption?: string; url?: string }): Promise<ExtractTitlesOut>;
  tagBook(i: { book: BookRef; blurb?: string; ideaVocabulary: string[]; kidsThemes: string[] }): Promise<TagBookOut>;
  proposeLinks(i: { candidate: BookRef & { ideas: IdeaTag[] }; readBooks: (BookRef & { ideas: IdeaTag[]; takeaway?: string })[] }): Promise<ProposeLinksOut>;
  suggestNext(i: { brain: BrainSummary; backlogTitles: string[]; owned: string[]; wildcards: boolean; max: number }): Promise<SuggestNextOut>;
  explainPick(i: { pick: BookRef; move: Move; buildsOn: string[]; idea: string }): Promise<{ why: string }>; // ≤ 140 chars
  checkRedundant(i: { candidate: BookRef; owned: BookRef[] }): Promise<{ repeats?: string; reason?: string }>;
}
```

| Job | When | Input size | Notes |
|---|---|---|---|
| `extractTitles` | a share arrives | all images / video frames (every ~2 s, max 30) | needs vision; Ollama uses a vision model; if none, captions only and the Inbox says so |
| `tagBook` | a book is added | title, authors, blurb from metadata | ideas from the household vocabulary first; may propose a new idea name |
| `proposeLinks` | after tagging | the person's read books in the same or adjacent ideas (≤ 60) | each link with reason (≤ 120 chars) and confidence 0–1 |
| `suggestNext` | monthly job | brain summary (ideas, layers, gaps) | ≤ 3 per person; may include 1 wildcard; never owned or in backlog |
| `explainPick` | after picks | one pick | plain words, no hype |
| `checkRedundant` | after tagging | owned books in the same idea | e.g. a summary of a book already read |

Prompts are versioned files in `packages/ai/prompts/<job>.v<N>.md`. Every call stores provider, model, prompt
version, input hash, output, cost. Identical input hash + prompt version reuses the stored output (cache).

Privacy: with Ollama nothing leaves the server. With Claude (opt-in), only book metadata, idea names and shared images
leave it. A person's takeaways reach no AI, Ollama included, unless that person turns on `takeawaysToAi` (off by
default; `apps/server/src/library/ai-context.ts` is the one place that hands them out). Settings shows
this list (`Settings.ai.leaves`) before the opt-in and while Claude is on. Names of people and kids never leave.
