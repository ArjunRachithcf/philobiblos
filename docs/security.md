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
| **A household adult** | read another adult's takeaways, change their settings, add or remove people | per-person routes act on the signed-in person (readings: your own, and kids', for whom adults act); a takeaway is sent only to its own person and to no AI unless that person turns on `takeawaysToAi` (`library/ai-context.ts`); shared data (budget, backlog) is shared by design; admins manage people; the last admin cannot be removed or demoted |
| **A kid** | sign in, change picks or feedback | `audience: adults`: kids have no access; adults act for them |
| **A stranger on the LAN** | reach the app, forge `X-HomersLab-Person`, guess a sign-in | standalone binds `127.0.0.1` by default; in homerslab mode the headers count only from the configured proxy address, and only once HomersLab's edge strips and sets them (`SHELF_EDGE_IDENTITY`, HomersLab #236) and its per-app firewall (HomersLab ADR 0020) lets only the edge reach Shelf; passkeys only, nothing to guess; sign-in steps rate limited; setup and invite links one-time, hashed, in the fragment (ADR 0010) |
| **A stranger on the internet** | the same, through whatever exposes Shelf | Shelf is never public by itself (`public: false`); HomersLab's proxy and sign-in are in front |
| **Whoever holds a share token** (lost phone, leaked Shortcut) | post shares; read anything | write-only to `POST /api/shares`; revocable; hashed at rest; shown once |
| **Hostile mail** (spoofed "bookshop" mail, a forwarded phishing mail) | fake quotes or invoices, links to click, malicious PDFs | sender + DKIM/ARC checks before any effect; unverified mail changes nothing; links never followed; PDFs in the media worker; size limits |
| **A hostile share** (image, video, caption) | exploit an image/video decoder; prompt injection in a caption | media worker without network, with time/memory limits; content-type sniffing; captions marked untrusted in prompts |
| **A hostile PDF** | exploit pdfjs, exhaust memory | media worker; never in the server process |
| **A compromised or manipulated AI provider, prompt injection** | make Shelf act, fetch URLs, leak data, skew picks | AI output is schema-validated data only; no tool use, no URLs fetched from output; scores come from `packages/scoring`; people confirm links; Ollama by default, Claude only by opt-in with a visible list of what leaves |
| **A malicious book page** (price lookup, Open Library) | oversized or script-laden pages, decompression bombs, redirects elsewhere | allowlisted hosts in one HTTP client; size/time limits; parsed as text; covers re-encoded by the worker |
| **Someone with a copy of the database** (a backup) | read the address | sealed with a key that is not in the database or its backup |

| **Another website the person visits** | make the browser change something in Shelf (CSRF) | SameSite=Strict session cookie; every change must carry Shelf's own `Origin`; CSP `frame-ancestors 'none'` |
| **Whoever reads Shelf's data folder** | the setup link | the same person could replace the database; the link works once, for 24 hours, and only while no admin can sign in |

## Rules that follow

The rules are ADR 0009's. Each new route, connector or job states which actor it is exposed to and which control
applies; a feature that cannot meet them waits.

## Open points

- How the media worker is isolated beyond a separate process (seccomp, a second container, Landlock) is decided in M3.
- Whether the HomersLab proxy authenticates itself to Shelf with more than its address (mTLS, a shared secret) depends
  on HomersLab's feedstock format. Until then the address is trusted only because HomersLab ADR 0020's firewall keeps
  everything but the edge off Shelf's port.
- Sign-in rate limits count per client address. Behind a reverse proxy every client has the proxy's address, so the
  limit is shared by the household (20 sign-in steps a minute); a proxy in front of standalone Shelf should keep its
  own limits.
