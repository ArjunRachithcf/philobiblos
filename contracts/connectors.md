# Connectors

All connectors implement `Connector { id; check(): Health; run(since): RunResult }`, run from the job scheduler,
log to `job_run`, and are idempotent (`mail_seen`, input hashes).

## Mail over IMAP (ADR 0007)

No Gmail API and no Google token. The person sets up a filter in their own mail account that forwards **only** the
bookshop's mail (from `orellfuessli.ch`) to a mailbox used by Shelf and nothing else. Shelf reads that mailbox over
IMAP: TLS only (port 993, certificate verified, no STARTTLS downgrade, no plain auth without TLS), an app password kept
as a secret (`SHELF_IMAP_PASSWORD`, never in the database, the API or logs), read-only (`EXAMINE`, never `STORE`,
`MOVE`, `EXPUNGE` or delete; `mail_seen` keeps what was read). New messages after the last run, by UID.

**Every mail is hostile input.** Forwarded mail can be spoofed, so before a mail has any effect:

- the original sender (the forwarded `From`, exactly one address, and `Sender` where present) must be the bookshop's
  domain; `Return-Path` is not checked, because a forwarding filter rewrites it to the forwarder (SRS) (M3 c);
- the DKIM signature of the bookshop's domain must pass, or, for a forward that broke it, the `ARC-Authentication-Results`
  of the forwarding provider must show `dkim=pass` for that domain; a mail that fails, or has neither, is stored with
  `accepted = 0` and shown in the Inbox as "not verified", and changes nothing (and none of its content is kept). The
  forwarding providers whose ARC seal counts are `SHELF_MAIL_ARC_SEALERS` (default `google.com`); DNS is asked only for
  DKIM key records (`<selector>._domainkey.<domain>`, a few per mail), never SPF, DMARC or anything a mail names;
- what is kept of a verified mail is the bookshop's own words: quoted lines and everything below a reply header are
  dropped (the household's request, with its delivery address and card number, is quoted in the replies), and runs of
  12 or more digits that are not an ISBN/EAN are masked;
- links in mail are never followed, fetched or shown as clickable; images are not loaded;
- bodies are parsed as text with size limits (1 MB per mail, 10 MB per attachment, only `application/pdf` attachments
  are read); PDFs are parsed in the media worker (ADR 0009), never in the server process;
- what the parsers extract only proposes changes to Shelf's own records (prices, quote states, copies); it never
  creates people, settings or outgoing mail.

Parsers are versioned (`parserVersion`) and tested against anonymised fixtures (to be added from real mails with
address, card and customer numbers removed; real ones stay out of the repository).

| Kind | How to recognise | What to extract | Effect |
|---|---|---|---|
| `bookshop_request` | the person's request, when they keep Shelf's address in Bcc (the Compose link adds it) | Message-ID | ties the replies to the order (`mail_thread_ref`) |
| `bookshop_quote` | reply from english-orders@ with prices | per title: ISBN, price, delivery; "not in stock / backorder" | order lines quoted / unavailable; order total = quote |
| `bookshop_confirm` | "We have now ordered…", order number | order number | order status drafted → quoted |
| `online_order` | subject "Ihre Orell Füssli Bestellung (n)" | items: title, author, price; skip non-books (Spielwaren) | order + lines |
| `click_collect` | "Wir bearbeiten Ihre Bestellung (n)" | "Buch <title> von <author> EAN: <ean> \| Fr. <price>" | order + lines |
| `invoice` | "Ihre OrellFüssli-Rechnung Nr. n" + PDF | PDF rows: `EAN  Title  qty ST  price  [discount %]  total CHF  VAT %` | copies (owned); order invoiced |

Quote formats seen (all must parse):
- `Author: X / Title: Y / ISBN: n / Price: CHF 19.90 / Delivery due: 3 – 4 days` blocks
- `Paulsen, The Quiet Hedgehog / ISBN: n / Price. CHF 16.90 / delivery due: 2-3 days`
- one line per book: `- Okafor, Value Beyond Price, CHF 18.90, delivery time 1-3 days`

**Compose** (instead of drafts): Shelf builds a `mailto:` link to english-orders@orellfuessli.ch with the subject and
the text filled in, in the person's style ("Dear English Bookshop Team, … Premium Card number: … delivered to:
{address}"), and Shelf's mailbox in Bcc. The person's own mail app opens it; Shelf never sends. **Shelf never stores
the card number**: the text leaves "Premium Card number: " for the person to fill in. The delivery address is sealed
at rest with a key outside the database (`sealed_secret`, ADR 0009).

## Price lookup (ADR 0008)

`PriceSource` interface. Orell Füssli implementation: GET `https://www.orellfuessli.ch/suche?sq=<title author>`,
parse result tiles (title, author, format "Buch (Taschenbuch|Gebundene Ausgabe)", "Fr. 24.90", availability text,
article id from `/shop/home/artikeldetails/A…`). Choose the English print edition whose normalised title matches.
1 request / 3 s, cache 7 days, User-Agent identifies Shelf. Read-only: never touches wishlist, cart or account.
The page is hostile input: 2 MB and 10 s at most, no redirects off the host, parsed as text (no script runs), and only
the fields above are kept.

## Metadata

Open Library by ISBN or title+author → subjects, description, cover (downloaded once to `/data/covers`). Cached forever,
refreshable by hand. Responses are limited (1 MB JSON, 5 MB image, 10 s); covers are decoded and re-encoded by the media
worker before they are stored, so no original file is ever served. Covers come from `covers.openlibrary.org`, which redirects to
the Internet Archive (`archive.org`, then a data node `ia<number>.us.archive.org`): the only redirects to another host
the client follows (ADR 0009).

All outgoing requests go through one HTTP client that allows only the hosts in the manifest's egress list (ADR 0009).

## Phone share (ADR 0006)

- Android: the web app is a PWA with `share_target` (POST multipart to `/api/shares`, url + text + files).
- iOS: a Shortcut "Send to Shelf" posting the same multipart with a per-person share token (`Authorization: Bearer`),
  created in Settings and shown once with a QR code. The token is stored hashed, can be revoked, and is write-only: it
  is accepted by `POST /api/shares` and nothing else (ADR 0009).
- A share carries images, the link and the caption. Shelf never logs in to Instagram and never holds an Instagram
  session (ADR 0006); the link is stored as text and fetched only through oEmbed without a login, if at all.
- Media are size-limited (20 MB per file, 30 files), type-checked by content, and processed in the media worker.
- The server stores media, queues `extractTitles`, and the share screen polls `/api/shares/{id}` for progress.

## Wishlist import (one-off, optional)

Seed already contains the Orell Füssli wishlist and "To buy" list as of 2026-11-15 (`seed/wishlist.json`, `tobuy` flag).
A later importer may read a logged-in wishlist export if the person provides one; Shelf does not log in to retailers.
