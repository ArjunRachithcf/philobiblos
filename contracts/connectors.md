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
- it must be addressed (To or Cc) to the household (`SHELF_MAIL_RECIPIENTS`, or the mailbox itself), so a genuine
  bookshop mail to someone else cannot be replayed into Shelf;
- what Shelf reads from the headers must be what was signed: a header that may appear once appears once, the passing
  signature covers From, To, Subject, Date, Message-ID, MIME-Version and Content-Type (and Cc, Sender, Reply-To,
  In-Reply-To, References and Content-Transfer-Encoding when present) and no fewer instances than the mail has, and
  a signature over part of the body (`l=`) does not count;
- the DKIM signature of the bookshop's domain must pass, or, for a forward that broke it, the `ARC-Authentication-Results`
  of the forwarding provider must show `dkim=pass` for that domain; a mail that fails, or has neither, is stored with
  `accepted = 0` and shown in the Inbox as "not verified", and changes nothing (and none of its content is kept). The
  forwarding providers whose ARC seal counts are `SHELF_MAIL_ARC_SEALERS` (default `google.com`); DNS is asked only for
  DKIM key records (`<selector>._domainkey.<domain>`, a few per mail), never SPF, DMARC or anything a mail names;
- the header block must be strict RFC 5322 (every line a field, `name:` of printable ASCII, or a continuation; no NUL,
  no lone CR, no other control character but tab, no continuation that is only white space, no encoded word in a
  name): a line a parser cannot read would end the headers there and turn the signed ones into body; and the
  Subject, Message-ID, From, Date and In-Reply-To the MIME parser read must equal those of the verified block;
- **no mail text is stored** (decided 2026-11-16, PR #12): a mail's free text always carries something of the
  household's (the delivery address, names, a card number quoted back) in more spellings than a filter can find. A
  verified mail keeps its Message-ID, In-Reply-To, date, subject (through the field filter below), how many PDFs it has
  and where it is in the mailbox (UIDVALIDITY, UID); the parsers read it again from the mailbox, in memory, and
  keep only structured fields: order number, date, line items (title, author, ISBN, quantity, price), totals and
  status. A mail is read again only by the UID kept for it under the same UIDVALIDITY (a renumbered folder is read
  afresh by the window instead), only if the mail there has the same signed Message-ID, and only through every check
  above once more (`openVerified`, the one way a mail is read). Every string field kept, the Message-ID and
  In-Reply-To too, passes a filter as a second defence: after NFKC and with format characters stripped, diacritics
  and their transliterations (ue, oe, ae) folded and `…str.` read as `…strasse`, a field holding a piece of the sealed
  delivery address (a line, a comma part, or a word of five letters or more, common street words aside), or a run of
  12 or more digits whatever separates them (other than an ISBN/EAN as the whole field), is dropped;
- only a verified mail claims its Message-ID (an unverified one is kept under a hash of its bytes, so a forgery cannot
  shadow the genuine mail); the first run reads the last 90 days, by UID SEARCH; when the checks' settings change, that
  window is read again;
- links in mail are never followed, fetched or shown as clickable; images are not loaded;
- MIME is parsed with limits (25 MB per mail, depth 8, 64 parts, 256 KB of headers, no nested message); only
  `application/pdf` attachments (by their bytes, 10 MB) are read, in the media worker (ADR 0009), never in the server;
- what the parsers extract only proposes changes to Shelf's own records (prices, quote states, copies); it never
  creates people, settings or outgoing mail.

Parsers are versioned (`apps/server/src/mail/parse.ts`; `mail_seen.parser_version` is the reader's and the parser's,
e.g. `m3d-1/quote-1`) and tested against invented fixtures in the layouts below; real mails stay out of the
repository. The kind comes from the signed headers: the subject for the shop's mails, the sender
`english-orders@orellfuessli.ch` for quotes and confirmations; any other mail of the bookshop is `other` and changes
nothing. Each parser is bounded (5,000 lines of at most 1,000 characters, 100 books, 1 MB of text) and linear (lines
split and matched by anchored expressions, never one pattern over the whole text), reads only the bookshop's own lines
(nothing from the first reply marker on, no `>` line: the household's quoted request is never read), and **fails
closed**: a recognised mail whose layout is not one it knows is `unknown_layout`, keeps the parser's version and its
reason, changes nothing, waits in the Inbox, and is read again only under a new parser version. Unknown means: an
amount Shelf cannot place (anything but a book's price, a total, postage, a discount or VAT), a book without a title,
without a price or a status, or with two prices, an ISBN that is not 13 digits, an article of a kind it does not know,
an invoice row that begins with an EAN and does not read whole, a stated total that is not the rows' sum (with
postage), or a PDF the worker cut short.

| Kind | How to recognise | What to extract | Effect |
|---|---|---|---|
| `bookshop_quote` | from english-orders@, with prices | per title: ISBN, price, delivery; "not in stock / backorder" | order lines quoted / unavailable; order total = the quoted lines; status quoted |
| `bookshop_confirm` | from english-orders@: "We have now ordered…", order number | order number | order status drafted → quoted |
| `online_order` | subject "Ihre Orell Füssli Bestellung (n)" | items: title, author, price; skip non-books (Spielwaren) | lines matched and kept; no Shelf order is made (the month's order is Compose's), the invoice makes the copies |
| `click_collect` | subject "Wir bearbeiten Ihre Bestellung (n)" | "Buch <title> von <author> EAN: <ean> \| Fr. <price>" | as `online_order` |
| `invoice` | subject "Ihre OrellFüssli-Rechnung Nr. n" + PDF | PDF rows: `EAN  Title  qty ST  price  [discount %]  total CHF  VAT %` | a copy per unit (owned), priced; its order's lines delivered, the order invoiced; the same invoice number again counts once |

A quote or confirmation belongs to a composed order (status drafted or quoted): the one whose `mail_thread_ref` holds
the mail's signed In-Reply-To (the bookshop's own earlier mail in that thread), or else the one of the month its signed
Subject names as Compose writes it ("Re: Book order, November 2026"). The person's request never reaches Shelf
(Compose adds no Bcc), so only the bookshop's own signed mail ties a reply to an order. Each tied mail's Message-ID
joins the order's thread (at most 20). Lines match books by EAN first, then by normalised title and author (the full
name, "Surname, First" or the surname alone; the title alone on an invoice), never by its title to a book with another
ISBN, and never at all when its EAN is no ISBN (not 978/979: a toy, a game, a Tonie, decided from the digits before the
field filter); a line that matches no book, or more than one, is kept with its structured fields and shown in the
Inbox (M3 e) for a person to resolve. An invoice row that reads whole but for its EAN (spaced, cut short) is kept as
`eanUnreadable`, counts in the total, never matches, and goes to the Inbox too. A shop subject whose number is not one
run of 4 to 11 digits (spaced, or longer than a kept field allows; format characters such as a zero-width space are
stripped first) is an unknown layout. In the Inbox, adding an invoice line makes its copies (owned), adding a quote's or
a shop's line puts its book in a backlog (yours or a kid's), and a line whose EAN is no ISBN can only be skipped.

