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
- A link or book idea the AI writes from someone's takeaways carries `private_to` (independent of the run, so a purge
  keeps it): only that person sees its reason and decides it; for everyone else it does not exist as a proposal (404,
  the same as a missing one), and where a decided one shows (the Backlog's "builds on") the reason is a neutral one.
  Turning `takeawaysToAi` off deletes the undecided ones and replaces the decided ones' reasons with the neutral one.
- A merge changes no book's rows and so decides nothing: the merged idea points at the one it went into (one step;
  ideas merged into it are re-pointed), and readers resolve it (`knowledge/tags.ts`). When a book has rows on both, the
  stronger decision is the book's (confirmed over proposed over rejected). Any adult may merge; the merge log keeps who
  and when, and an admin can undo a merge.
