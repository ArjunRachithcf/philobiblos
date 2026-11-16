# ADR 0008: Price lookup

> Written when the app was called **Shelf**; it is **Philobiblos** since 2026-11-16 (philobiblos#30). This record is
> kept as decided: read Shelf as Philobiblos, `SHELF_*` as `PHILOBIBLOS_*` and `shelf_session` as `philobiblos_session`;
> a shelf of books is still a shelf.

Status: **Accepted** · 2026-11-15

**Decision**: Prices are estimates from a read-only lookup; the bookshop's quote is the truth.

- Orell Füssli has no public API. Lookup = their search page, rate-limited (1 req/3 s), cached 7 days, behind a
  `PriceSource` interface so it can be swapped or turned off. Unknown price → CHF 25.
- Website availability is informational only: the English Bookshop sources any book by email.