Layouts (quotes, all must parse; the shop's mails as the fixtures write them):
- `Author: X / Title: Y / ISBN: n / Price: CHF 19.90 / Delivery due: 3 – 4 days` blocks, a field a line (or on one line
  with ` / `)
- `Paulsen, The Quiet Hedgehog / ISBN: n / Price. CHF 16.90 / delivery due: 2-3 days`
- one line per book: `- Okafor, Value Beyond Price, CHF 18.90, delivery time 1-3 days` (or `…, not in stock`)
- online order and click & collect, a line per article: `<kind> <title> von <author> [EAN: <ean>] | [<n> x ]Fr. <price>`,
  where the kind is `Buch` or `Taschenbuch` (books) or one Shelf knows to skip (`Spielwaren`, `Kalender`, …)
- invoice rows as the media worker splits the PDF (cells at wide gaps); `Versandkosten`/`Porto` and `Total` rows
  are read for the sum; the PDF's text is never stored

**Compose** (instead of drafts): Shelf builds a `mailto:` link to english-orders@orellfuessli.ch with the subject and
the text filled in (the books, the delivery address, a request for prices and delivery times). The person's own mail
app opens it; Shelf never sends, and the link has no Cc or Bcc: the request, and whatever the person adds to it, goes
to the bookshop alone, never to Shelf's mailbox (decided 2026-11-16, PR #14 review). **Shelf never sees the card
number**: the text holds no card line at all, and the person adds the number in their own mail app if the bookshop
needs it. The delivery address is sealed
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

- Android: the web app is a PWA with `share_target` (POST multipart to `/share-target`, title + text + url + files).
  Its service worker takes that POST, keeps the parts in the browser's cache for a moment and opens the share screen,
  which posts them to `/api/shares` itself: with Shelf's Origin and session, as every other change (ADR 0010).
- iOS: a Shortcut "Send to Shelf" posting the same multipart to `/api/shares` with a per-person share token
  (`Authorization: Bearer`), created in Settings and shown once with a QR code (steps in `docs/phone-share.md`). The
  token is its id and 256 random bits, stored hashed, compared in constant time, can be revoked, and is write-only: it
  is accepted by `POST /api/shares` and nothing else (ADR 0009).
- Images only for now (JPEG, PNG, WebP, GIF, by their bytes; the Shortcut converts photos to JPEG); video arrives with
  M3 f. Until the AI reads shares (M3 g) a share is `done` once its images are re-encoded.
- A share carries images, the link and the caption. Shelf never logs in to Instagram and never holds an Instagram
  session (ADR 0006); the link is stored as text and fetched only through oEmbed without a login, if at all.
- Media are size-limited (20 MB per file, 30 files), type-checked by content, and processed in the media worker.
- The server stores media, queues `extractTitles`, and the share screen polls `/api/shares/{id}` for progress.

## Wishlist import (one-off, optional)

Seed already contains the Orell Füssli wishlist and "To buy" list as of 2026-11-15 (`seed/wishlist.json`, `tobuy` flag).
A later importer may read a logged-in wishlist export if the person provides one; Shelf does not log in to retailers.
