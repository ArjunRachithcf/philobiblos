# Connectors

All sources run from the job scheduler, log to `job_run`, and are idempotent (`mail_seen`, input hashes).

## Bookshops are data (philobiblos#27)

No bookshop is named in the code. A bookshop is a **connector**, `connectors/<id>/connector.yaml` (the ones that ship)
or the same in `PHILOBIBLOS_CONNECTORS_DIR` (the household's own), following `contracts/connector.schema.json`: its
mail domains and signing domains, its quote senders, the words of its mails (subjects, labels, currency, reply
markers, kinds of article), its order address and its price lookup. It is data only: no code, no regular expression
(words are literals placed into fixed, linear shapes), exact hosts, plain YAML of at most 64 KB, and every object
refuses keys it does not name, so a connector cannot loosen a rule below. A connector counts for nothing until an admin
enables it in Settings with a fresh sign-in, for that version of its file (SHA-256); `connector_enabled` keeps which.
What follows applies to the connectors enabled now, and only to them. How to add one: `docs/connectors.md`.

## Mail over IMAP (ADR 0007)

No Gmail API and no Google token. The person sets up a filter in their own mail account that forwards **only** the
bookshop's mail to a mailbox used by Philobiblos and nothing else. Philobiblos reads that mailbox over
IMAP: TLS only (from the first byte, port 993 unless `PHILOBIBLOS_IMAP_PORT` names another; certificate and host name
verified, against the system's CAs or only the certificate `PHILOBIBLOS_IMAP_CA_FILE` names; no STARTTLS downgrade, no
plain auth without TLS), read-only (`EXAMINE`, never `STORE`, `MOVE`, `EXPUNGE` or delete; `mail_seen` keeps what was
read). New messages after the last run, by UID. It signs in one of two ways, never both and never one as a fallback for
the other (`docs/mail-providers.md`):

- an app password kept as a secret (`PHILOBIBLOS_IMAP_PASSWORD`, never in the database, the API or logs), the default;
- XOAUTH2 (`PHILOBIBLOS_IMAP_AUTH=xoauth2`, philobiblos#27; OAUTHBEARER when the server offers it) with an OAuth client
  the household registered itself (Philobiblos ships none): its id, secret, endpoints and scope come from the environment
  only. An admin connects the mailbox in Settings after reading what connecting allows, with a sign-in of the last 10
  minutes: an authorization code with PKCE (S256) and a state, both 256 random bits, used once, within 10 minutes, by the
  session that started it; the redirect URI is always `PHILOBIBLOS_ORIGIN` + `/settings/mail-oauth`. The refresh and
  access tokens are sealed like the delivery address (`sealed_secret` `imap_oauth`), with the fingerprint of the client
  and mailbox they were given for: a change of either in the environment and they are never used or sent anywhere. The
  access token is refreshed with less than a minute left, one refresh at a time; a new refresh token replaces the old one
  (rotation); `invalid_grant` forgets them. Disconnecting forgets them, then revokes the refresh token (RFC 7009) when the
  client names a revocation endpoint, and drops every connection still being made (one started before it never finishes
  after it); a refresh that loses to a disconnect writes nothing back and, while nothing is sealed and no connection is
  being made, revokes the refresh token the provider rotated to as well (one that loses to a new connection, made or
  being made, does not: at some providers that would end the new grant too). The token client reaches the token and revocation endpoints only (https, public addresses, never
  redirected): **a token endpoint only on the home network is not supported** (decided, philobiblos#49: the client secret
  and refresh token never go to a private address); no token, code or verifier is in an answer, a log or `job_run`, and of a provider's
  refusal only its RFC 6749 error code is repeated.

**Every mail is hostile input.** Forwarded mail can be spoofed, so before a mail has any effect:

- the original sender (the forwarded `From`, exactly one address, and `Sender` where present) must be at exactly one
  of an enabled connector's mail domains (a subdomain is another sender unless it is listed); with none enabled, no mail
  counts; `Return-Path` is not checked, because a forwarding filter rewrites it to the forwarder (SRS) (M3 c);
- it must be addressed (To or Cc) to the household (`PHILOBIBLOS_MAIL_RECIPIENTS`, or the mailbox itself), so a genuine
  bookshop mail to someone else cannot be replayed into Philobiblos;
- what Philobiblos reads from the headers must be what was signed: a header that may appear once appears once, the passing
  signature covers From, To, Subject, Date, Message-ID, MIME-Version and Content-Type (and Cc, Sender, Reply-To,
  In-Reply-To, References and Content-Transfer-Encoding when present) and no fewer instances than the mail has, and
  a signature over part of the body (`l=`) does not count;
- a DKIM signature by exactly one of that connector's signing domains (`dkim_domains`, default its mail domains),
  aligned with the From, must pass, or, for a forward that broke it, the `ARC-Authentication-Results` of the
  forwarding provider must show `dkim=pass` for one of them, aligned with the From just as well (relaxed: the same
  organizational domain; a connector whose signing domain is aligned with none of its mail domains cannot be used); a mail that fails, or has neither, is stored with
  `accepted = 0` and shown in the Inbox as "not verified", and changes nothing (and none of its content is kept). The
  forwarding providers whose ARC seal counts are `PHILOBIBLOS_MAIL_ARC_SEALERS` (none by default: no provider is
  assumed); DNS is asked only for
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
  window is read again (enabling a connector, or a new version of one, is such a change);
- links in mail are never followed, fetched or shown as clickable; images are not loaded;
- MIME is parsed with limits (25 MB per mail, depth 8, 64 parts, 256 KB of headers, no nested message); only
  `application/pdf` attachments (by their bytes, 10 MB) are read, in the media worker (ADR 0009), never in the server;
- what the parsers extract only proposes changes to Philobiblos's own records (prices, quote states, copies); it never
  creates people, settings or outgoing mail.

Parsers are versioned (`apps/server/src/mail/parse.ts`; `mail_seen.parser_version` is the reader's and the parser's,
e.g. `m3d-1/quote-1`) and tested against invented fixtures in the layouts below (`connectors/<id>/fixtures/`); real
mails stay out of the repository. The layouts are the core's; their words are the connector's (the mail's own
connector, the one whose domain it is from). The kind comes from the signed headers: the connector's subject templates
for the shop's mails, its quote senders for quotes and confirmations; any other mail of the bookshop is `other` and
changes nothing. Each parser is bounded (5,000 lines of at most 1,000 characters, 100 books, 1 MB of text) and linear (lines
split and matched by anchored expressions, never one pattern over the whole text), reads only the bookshop's own lines
(nothing from the first reply marker on, no `>` line: the household's quoted request is never read), and **fails
closed**: a recognised mail whose layout is not one it knows is `unknown_layout`, keeps the parser's version and its
reason, changes nothing, waits in the Inbox, and is read again only under a new parser version. An amount has the
connector's currency's decimals (none, two or three, as the server counts them), its whole units grouped by thousands
(`,` `.` or `'` unless `money.groups` names its own, a space only then; the same throughout, never the decimal mark) or
not, up to 10,000,000,000 (philobiblos#62). The decimal mark is `money.decimal`, or else a point or a comma that is not
the grouping's; a connector in a currency with three decimals must name it (`1,250` is 1.25 or 1250), or it does not
load. A digit, or a separator or a space and a digit, after an amount means it is not one (`12 500` without space
groups is refused, never read as 12). Unknown
means: an amount Philobiblos cannot place (anything but a book's price, a total, postage, a discount or VAT), an amount
with a thousandth (a currency with three decimals: amounts are kept in hundredths), a book without a title,
without a price or a status, or with two prices, an ISBN that is not 13 digits, an article of a kind it does not know,
an invoice row that begins with an EAN and does not read whole, a stated total that is not the rows' sum (with
postage), or a PDF the worker cut short.

| Kind | How to recognise | What to extract | Effect |
|---|---|---|---|
| `bookshop_quote` | from a quote sender (`mail.quote.senders`), with prices | per title: ISBN, price, delivery; a status from `mail.unavailable` | order lines quoted / unavailable; order total = the quoted lines; status quoted |
| `bookshop_confirm` | from a quote sender, holding a `confirm_phrases` phrase, an order number | order number | order status drafted → quoted |
| `online_order` | a subject of `online_order_subjects` (e.g. "Ihre Quillmere Bestellung (n)") | items: title, author, price; skip `skip_kinds` (Spielwaren) | lines matched and kept; no Philobiblos order is made (the month's order is Compose's), the invoice makes the copies |
| `click_collect` | a subject of `click_collect_subjects` | "Buch <title> von <author> EAN: <ean> \| Fr. <price>" | as `online_order` |
| `invoice` | a subject of `invoice.subjects` (e.g. "Ihre Quillmere-Rechnung Nr. n") + PDF | PDF rows: `EAN  Title  qty <unit>  price  [discount %]  total <currency>  VAT %` | a copy per unit (owned), priced; its order's lines delivered, the order invoiced; the same invoice number again counts once |
| `online_order` (markup) | `mail.markup: true`, a mail none of the rows above recognises, one schema.org `Order` in its JSON-LD | each offer's product (`acceptedOffer` or `orderedItem`): name, first author, ISBN/GTIN-13, quantity, price; the order number | as `online_order` (`markup-order-1`) |
| `invoice` (markup) | as above, one schema.org `Invoice` | its `confirmationNumber` (or `identifier`), its `referencesOrder`'s offers, `totalPaymentDue` | as `invoice` (`markup-invoice-1`); no number, a total that is not the lines' sum, more than one order referenced, or an order whose status is not one that counts (processing, payment due, in transit, pickup available, delivered: an allowlist, string or `@id`): unknown layout |

A quote or confirmation belongs to a composed order (status drafted or quoted): the one whose `mail_thread_ref` holds
the mail's signed In-Reply-To (the bookshop's own earlier mail in that thread), or else the one of the month its signed
Subject names as Compose writes it ("Re: Book order, November 2026"). The person's request never reaches Philobiblos
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

Layouts (quotes, all must parse; the example connector's words, as its fixtures write them):
- `Author: X / Title: Y / ISBN: n / Price: CHF 19.90 / Delivery due: 3 – 4 days` blocks, a field a line (or on one line
  with ` / `)
- `Paulsen, The Quiet Hedgehog / ISBN: n / Price. CHF 16.90 / delivery due: 2-3 days`
- one line per book: `- Okafor, Value Beyond Price, CHF 18.90, delivery time 1-3 days` (or `…, not in stock`)
- online order and click & collect, a line per article: `<kind> <title> von <author> [EAN: <ean>] | [<n> x ]Fr. <price>`,
  where the kind is one of `book_kinds` (`Buch`, `Taschenbuch`) or of `skip_kinds` (`Spielwaren`, `Kalender`, …)
- invoice rows as the media worker splits the PDF (cells at wide gaps); `postage_words` (`Versandkosten`, `Porto`) and
  `total_words` rows are read for the sum; the PDF's text is never stored

**Compose** (instead of drafts): Philobiblos builds a `mailto:` link to the bookshop's address (the one an admin set in
Settings, or else the `order.to` of the one enabled connector that names one) with the subject and
the text filled in (the books, the delivery address, a request for prices and delivery times). The person's own mail
app opens it; Philobiblos never sends, and the link has no Cc or Bcc: the request, and whatever the person adds to it, goes
to the bookshop alone, never to Philobiblos's mailbox (decided 2026-11-16, PR #14 review). **Philobiblos never sees the card
number**: the text holds no card line at all, and the person adds the number in their own mail app if the bookshop
needs it. The delivery address is sealed
at rest with a key outside the database (`sealed_secret`, ADR 0009).

## Typed in or imported: an order's quote or an invoice (philobiblos#27 slice 4)

The path that works with any shop, or none: a person records what a shop answered or what was bought
(`POST /orders/entries`, This month → *Record a quote or an invoice*), typed a book a row or imported as a CSV. It has the
effects of the mail of its kind in the table above, on the same records, and nothing else:

| Kind | What a row gives | Effect |
|---|---|---|
| `quote` | a book of the month's composed order (drafted or quoted) by ISBN or title (and author); its price, or `available: false` | as `bookshop_quote`: its lines quoted or unavailable, the order's total the quoted lines', status quoted; a row that names no book of that order, or one book twice, refuses the whole entry |
| `invoice` | a book by ISBN or title (and author), copies (1–20) and the price paid for each; `for` (`me` or a kid's handle) | as `invoice`: a copy per unit (owned, source `manual`), priced, the price learnt, the composed order's line delivered and that order invoiced; a book nobody has is added (a kids' book for a kid), and with `for` it goes on that person's pile; a title that names several books (no author or ISBN to tell them apart) refuses the entry |

- **A CSV** (at most 64 KB, 100 rows, 20 columns, 1,000 characters a cell; RFC 4180 quoting; a comma, semicolon or tab,
  the header line's own): a header row naming `isbn` (or `isbn13`, `ean`), `title`, `author`, `qty` (or `quantity`),
  `price`, `available` and `for`, in any order and case. A column it does not read is named back and its cells never
  read; one named twice, or none naming the books (no `title`, no `isbn`), refuses the file. A price is an amount as a
  person writes it in the household's currency with its decimals (`18.90`, `18,90`, `1890` in one without decimals;
  at most two in one with three, `1.25`, since `1,250` could be 1250; no symbol, sign or thousands separator); `available`
  is yes or no. Read in one pass, linear, and refused rather than guessed at (an unclosed quote, text after a closing one);
  lines of empty cells (`;;;`) are skipped. A file over the limit is refused whole, never cut (the page too).
- **An ISBN** is an ISBN-13 starting 978 or 979, or an ISBN-10, spaces and hyphens left out, whose check digit holds
  (`books/isbn.ts`); another product's EAN, or a typo, is refused with its row.
- **Text** (title, author, the number) is NFKC with format characters stripped, and refused with a control character
  or line break, past its length, or holding a run of 12 or more digits (`safeField`'s rule: a card or account number).
- **An invoice number** (letters, digits, spaces and `. / _ -`, at most 40) counts once **per shop**, whatever its case:
  an invoice names its `shop`, an enabled connector's id (`GET /orders/shops`) or the household's own label for a shop
  without one (at most 80 characters; none is a shop of its own). The same shop's number again, typed or imported, is
  refused (409; the unique index `order_entry_number` holds the rule too); so is a number the connector's own verified
  mail brought. A connector's mail bringing a number typed for that connector is read and counts nothing
  (`duplicateOf: entry:<id>`). A number typed for another shop, a label, or none never touches a connector's mail: two
  shops may number their invoices alike, as mail against mail already allows. Without a number, an invoice is recorded
  each time.
- **Maybe typed already** (philobiblos#45): a verified mailed invoice whose every line names a book, with the same books
  in the same quantities and the same books' total as an invoice typed or imported in the 30 days before the mail is
  read (`MAYBE_TYPED_DAYS`) with no number, or with the mail's number for no shop or another (a label), changes nothing
  when it is read: it is kept with `maybeTyped: <entry id>` and waits in the Inbox (kind `maybe_typed_invoice`, "Maybe
  the invoice typed on …"). Any adult answers it (`POST /inbox/{itemId}/typed`): `same`, and it counts as the typed
  one (`duplicateOf: entry:<id>`, nothing else changes but what it holds beyond it: below); `another`, and it has its
  effect then, as when read. It is never
  dismissed unanswered. A typed invoice another mail counts as, or asks about, is not asked about again; of several
  that fit, the one sharing the most copies, then the newest. A typed one with another number counts as before. A mail
  with a line Philobiblos cannot place, then the same invoice typed afterwards in full, is not asked about (the typed one
  holds a book the mail names none for): philobiblos#70.
- **Maybe mailed already** (philobiblos#58): the same rule the other way round. An invoice typed or imported whose
  every row names a book Philobiblos has (since philobiblos#64, below: one holding the mail's books may name others), with the same books in the same quantities and the same total as a verified
  mailed invoice that counted (read in the last 30 days; not one sent again, counted as a typed one, or waiting as maybe
  one; a line added from the Inbox since counts as the book it was added as), and with no number or the mail's, is asked about before it counts, at entry time: 409 with `maybeMailed` (the
  mail's Inbox item id, the day its Date header names, its number, its books' total), "Is this the invoice that came by
  mail on …?". The person sends the entry again with `mailed: { mail, answer }`: `same`, and the entry is kept as the
  mail's duplicate (`order_entry.duplicate_of`): no copy, price, order line or pile changes; `another`, and it counts.
  An answer about another mail than the one that fits now is asked again; `same` with none that fits is 409. A dry run
  names the mail (`maybeMailed`) and asks nothing. A mail an entry is the same as is not asked about again; of several,
  the newest. An entry kept as a mail's duplicate stands for that mail: a mail read later never waits as maybe it nor
  counts as it by its number, and
  its undo removes only the entry (the mail may then be asked about again). Typed for the mail's own connector with its
  number, it is refused by the number, as before.
- **One holding the other** (philobiblos#64): the two rules above ask too when one invoice holds every copy of the other,
  not only the same ones, at the same total for the copies they share (`overlap`; a cent off for each line taken in
  part now or before, and of a book billed on several lines, those nearest the other's price first): the mailed books and more typed
  (or more copies of one, or a book nobody has yet), part of them typed, the typed books and more mailed (a line
  Philobiblos cannot place among the more), or part of them mailed. The question says which: "Does this invoice hold
  the one that came by mail on …? Its N other copies count either way." (`maybeMailed.more`), "Is this invoice part of
  the one …?" (`maybeMailed.part`); the Inbox item's `typed.more` (the copies the same would add) / `typed.part`. The
  same then counts only the copies the second one holds beyond the first (at its own prices; a line taken in part at its
  share of the line's total): never a shared book twice, never the rest dropped. The copies the two share are kept with
  the answer (the entry's undo record `shared`, the mail's `shared: { <entry id>: … }`), so a record is compared by what
  of it is left (`entryLeft`, `mailLeft`): one purchase typed or mailed in three parts is asked about part by part, and
  a record wholly counted as others is not asked about again (one from before this, or counted by its number: wholly).
  After either answer, what is left of a held mail is compared again with the typed invoices of the 30 days before the
  answer (one typed while it waited included; never one it was answered about: `notTyped` for another purchase), and it
  stays held, asked about the next that fits: a mail holding two typed invoices is asked about each in turn. Its card
  shows what is left of each (`found`, `typed.totalC`). The same about a typed one that no longer fits what is left of
  the mail is 409, and changes nothing. Each typed one a mail is the same as is never undone alone. An entry typed or imported that holds books of two mails is refused (409, no
  question), to be recorded part by part: one answer cannot settle two mails. An entry kept as a mail's duplicate makes
  its own copies, and its undo takes them back. A held mail's lines are not decided before the answer; after it, a line
  Philobiblos cannot place waits in the Inbox, as any such line (the answer is kept apart from a dismissal).
- **Undo** (philobiblos#45, `POST /orders/entries/{id}/undo`; `GET /orders/entries` lists the last 7 days'): an invoice
  typed or imported is undone by whoever recorded it, or an admin, within 7 days (`UNDO_DAYS`), while nothing it changed
  has changed since: its copies removed, a tap's copy it took the tap's again, its order lines as they were (a line
  whose book was bought again since by one invoice of no order, as many copies, passes to that purchase: it stays
  delivered and the order is invoiced for it, in the place of a tap's copy the entry took, which goes; two such
  purchases, or another quantity, is 409), each
  order's invoiced total less its own (with none left, the order as before its first invoice), the price it learnt put
  back unless another invoice changed it since, a pile it put a book on left without it unless the book was touched
  since, and the entry gone (its number may be typed again). The book it added stays. Refused (409) when a copy, line
  or order it changed has changed, when a mail counts as it or waits as maybe it, for a quote (typed again instead), and
  for an entry recorded before undo existed (`undo_json` null).
- **Text that could not be decoded** (U+FFFD, what a decoder writes for a file saved in another encoding than UTF-8) is
  refused in every field and in the header: such words would match no book and add a broken one. The page decodes a
  file strictly as UTF-8 and says how to save it again.
- **Kept** (`order_entry`): the kind, how it came (`typed`, `csv`), the number and the shop, the quote's order, who recorded it, the
  total and each row's book id, copies, price and availability, an invoice's undo record (ids and amounts: the copies
  it made, the rows it changed with what they were), and the mail it is the same as, if any; never the text typed or the file.
- Amounts are the household's currency's (Settings): with none chosen yet, nothing is recorded (409). Everything is
  checked before anything changes, in one transaction; `dryRun: true` applies it and rolls it back, so it answers
  exactly what the entry would do.

## No-shop mode: the order as a plain list (philobiblos#27 slice 5)

For a shop with no address, or none: `POST /orders` with `list: true` composes the month's order (status drafted, as
Compose does) without a bookshop address and without opening anything sealed (it works with no sealing key). For an
order composed already (drafted, quoted or invoiced: after a reload, or once books are bought) it changes nothing and
answers the list of its books still to buy (planned or quoted).

- **The mail text** (`listUrl`, `listText`): the order's text with no delivery address and unsigned, as a `mailto:` with no recipient
  (the person chooses the shop in their own mail app); as long as Compose's, the link holds a greeting only past
  `MAILTO_MAX` (`listComplete: false`). No card line, no Cc or Bcc.
- **The printed page**: *Print the list* prints the books still to buy alone (title, authors, ISBN, estimate), as the
  order is after any taps; any other print is the page as it is.
- **The CSV** (`GET /orders/{id}/list.csv`, any adult, once the order is not picked): the books still to buy (planned or
  quoted), UTF-8 with a byte order mark, CRLF, every cell quoted; the columns `isbn` (as `978-…`, which a spreadsheet keeps
  as text), `title`, `author` (the first), `qty` (1), `price` (empty) and `estimate` (the quote, else the estimate), so the
  same file with the prices paid imports as an invoice (above; `estimate` is named back). An attachment, `no-store`.
  **A formula is never written**: a cell that starts with `=`, `+`, `-`, `@` or their full-width forms (after any spaces,
  or after a control character turned into a space), or with a tab or a carriage return, or whose first visible character
  is one of the four in any NFKC form (small, super- or subscript) after invisible format characters (zero-width spaces
  and joiners, a byte order mark), is written with a leading `'` (OWASP "CSV Injection"; philobiblos#45, #47); control
  characters become spaces, so a row is a line. A cell that starts with `'` gets one more too. An import reads that one
  `'` back out (`unguardCell`), so an exported title comes back as it was, its own apostrophe included.
- None of the three holds the delivery address, a person's name or a card number.
- **Owned by a tap** (`PUT /orders/{id}/lines/{bookId}`, `{ owned: true }`, any adult: the order and its copies are the
  household's): for a composed order's planned or quoted line, one copy (source `manual`, of this order, priced as the shop
  quoted it or not at all; no price learnt) and the line delivered, the copy and the state it found kept on the line
  (`order_line.copy_id`, `tapped_from`). A
  second tap is 409, never a second copy; an unavailable line is 409. `{ owned: false }` undoes a tap while the line holds
  its copy: the copy removed, the line as the tap found it (planned or quoted); a line an invoice or the Inbox delivered is
  never undone here (409). **An invoice after a tap** (mailed, typed, imported or added in the Inbox), when no line of the book
  is still to buy and the tap's copy was made within 60 days of the invoice's date, takes that copy as its first (its
  source and price paid; the copy keeps its arrival date; the rest of its quantity new copies), clears `copy_id` and
  `tapped_from`, and invoices the order: one copy for one book bought, and Undo is then 409 like any invoice's
  (philobiblos#47). An older tap is another purchase: the invoice makes its own copies. A line an
  invoice delivered is never taken again: a second invoice of the book is a copy of no order. A quote (mailed or typed) never changes a delivered line. While any line of the order is delivered, its picks, budget and list stay as they are (409), so picking again
  never drops a book in the library.

## Price lookup (ADR 0008)

`PriceSource` interface, one per enabled connector with `prices`. `kind: jsonld`: GET its `url` as below and read only
the page's schema.org JSON-LD (`schemaorg/jsonld.ts`): the Book or Product (alone, in an ItemList, or in @graph) whose
normalised name is the title and whose author's surname is the first author's, its offers in the connector's currency
only (an Offer, a list, an AggregateOffer's lowPrice), the cheapest; the id kept is its GTIN-13, ISBN or SKU as a short
token; its availability one of schema.org's values, in fixed words; more markup than is read (`MARKUP_LIMITS`, the page cut at 1 MB): no price. A
jsonld `url` may hold `{isbn}` instead of `{query}` (an ISBN metadata source, or a shop's search by ISBN): it is asked
with the book's ISBN-13 alone, only for books with one, and the product read is the one whose GTIN-13 or ISBN (an
ISBN-10 as its ISBN-13) is that ISBN, whatever its name; a product with another ISBN or none is never the book.
Settings says which of the two a lookup sends (`allows.priceAsks`). `kind: search_tiles`: GET its `url` with `{query}`
replaced by the title and first author (form-encoded, in the query string only), parse result tiles (an article link
`[https://<host>]<article.path><id_prefix><digits>`, the title, a `print_formats` phrase, an amount with a `money`
symbol, an `availability` phrase). Choose the print edition in one of `want_languages` whose normalised title matches,
skipping tiles naming one of `other_languages`. 1 request / 3 s, cache 7 days, User-Agent identifies Philobiblos.
Read-only: never touches wishlist, cart or account. The page is hostile input: 1 MB and 10 s at most, no redirects off
the host, parsed as text (no script runs), and only the fields above are kept. Its host is on the egress allowlist only
while the connector is enabled; with none, prices stay as they are and count as the household's unknown price.

## Metadata

Open Library by ISBN or title+author → subjects, description, cover (downloaded once to `/data/covers`). Cached forever,
refreshable by hand. Responses are limited (1 MB JSON, 5 MB image, 10 s); covers are decoded and re-encoded by the media
worker before they are stored, so no original file is ever served. Covers come from `covers.openlibrary.org`, which redirects to
the Internet Archive (`archive.org`, then a data node `ia<number>.us.archive.org`): the only redirects to another host
the client follows (ADR 0009).

All outgoing requests go through one HTTP client that allows only the hosts in the manifest's egress list and the
price hosts of the enabled connectors, asked again at each request (ADR 0009).

## Phone share (ADR 0006)

- Android: the web app is a PWA with `share_target` (POST multipart to `/share-target`, title + text + url + files).
  Its service worker takes that POST, keeps the parts in the browser's cache for a moment and opens the share screen,
  which posts them to `/api/shares` itself: with Philobiblos's Origin and session, as every other change (ADR 0010).
- iOS: a Shortcut "Send to Philobiblos" posting the same multipart to `/api/shares` with a per-person share token
  (`Authorization: Bearer`), created in Settings and shown once with a QR code (steps in `docs/phone-share.md`). The
  token is its id and 256 random bits, stored hashed, compared in constant time, can be revoked, and is write-only: it
  is accepted by `POST /api/shares` and nothing else (ADR 0009).
- Images (JPEG, PNG, WebP, GIF; the Shortcut converts photos to JPEG) and videos (MP4, MOV or WebM with H.264, HEVC,
  VP8 or VP9, up to 180 s and 4K), by their bytes. A video becomes a frame every ~2 s, at most 30 (further apart past a
  minute), each a JPEG of at most 1280 pixels a side; its sound and the video itself are never kept. Until the AI reads
  shares (M3 g) a share is `done` once its images are re-encoded and its videos' frames taken.
- A share carries images, the link and the caption. Philobiblos never logs in to Instagram and never holds an Instagram
  session (ADR 0006); the link is stored as text and fetched only through oEmbed without a login, if at all.
- Media are size-limited (an image 20 MB, a video 64 MB, 100 MB a share, 30 files), type-checked by content, and processed in
  the media worker.
- The server stores media, queues `extractTitles`, and the share screen polls `/api/shares/{id}` for progress.

## Wishlist import (one-off, optional)

Seed already contains the household's bookshop wishlist and "To buy" list as of 2026-11-15 (`seed/wishlist.json`,
`tobuy` flag; their offers are kept with the source `seed`).
A later importer may read a logged-in wishlist export if the person provides one; Philobiblos does not log in to retailers.
