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

Every job's output has a schema in `ai/`: `explain_pick.schema.json` (`why`, at most 140 characters) and
`check_redundant.schema.json` (`repeats`, the id of an owned book from the input, and a `reason`) joined the four in M3 g.

Prompts are versioned files in `packages/ai/prompts/<job>.v<N>.md`. Every call stores provider, model, prompt
version, input hash, output, cost. Identical input hash + prompt version reuses the stored output (cache); the hash
covers the provider, the model and the whole prompt, and a stored output is reused only for the same person (and the
same `takeaways_of`), and only after it validates again.

**Underneath** (`packages/ai/src/provider.ts`): a provider is a `Model`, one call that takes the prompt and answers
text, and reaches its host only through a `Transport` the server hands it (its egress client, held to that one host).
The server's runner (`apps/server/src/ai/run.ts`) builds the prompt, keeps the cache and the log, validates, cleans
(`packages/ai/src/jobs.ts`: ids only from the input, one-line texts, Shelf's own decisions), retries once and keeps a
per-run budget of calls and tokens. Ollama: `POST /api/chat`, not streamed, the schema as `format`, temperature 0.
Claude: the Messages API (`anthropic-version: 2026-10-21`), `claude-opus-5-5` unless Settings names another `claude-…`
model, structured output (`output_config.format`), adaptive thinking at low effort; a refusal or a cut-off answer is no
answer. Neither is ever offered a tool.

**The prompt**: the system message is the prompt file. The user message holds Shelf's own data (ids, numbers, the
household's idea names and themes, settings) as JSON in an `<input>` block, and each text from outside Shelf (a share's
caption and link, a book's title and authors, a blurb, a takeaway) in an `<untrusted source="…">` block, JSON with `<`,
`>` and `&` escaped, so that nothing inside can end the block.

Privacy: with Ollama nothing leaves the home network. With Claude (opt-in), what leaves is exactly what Settings lists
(`Settings.ai.leaves`), to `api.anthropic.com` only. The list is built from the fields each turned-on job's requests may
hold (`FIELDS` and each job's `sends` in `packages/ai/src/jobs.ts`), and `buildPrompt` refuses a request holding a key
its job does not list, so the two cannot drift. It says what that means: each request is one person's (one adult's
read books, up to 60, with their takeaways if they turned them on; one adult's reading map with their backlog's titles;
one adult's pick with the read books it builds on), without their name, plus the books themselves, the household's idea
names, owned titles and shared posts. Turning Claude on is an admin's request with `acceptLeaves: true`; the accepted
lines are stored, and while the list holds a line they do not (a job turned on, a newer Shelf that sends more), Claude
is not called until an admin accepts again. The API key is sealed like the delivery address and never answered back. A
person's takeaways reach no AI, Ollama included, unless that person turns on `takeawaysToAi` (off by default;
`apps/server/src/library/ai-context.ts` is the one place that hands them out). Names of people and kids and the delivery
address never leave.

**Where the output goes** (`apps/server/src/ai/jobs.ts`): `extractTitles` → the share's found books (the Inbox offers
them; without a vision model, the caption only, and the Inbox says so); `tagBook` → proposed book ideas (adults' books;
kids' themes and a book's audience or fiction flag are not written yet); `proposeLinks` → proposed links through
`knowledge/from-run.ts`; `checkRedundant` → a proposed `redundancy`, counted only once confirmed; `suggestNext` → the
person's own Inbox (`ai_suggestion`); `explainPick` → `order_line.why` of the kept plan. Admins run them as
`ai_suggest`, `ai_tag` and `ai_explain` (`POST /jobs/{job}/run`); shares are read after the media worker.

`tagBook`'s ideas: a name the household has is a proposed tag in that idea; any other name is kept on an
`idea_proposal` (a name, no idea row) and becomes an idea only when a person confirms it (`PUT /idea-proposals/{id}`).
No AI proposal counts in a brain or a score until a person confirms it, whatever its confidence (spec §6). Each run
reads only what its person may: book ideas private to someone else are left out, and a why built on a link or an idea
private to the pick's person is shown only to them (`order_line.why_audience`).

Spend: with Claude, every run together stays within the household's daily allowance (`Settings.ai.dailyLimit`, tokens in
any 24 hours, 200,000 by default; `usedToday` shows the use); a call that could go past it is not made. Shares are read
at most 20 a day per share token and 40 per person.

