# ADR 0005: Knowledge model

Status: **Accepted** · 2026-11-15

**Decision**: Adults have a brain of ideas; books contribute to ideas at layers (intro, core, deep, counterpoint).

- Density of an idea = books read in it (loved/takeaway may weigh later). Rings = layers filled.
- Edges between ideas = read books tagged with both; thickness = count.
- Moves: Deepen (fill a layer), Connect (bridge two dense ideas), Broaden (start an idea), Counterpoint, Wildcard.
- Only `read` books add density; `reading` glows; owned-unread is an outline. Unread pile limits picks.
- Idea vocabulary is shared by the household and curated by the AI with merge/rename by people.
- Proposals (the AI's, the seed's guesses) stay proposals until a person confirms or rejects them
  (`PUT /links/{from}/{to}`, `PUT /books/{book}/ideas/{idea}`); the reviewer and the time are recorded. What counts for
  scores and the brain is spec §6's rule: confirmed, or proposed with confidence ≥ 0.8; rejected never counts.
- A proposal from an AI run whose input held someone's takeaways (`ai_run.takeaways_of`) is that person's: only they
  see its reason and decide it; everyone else sees a neutral reason where the link shows (shelf#3).
