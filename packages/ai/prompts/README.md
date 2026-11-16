Prompts are versioned files `<job>.v<N>.md` (contracts/ai-plugin.md). A prompt is never edited once released: a change
is a new file with the next version, and `JOBS` in `src/jobs.ts` names the version in use. The version is part of every
`ai_run` row and of the cache key, so a new version never reuses an old answer.

Every prompt is the system message. The user message is built by `src/prompt.ts`: the job's input as JSON in an
`<input>` block, and each text from outside Philobiblos (a caption, a mail, a PDF, a web page) in its own
`<untrusted source="…">` block, JSON-encoded with `<` and `>` escaped so that nothing inside can close the block.
