# Sample seed (made up)

Every book, author, person (and kids' birth year), price, article id and post here is invented. Same file shapes as the household's private `seed/` folder
(gitignored), so tests and CI can run the importer: `pnpm seed seed-sample`.

| File | Content | Imported as |
|---|---|---|
| `household.json` | people: name, handle, role, birth year (optional; placeholders are used without it) | person |
| `owned.json` | books owned: `title`, `author`, `src` | book + copy (source=seed) + reading (`read`) for the first adult |
| `wishlist.json` | `t` title, `a` author, `fmt`, `p` price text, `av` availability, `d` added (dd.mm.yy), `id` article id, `tobuy` | book + book_offer + candidate (wishlist or to_buy) |
| `network.json` | candidate title → `[owned title, reason]` pairs | book_link (confirmed) |
| `curation.json` | `adultThreads` (→ ideas), `redundant` (title → reason), `kids` (title → topic) | idea, book_idea, book_theme |
| `topics.json` | kids' topic → theme of docs/spec.md §7 | book_theme |
| `cats_raw.json` | category → titles | fallback ideas; `Kids…` categories mark kids' books |
| `ig_carousel.txt` | `post | title | author` lines | share + candidate (origin=share) |
