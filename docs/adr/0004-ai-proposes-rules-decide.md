# ADR 0004: Ai proposes rules decide

> Written when the app was called **Shelf**; it is **Philobiblos** since 2026-11-16 (philobiblos#30). This record is
> kept as decided: read Shelf as Philobiblos, `SHELF_*` as `PHILOBIBLOS_*` and `shelf_session` as `philobiblos_session`;
> a shelf of books is still a shelf.

Status: **Accepted** · 2026-11-15

**Decision**: The AI extracts, tags, links, suggests and explains. Scores and picks come only from `packages/scoring`.

- Keeps picks predictable, testable and cheap; switching provider never changes the maths.
- Every AI output is stored with provider, model, prompt version and confidence. Links below 0.8 confidence count only
  after a person confirms them. People can reject any AI link; rejected links are never re-proposed for that pair.
