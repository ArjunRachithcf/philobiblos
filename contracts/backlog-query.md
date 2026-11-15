# Backlog query language (GitHub-style)

The Backlog has one filter bar. A query is space-separated terms; quoted values may contain spaces. Terms are ANDed.
A leading `-` negates a qualifier. Free words match title and author. Unknown qualifiers are returned in `queryErrors`
and ignored (never a 500). Clicking any label in the list appends its qualifier, replacing an existing one of the same key.

| Qualifier | Values | Example |
|---|---|---|
| `is:` | `open` (default), `closed`, `adult`, `kids`, `fiction` | `is:closed` |
| `for:` | a person's handle (`alex`, `partner`, `kid1`), or `me` | `for:me` |
| `move:` | `deepen`, `connect`, `broaden`, `counterpoint`, `wildcard`, `intro`, `fiction` | `move:connect` |
| `idea:` | an idea name (substring) | `idea:"markets and value"` |
| `layer:` | `intro`, `core`, `deep`, `counterpoint` | `layer:core` |
| `theme:` | a kids' theme (substring) | `theme:friendship` |
| `source:` | `instagram`, `wishlist`, `to-buy`, `ai`, `manual` | `source:instagram` |
| `by:` | who added it (person handle) | `by:partner` |
| `author:` | substring | `author:okafor` |
| `score:` `price:` `links:` | number with `<`, `<=`, `>`, `>=` or exact | `score:>50 price:<25` |
| `added:` | age, `<30d`, `>90d` | `added:>90d` |
| `reason:` | closed reason: `not-for-me`, `snoozed`, `owned`, `repeats`, `picked` | `is:closed reason:repeats` |
| `sort:` | `score` (default), `links`, `price`, `added`, `title`; suffix `-asc`/`-desc` | `sort:price-asc` |

Saved filters are per person (`/backlog/saved-filters`). Defaults: "To buy now" `is:open is:adult score:>40`,
"Kids" `is:open is:kids`, "Cheap & good" `is:open score:>30 price:<25`, "From Instagram" `is:open source:instagram sort:added`.

The parser lives in `packages/contracts` (shared by server and web), with tests for every row above, quoting, negation,
and error recovery. The server answers with `facets` (counts per value for for/move/idea/source) to fill the dropdowns.
