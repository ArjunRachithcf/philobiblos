# ADR 0009: Security first

Status: **Accepted** · 2026-11-15

**Decision**: Shelf ranks security above polish, and polish above features, as HomersLab does. The threat model is in
`docs/security.md`; these rules follow from it and bind every milestone.

- **Untrusted media in a sandbox.** PDF invoices, shared images, video frames and downloaded covers are parsed in a
  separate, unprivileged worker process with no network, a time limit and a memory limit. `ffmpeg`, `sharp` and
  `pdfjs-dist` are never loaded in the server process. The worker returns plain data (text rows, re-encoded images).
- **AI output is data only.** It is validated against `contracts/ai/*.schema.json`, stored, and shown as plain text; it
  never triggers an action, a request or a URL fetch, and never sets scores (ADR 0004). Inputs from mail, shares and web
  pages are marked untrusted in prompts. Ollama is the default provider; Claude is an explicit opt-in that shows what
  leaves; takeaways go to Claude only if that person turns it on.
- **Phone-share tokens** are per person, write-only (`POST /api/shares` only), stored as a SHA-256 hash, shown once,
  listed by label and revocable.
- **Identity.** In `homerslab` mode the `X-HomersLab-Person` header is trusted only from the configured proxy address
  (`SHELF_TRUSTED_PROXY`); from anywhere else it is ignored and the request is unauthenticated. In `standalone` mode
  Shelf binds to `127.0.0.1` by default and signs in with passkeys; there are no passwords.
- **Secrets at rest.** Shelf never stores the bookshop card number (the order text leaves it for the person to fill
  in). The delivery address is sealed (AES-256-GCM) with a key kept outside the database (`SHELF_SEALING_KEY_FILE`, a
  secret or credential file); a copy of the database alone does not reveal it.
  The IMAP app password and the Claude API key are secrets from the environment or files, never stored in SQLite.
- **Egress allowlist.** One HTTP client for the whole app allows only the hosts in the manifest's egress list (plus the
  configured IMAP and Ollama hosts, and Claude only after the opt-in). The price lookup and Open Library are parsed with
  size and time limits; covers are re-encoded locally before they are stored or served.
- **Secrets never in output**: not in logs, API responses, the UI, error messages or `ai_run` rows. A new share token is
  the one exception, in the response that creates it.
- **Mail is hostile** (ADR 0007): sender and DKIM/ARC checks before any effect; links never followed.
- **No Instagram session** (ADR 0006).

**Consequences**: some features take more taps (sharing images, Compose instead of drafts, opting in to Claude). M0
carries the contracts for these (share tokens, sealed secrets, the mail checks); the worker, the HTTP client and the
passkeys arrive with the features that need them, and nothing before them may bypass these rules.
