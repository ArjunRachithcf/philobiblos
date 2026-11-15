# ADR 0004: Ai proposes rules decide

Status: **Accepted** · 2026-11-15

**Decision**: The AI extracts, tags, links, suggests and explains. Scores and picks come only from `packages/scoring`.

- Keeps picks predictable, testable and cheap; switching provider never changes the maths.
- Every AI output is stored with provider, model, prompt version and confidence. Links below 0.8 confidence count only
  after a person confirms them. People can reject any AI link; rejected links are never re-proposed for that pair.
