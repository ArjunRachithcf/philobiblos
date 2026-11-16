# ADR 0007: Order mail loop (IMAP, Compose)

> Written when the app was called **Shelf**; it is **Philobiblos** since 2026-11-16 (philobiblos#30). This record is
> kept as decided: read Shelf as Philobiblos, `SHELF_*` as `PHILOBIBLOS_*` and `shelf_session` as `philobiblos_session`;
> a shelf of books is still a shelf.

Status: **Accepted** · 2026-11-15 (revised the same day: no Gmail API, see "Changed")

> **Superseded in part** (2026-11-16, ADR 0011): "never sends mail" now has one exception. Standalone Philobiblos
> may send a 6-digit code for a join rule's mail domain, through an optional outgoing SMTP server that is off by default.
> Orders still go out only through Compose, and nothing else is ever sent.

> **Superseded in part** (2026-11-16, philobiblos#27): "the bookshop" is any enabled connector's
> (`docs/connectors.md`): its domains, senders and words are data an admin enables; the checks below are unchanged and
> apply to each.

**Decision**: Shelf reads the bookshop's mail from a **Shelf-only mailbox over IMAP** and never sends mail. Orders go
out through a **Compose** action: a `mailto:` link with the text filled in, opened in the person's own mail app.

- The person adds a filter in their own mail account that forwards only the bookshop's mail to that mailbox. Shelf never
  sees the rest of their mail and holds no token to their account.
- IMAP: TLS only, an app password stored as a secret (never in the database, API, UI or logs), read-only: Shelf never
  deletes, moves or flags a message.
- Every mail is hostile input: the bookshop's sender and its DKIM (or the forwarder's ARC result for it) must pass
  before a mail has any effect; links in mail are never followed; PDFs are parsed in the media worker
  (`contracts/connectors.md`, ADR 0009).
- **No mail text is stored** (2026-11-16, M3 c): only structured fields extracted from verified bookshop mail (order
  number, date, line items, totals, status) and the headers that tie a mail to an order. Free text always holds
  something of the household's in a spelling no filter catches; the mailbox itself keeps the mail, read-only, for a
  parser to read again. String fields still pass a filter (the sealed delivery address, long digit runs) as a second
  defence.
- Parsers (versioned, with invented fixtures; M3 d, 2026-11-16): English Bookshop quote replies and confirmations,
  online order confirmations, click & collect confirmations, invoice PDFs (line items: EAN, title, qty, price; rows
  from the media worker). Each is bounded and linear and fails closed on a layout it does not know (kept as
  `unknown_layout` with its version, changing nothing). Effects come only from verified mail, read again from the
  mailbox through every check; replies tie to a composed order by their signed Subject or In-Reply-To.
- Compose adds no Bcc and no card line (PR #14 review, 2026-11-16): the request goes to the bookshop alone, and the
  person adds the card number in their own mail app, so it never reaches Shelf or its mailbox. Web orders (online, click & collect) make no Shelf order; their invoice
  makes the copies.
- Matching: EAN first, then normalised title + author. Unmatched lines go to the Inbox for a person to resolve.
- **Changed** (2026-11-15): the first version used the Gmail API with `gmail.readonly` and `gmail.compose` per adult.
  A `gmail.readonly` token reads a person's whole mailbox, and a leak of the server would leak it; `gmail.compose` can
  write drafts in their name. A forwarding filter plus a dedicated mailbox limits what Shelf can ever see to the
  bookshop's mail, and a mailto link needs no permission at all. Security comes first (ADR 0009).
