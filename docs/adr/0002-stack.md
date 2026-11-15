# ADR 0002: Stack

Status: **Accepted** · 2026-11-15 (confirmed by the maintainer on 2026-11-15)

**Decision**: TypeScript end to end: Node 22 + Fastify, SQLite via Drizzle, React + Vite, pnpm monorepo.

- **Why**: HomersLab's components are React (its ADR 0002); one language for contracts and scoring; SQLite fits a
  family-sized dataset and HomersLab backups.
- **Layout**: `apps/server` (Fastify, jobs, connectors), `apps/web` (React, HomersLab tokens), `packages/contracts`
  (OpenAPI types, AI schemas), `packages/scoring` (pure functions, no I/O), `packages/ai` (providers).
- **Jobs**: in-process scheduler (croner) with a jobs table for runs and retries; no external queue.
- **PDF**: `pdfjs-dist` for invoice text. **Images**: `sharp` for thumbnails and frame grabs (ffmpeg for video frames).
  All three run only in the media worker, never in the server process (ADR 0009).
- **Confirmed** 2026-11-15: TypeScript end to end (Node 22 + Fastify, SQLite via Drizzle, React + Vite, pnpm).
