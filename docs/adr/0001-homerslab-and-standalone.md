# ADR 0001: Homerslab and standalone

> Written when the app was called **Shelf**; it is **Philobiblos** since 2026-11-16 (philobiblos#30). This record is
> kept as decided: read Shelf as Philobiblos, `SHELF_*` as `PHILOBIBLOS_*` and `shelf_session` as `philobiblos_session`;
> a shelf of books is still a shelf.

Status: **Accepted** · 2026-11-15

**Decision**: Shelf ships as a HomersLab catalog app and as a standalone Docker Compose app.

- **Context**: some households run HomersLab; others do not.
- **Decision**: One container image. A `SHELF_MODE` of `homerslab` or `standalone` selects identity and backups:
  - `homerslab`: sign-in, household (people, kids, ages), backups and the address come from HomersLab via the manifest
    (`contracts/homerslab-app.yaml`). Shelf trusts the forwarded identity header from the HomersLab proxy only.
  - `standalone`: Shelf's own passkey sign-in, a minimal household editor, SQLite file + `/data` volume to back up.
- **Consequences**: identity behind an interface (`HouseholdProvider`); no HomersLab-only features in core screens.
