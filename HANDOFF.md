# Shelf: handoff to Claude Code

Shelf is a self-hosted app that decides **what to read next** so that a person's knowledge grows in breadth and depth, and
turns that into a **monthly book order** within a family budget. It ships as a **HomersLab app** and also runs **standalone**
with `docker compose up`.

**Kickoff prompt for Claude Code** (paste it in the empty repo with this folder unzipped at the root):

> Read HANDOFF.md, docs/spec.md, docs/adr/ and contracts/. Then do milestone M0 exactly as listed in HANDOFF.md:
> create the monorepo, migrations from contracts/schema.sql, the seed importer, typed stubs for every route in
> contracts/openapi.yaml with contract tests, the backlog query parser with tests for every row of
> contracts/backlog-query.md, the AiProvider interface with a fake provider, packages/scoring passing
> contracts/scoring-vectors.json, Dockerfile + docker-compose.yml + the HomersLab manifest, and CI.
> Don't build UI beyond a health page. Ask me before changing any contract; list open questions at the end.

This folder is the starting point for the repository. Read in this order:

1. `docs/spec.md`: what Shelf does, screen by screen, and the rules
2. `docs/adr/`: decisions already taken (and the two still open)
3. `contracts/`: the database schema, the HTTP API, the AI plugin, the connectors, the HomersLab manifest
4. `design/`: the design decisions to keep (`design/README.md`); the clickable canvas is kept privately for now
5. `seed/`: the household's real data to import on first start (private, gitignored); `seed-sample/` is a made-up set with the same shapes, used by tests and CI

## Your first task (milestone M0: repo and contracts)

Create the repository and make the contracts real and testable, without building features yet:

- [x] Monorepo layout from `docs/adr/0002-stack.md` (`apps/server`, `apps/web`, `packages/contracts`, `packages/scoring`)
- [x] `contracts/schema.sql` → migrations (Drizzle), plus `seed/` importer (`pnpm seed`)
- [x] `contracts/backlog-query.md` → the GitHub-style query parser in `packages/contracts`, tested row by row
- [x] `contracts/openapi.yaml` → generated TypeScript types in `packages/contracts`; server routes stubbed and returning
      the example payloads; a contract test that every route matches the spec
- [x] `contracts/ai/*.schema.json` → the `AiProvider` interface (`contracts/ai-plugin.md`) with a **fake provider**
      that returns the fixtures, and empty `claude` and `ollama` adapters
- [x] `packages/scoring`: the pure functions in `docs/spec.md` §6, with the test vectors in `contracts/scoring-vectors.json`
      passing (produced by the prototype's scorer, with invented titles; the real ones stay in the private seed)
- [x] `contracts/homerslab-app.yaml` and `docker-compose.yml` that start the stubbed app either way
- [ ] CI: typecheck, lint, unit and contract tests

Out of scope for M0: real mail, real AI calls, the UI beyond a health page. Security first: ADR 0009, `docs/security.md`.

Milestones after M0 are in `docs/spec.md` §10.

## What exists today (the prototype, keep it running until M2)

- A published page with the current picks and backlog (its link and template are kept privately, outside the repository)
- Two Claude scheduled tasks: a daily Instagram catch-up and a monthly refresh. Shelf replaces both at M3.
- The Python script in `seed/reference_scoring_v0.py` is that prototype's scoring. It's the reference, not the design to copy.

## Conventions from HomersLab

- Decisions live in `docs/spec.md` and numbered ADRs; screens in the design canvas (private until it carries invented data).
- People come from the HomersLab household (adults, kids, ages); standalone has its own minimal household.
- Look: HomersLab `tokens.css` (teal accent, Apple glass over the wallpaper, springs, dark mode); copy, never edit, the
  design system into `apps/web/src/design/`.
- Every word meets WCAG 2.2 AA on glass at every glass level; reduced motion and transparency are honoured.
- No network on page render: all book data, covers and the map are stored locally.
