# Bookshops and mail providers

Philobiblos works with any bookshop and any mail provider (philobiblos#27). A bookshop is a **connector**: a file of
data that says who the shop mails from, how its mails read and where its prices are. Nothing in Philobiblos's code
names a shop or a mail provider (an architecture test, `apps/server/test/architecture.test.ts`, keeps it so).

## Choosing a bookshop

Settings → **Bookshops** lists the connectors: the ones that ship with Philobiblos (`connectors/` in this repository)
and the household's own (`PHILOBIBLOS_CONNECTORS_DIR`, a read-only folder). For each, Settings shows what it allows:

- the mail domains whose mail counts, and the domains whose DKIM signature counts (exact names: a subdomain is
  another sender);
- the addresses its quotes and confirmations come from;
- the one host its price lookup asks, with a book's title and first author;
- the address Compose writes to, unless *Where orders go* names another.

A connector counts for nothing until an **admin enables** it there, with a sign-in of the last few minutes. Only then
does its mail count, its price host join the egress allowlist, and Compose know its address. The enabling holds for
that version of the file (its SHA-256): when the file changes, the connector allows nothing until an admin enables it
again. Two enabled connectors never share a mail domain. Turning one off takes effect at once.

The example that ships, **Quillmere Books** (`connectors/quillmere/`), is invented: its domain is under `.example`, so
enabling it changes nothing real. It is the template for a real shop.

## Adding a bookshop

A new shop is a folder `connectors/<id>/` with:

- `connector.yaml`, following `contracts/connector.schema.json`;
- `fixtures/*.yaml`, **invented** mails and pages in the shop's layouts (never a real mail: names, titles, addresses and
  numbers are made up).

`apps/server/test/connector-fixtures.test.ts` runs every fixture through the same path a real mail takes: signed as
the shop with a test key, the strict header block, the sender and DKIM checks against that connector alone, the size
limits, then the parsers with the connector's words, and its words over hostile text to keep every match linear. A
connector pull request is data and fixtures only; it needs no code.

For a shop only your household uses, put the folder in your own `PHILOBIBLOS_CONNECTORS_DIR` instead (in Docker:
mount it read-only, e.g. `./connectors:/connectors:ro,Z`, and set `PHILOBIBLOS_CONNECTORS_DIR=/connectors`). Its id
may not be one that ships.

### What a connector holds

```yaml
schema: 1
id: quillmere                 # its folder's name
name: Quillmere Books
locale: { currency: CHF, language: de }
money: { before: [CHF, Fr.], after: [CHF] }    # how amounts are written: "CHF 19.90", "19.90 CHF"
mail:
  domains: [quillmere.example]                 # From (and Sender) domains, exact
  dkim_domains: [quillmere.example]            # optional: the signing domains that count (default: domains)
  reply: { separators: [...], header_labels: [...], attribution_starts: [...], attribution_verbs: [...] }
  summary: [total, gesamt*, ...]               # lines whose amount is no book's; `*` = any word beginning so
  unavailable: [not in stock, ...]
  quote: { senders: [...], labels: { author: [...], title: [...], isbn: [...], price: [...], delivery: [...] },
           confirm_phrases: [...], order_number_labels: [...] }
  shop: { online_order_subjects: ['… ({number})'], click_collect_subjects: [...], book_kinds: [...], skip_kinds: [...],
          by: von, ean_label: EAN }
  invoice: { subjects: ['… Nr. {number}'], unit: ST, total_words: [...], postage_words: [...] }
order: { to: orders@quillmere.example }
prices:
  kind: search_tiles
  url: https://www.quillmere.example/suche?sq={query}
  article: { path: /shop/home/artikeldetails/, id_prefix: A, id_digits: [6, 14] }
  print_formats: [...]
  want_languages: [...]
  other_languages: [...]
  availability: { phrases: [...], joiners: [...], units: [...] }
```

Every section but `schema`, `id`, `name`, `locale` and `money` is optional: a shop without a price lookup leaves out
`prices`, one whose mail Philobiblos does not read leaves out `mail`.

### What a connector cannot do

A connector is **data only**, and it cannot loosen a rule of the core:

- **No code and no regular expressions.** Every word is a literal; the patterns are fixed shapes in
  `apps/server/src/connectors/text.ts`, each word escaped into them, so matching stays linear whatever the words are.
  A `*` is allowed only at the end of a summary or invoice word, and `{number}` and `{query}` only where the schema
  puts them.
- **Exact hosts.** Domains and hosts are lowercase names with at least two labels, never an address, a wildcard, a
  port or credentials. The price URL is https on the default port, and the search words fill only its query string.
- **No new settings.** Every object of the schema refuses keys it does not name: a connector cannot allow unsigned
  mail, a private address, a redirect to another host or another mail size.
- **Plain YAML.** No aliases, anchors, tags, merge keys or duplicate keys; at most 64 KB; a plain file in a plain
  folder (a symbolic link is refused); UTF-8.
- **Bounded.** At most 32 words in a list, 60 characters a word, 8 domains, 16 subjects.

A file that breaks any of these is listed in Settings with its reason and can never be enabled. Every mail still goes
through every check of `contracts/connectors.md`: DKIM (or a trusted forwarder's ARC seal), the strict header block,
the household as recipient, the size limits, no stored text, links never followed.

## Mail providers

Philobiblos reads one mailbox used for nothing else, over IMAP with TLS on port 993 and an app password
(`PHILOBIBLOS_IMAP_HOST`, `PHILOBIBLOS_IMAP_USER`, `PHILOBIBLOS_IMAP_PASSWORD`): any provider that offers IMAP works,
self-hosted included. Your own mail account forwards only the bookshop's mail there with a filter.

A forward sometimes breaks the shop's DKIM signature. Philobiblos then accepts the mail only if your forwarding
provider sealed it with ARC and you named that provider's sealing domain in `PHILOBIBLOS_MAIL_ARC_SEALERS`
(comma-separated). No provider is assumed: by default the list is empty, and only mail whose own DKIM signature
survives counts. The sealing domain is the `d=` of the newest `ARC-Seal` header in a forwarded mail; look it up in one
before you set it.

Providers that refuse app passwords for IMAP (OAuth 2.0 only) are not supported yet: XOAUTH2 with an admin-supplied
OAuth client comes in a later slice of philobiblos#27.
