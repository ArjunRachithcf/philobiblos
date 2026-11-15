# Security: threat model

Shelf holds a household's reading, its kids' profiles and a delivery address (never the bookshop card number), and reads mail,
shared posts, PDFs, videos and web pages it did not write. Security comes before polish and features (ADR 0009).

## Assets

| Asset | Where | Why it matters |
|---|---|---|
| People, kids' names and birth years, reading and takeaways | SQLite | private to the household; kids especially |
| Delivery address | `sealed_secret`, key outside the database | physical address |
| IMAP app password of the Shelf-only mailbox | secret (env/file) | reads the bookshop's mail |
| Claude API key (if opted in) | secret (env/file) | costs money, sends data out |
| Share tokens | hashed in `share_token` | anyone holding one can drop shares into a person's Inbox |
| The server itself | container | a foothold on the home network |

## Actors and what stops them

| Actor | Could try | Controls |
|---|---|---|
| **A household adult** | read another adult's takeaways, change their settings | per-person routes act on the signed-in person; shared data (budget, backlog) is shared by design; admins manage people |
| **A kid** | sign in, change picks or feedback | `audience: household`: kids have no access; adults act for them |
| **A stranger on the LAN** | reach the app, forge `X-HomersLab-Person` | standalone binds `127.0.0.1` by default; in homerslab mode the header counts only from the configured proxy address; no passwords to guess (passkeys) |
| **A stranger on the internet** | the same, through whatever exposes Shelf | Shelf is never public by itself (`public: false`); HomersLab's proxy and sign-in are in front |
| **Whoever holds a share token** (lost phone, leaked Shortcut) | post shares; read anything | write-only to `POST /api/shares`; revocable; hashed at rest; shown once |
| **Hostile mail** (spoofed "bookshop" mail, a forwarded phishing mail) | fake quotes or invoices, links to click, malicious PDFs | sender + DKIM/ARC checks before any effect; unverified mail changes nothing; links never followed; PDFs in the media worker; size limits |
| **A hostile share** (image, video, caption) | exploit an image/video decoder; prompt injection in a caption | media worker without network, with time/memory limits; content-type sniffing; captions marked untrusted in prompts |
| **A hostile PDF** | exploit pdfjs, exhaust memory | media worker; never in the server process |
| **A compromised or manipulated AI provider, prompt injection** | make Shelf act, fetch URLs, leak data, skew picks | AI output is schema-validated data only; no tool use, no URLs fetched from output; scores come from `packages/scoring`; people confirm links; Ollama by default, Claude only by opt-in with a visible list of what leaves |
| **A malicious book page** (price lookup, Open Library) | oversized or script-laden pages, decompression bombs, redirects elsewhere | allowlisted hosts in one HTTP client; size/time limits; parsed as text; covers re-encoded by the worker |
| **Someone with a copy of the database** (a backup) | read the address | sealed with a key that is not in the database or its backup |

## Rules that follow

The rules are ADR 0009's. Each new route, connector or job states which actor it is exposed to and which control
applies; a feature that cannot meet them waits.

## Open points

- How the media worker is isolated beyond a separate process (seccomp, a second container, Landlock) is decided in M3.
- Whether the HomersLab proxy authenticates itself to Shelf with more than its address (mTLS, a shared secret) depends
  on HomersLab's feedstock format.
