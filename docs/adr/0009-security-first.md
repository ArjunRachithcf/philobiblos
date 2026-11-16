# ADR 0009: Security first

> Written when the app was called **Shelf**; it is **Philobiblos** since 2026-11-16 (philobiblos#30). This record is
> kept as decided: read Shelf as Philobiblos, `SHELF_*` as `PHILOBIBLOS_*` and `shelf_session` as `philobiblos_session`;
> a shelf of books is still a shelf.

Status: **Accepted** · 2026-11-15

> **Superseded in part** (2026-11-16, ADR 0011): the egress allowlist also holds the optional outgoing SMTP host, only
> when it is set (TLS, certificate verified), for join codes alone. Its client is the one outgoing mail connection, and
> the architecture test that keeps every other connection out covers it.

**Decision**: Shelf ranks security above polish, and polish above features, as HomersLab does. The threat model is in
`docs/security.md`; these rules follow from it and bind every milestone.

- **Untrusted media in a sandbox.** PDF invoices, shared images, video frames and downloaded covers are parsed in a
  separate, unprivileged worker process with no network, a time limit and a memory limit. `ffmpeg`, `sharp` and
  `pdfjs-dist` are never loaded in the server process. The worker returns plain data (text rows, re-encoded images).
- **AI output is data only.** It is validated against `contracts/ai/*.schema.json`, stored, and shown as plain text; it
  never triggers an action, a request or a URL fetch, and never sets scores (ADR 0004). Inputs from mail, shares and web
  pages are marked untrusted in prompts. Ollama is the default provider; Claude is an explicit opt-in that shows what
  leaves; takeaways go to no AI (local or not) unless that person turns it on.
  Decided 2026-11-16 (M3 g): nothing a model says counts without a person's tap. An AI tag or link stays proposed and
  counts in no brain or score until a person confirms it, whatever its confidence (spec §6 changed: an injected model
  controls that number). A new idea name a model proposes stays on its proposal and joins the household's ideas only
  when a person confirms it, so it never reaches another prompt on the model's word; idea names, which a model may have
  proposed, go to prompts in `<untrusted>` blocks, and `<input>` holds only Shelf's numbers, enums and fixed lists. With
  Claude, the household has a daily allowance of tokens across every run (`ai_daily_tokens`, admins, 200,000 by
  default) that a call is not made past, of which a share's runs may use at most half per sharer and 40% per share
  token, and the AI reads at most 20 shares a day per share token and 40 per person, chosen fairly.
  What Settings says leaves is built from each job's own fields, and an admin's acceptance covers only the lines it was
  given.
- **Phone-share tokens** are per person, write-only (`POST /api/shares` only), stored as a SHA-256 hash, shown once,
  listed by label and revocable.
- **Identity.** In `homerslab` mode the `X-HomersLab-Person` header is trusted only from the configured proxy address
  (`SHELF_TRUSTED_PROXY`); from anywhere else it is ignored and the request is unauthenticated. In `standalone` mode
  Shelf binds to `127.0.0.1` by default and signs in with passkeys; there are no passwords.
- **Secrets at rest.** Shelf never sees the bookshop card number: the order text has no card line, the person adds it
  in their own mail app, and Compose copies the request to no one (no Cc, no Bcc). The delivery address is sealed (AES-256-GCM) with a key kept outside the database (`SHELF_SEALING_KEY_FILE`, a
  secret or credential file); a copy of the database alone does not reveal it.
  The IMAP app password is a secret from the environment or a file, never stored in SQLite.
  Changed 2026-11-16 (M3 g): the Claude API key is entered by an admin in Settings and sealed like the delivery address
  (`sealed_secret`, the key outside the database), so the opt-in is one admin action in the app; it is write-only and
  never in an answer, a log or an `ai_run` row.
- **Egress allowlist.** One HTTP client for the whole app allows only the hosts in the manifest's egress list (plus the
  configured IMAP and Ollama hosts, and Claude only after the opt-in). Each AI call has its own client whose whole
  allowlist is its provider's one host (M3 g). The price lookup and Open Library are parsed with
  size and time limits; covers are re-encoded locally before they are stored or served.
  Decided 2026-11-16 (M3 b): the name is resolved by the client and the connection goes to the address it checked (no
  second lookup for DNS rebinding to change); a public host must resolve to public addresses only. Redirects stay on
  their host (at most 3), with one exception: Open Library's covers live at the Internet Archive, so
  `covers.openlibrary.org` may redirect to `archive.org` and then to a data node matching `^ia\d{3,8}\.us\.archive\.org$`:
  https on 443 only, at most 2 such hops, each looked up and checked again, and the image still goes through the media
  worker. The client names itself honestly (`Shelf/<version>`); when a site refuses it (the bookshop's search answers
  403), Shelf does without (ADR 0008: the price is unknown and counts as CHF 25) and never disguises the client.
- **Secrets never in output**: not in logs, API responses, the UI, error messages or `ai_run` rows. A new share token is
  the one exception, in the response that creates it.
- **Mail is hostile** (ADR 0007): sender and DKIM/ARC checks before any effect; links never followed.
- **No Instagram session** (ADR 0006).

**Consequences**: some features take more taps (sharing images, Compose instead of drafts, opting in to Claude). M0
carries the contracts for these (share tokens, sealed secrets, the mail checks); the worker, the HTTP client and the
passkeys arrive with the features that need them, and nothing before them may bypass these rules.
