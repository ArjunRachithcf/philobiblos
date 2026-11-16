# ADR 0003: Local first data

> Written when the app was called **Shelf**; it is **Philobiblos** since 2026-11-16 (philobiblos#30). This record is
> kept as decided: read Shelf as Philobiblos, `SHELF_*` as `PHILOBIBLOS_*` and `shelf_session` as `philobiblos_session`;
> a shelf of books is still a shelf.

Status: **Accepted** · 2026-11-15

**Decision**: All book data, covers, ideas and links are stored locally. External services are optional enrichment.

- Lesson from other self-hosted trackers: pages that query Open Library live break offline.
- Metadata and covers are fetched once, cached in SQLite and `/data/covers`. Pages never call the network.
- AI and price lookups degrade gracefully: missing → last known value, flagged as stale.
