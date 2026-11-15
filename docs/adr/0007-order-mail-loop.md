# ADR 0007: Order mail loop (IMAP, Compose)

Status: **Accepted** · 2026-11-15 (revised the same day: no Gmail API, see "Changed")

**Decision**: Shelf reads the bookshop's mail from a **Shelf-only mailbox over IMAP** and never sends mail. Orders go
out through a **Compose** action: a `mailto:` link with the text filled in, opened in the person's own mail app.

- The person adds a filter in their own mail account that forwards only the bookshop's mail to that mailbox. Shelf never
  sees the rest of their mail and holds no token to their account.
- IMAP: TLS only, an app password stored as a secret (never in the database, API, UI or logs), read-only: Shelf never
  deletes, moves or flags a message.
- Every mail is hostile input: the bookshop's sender and its DKIM (or the forwarder's ARC result for it) must pass
  before a mail has any effect; links in mail are never followed; PDFs are parsed in the media worker
  (`contracts/connectors.md`, ADR 0009).
- Parsers (versioned, with anonymised fixtures): English Bookshop quote replies, online order confirmations,
  click & collect confirmations, invoice PDFs (line items: EAN, title, qty, price).
- Matching: EAN first, then normalised title + author. Unmatched lines go to the Inbox for a person to resolve.
- **Changed** (2026-11-15): the first version used the Gmail API with `gmail.readonly` and `gmail.compose` per adult.
  A `gmail.readonly` token reads a person's whole mailbox, and a leak of the server would leak it; `gmail.compose` can
  write drafts in their name. A forwarding filter plus a dedicated mailbox limits what Shelf can ever see to the
  bookshop's mail, and a mailto link needs no permission at all. Security comes first (ADR 0009).
