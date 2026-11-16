# Security: threat model

Shelf holds a household's reading, its kids' profiles and a delivery address (never the bookshop card number), and reads mail,
shared posts, PDFs, videos and web pages it did not write. Security comes before polish and features (ADR 0009).

## Assets

| Asset | Where | Why it matters |
|---|---|---|
| People, kids' names and birth years, reading and takeaways | SQLite | private to the household; kids especially |
| Delivery address, the bookshop's address | `sealed_secret` (AES-256-GCM, bound to its name), key outside the database: `SHELF_SEALING_KEY` or `SHELF_SEALING_KEY_FILE`; standalone makes `sealing.key` (0600) in its own folder, `SHELF_KEYS_DIR` (`./keys` next to `./data` in docker-compose.yml), never inside the data folder | physical address; where orders go |
| IMAP app password of the Shelf-only mailbox | secret (env/file) | reads the bookshop's mail |
| Claude API key (if opted in) | secret (env/file) | costs money, sends data out |
| Share tokens | hashed in `share_token` | anyone holding one can drop shares into a person's Inbox |
| The server itself | container | a foothold on the home network |

## Actors and what stops them

| Actor | Could try | Controls |
|---|---|---|
| **A household adult** | read another adult's takeaways, change their settings, add or remove people | per-person routes act on the signed-in person (readings: your own, and kids', for whom adults act); a takeaway is sent only to its own person and to no AI unless that person turns on `takeawaysToAi` (`library/ai-context.ts`), and a link or idea the AI wrote from it (`private_to`) shows its reason, and is decided, only by that person; for anyone else it answers 404 like a missing one, so not even its existence shows (`knowledge/knowledge.ts`); shared data (budget, backlog) is shared by design; admins manage people; the last admin cannot be removed or demoted |
| **A kid** | sign in, change picks or feedback | `audience: adults`: kids have no access; adults act for them |
| **A stranger on the LAN** | reach the app, forge `X-HomersLab-Person`, guess a sign-in | standalone binds `127.0.0.1` by default; in homerslab mode the headers count only from the configured proxy address, and only once HomersLab's edge strips and sets them (`SHELF_EDGE_IDENTITY`, HomersLab #236) and its per-app firewall (HomersLab ADR 0020) lets only the edge reach Shelf; passkeys only, nothing to guess; sign-in steps rate limited; setup and invite links one-time, hashed, in the fragment (ADR 0010) |
| **A stranger on the internet** | the same, through whatever exposes Shelf | Shelf is never public by itself (`public: false`); HomersLab's proxy and sign-in are in front |
| **Whoever holds a share token** (lost phone, leaked Shortcut) | post shares; read anything | write-only to `POST /api/shares`; revocable; hashed at rest; shown once |
| **Hostile mail** (spoofed "bookshop" mail, a forwarded phishing mail) | fake quotes or invoices, links to click, malicious PDFs | sender + DKIM/ARC checks before any effect; unverified mail changes nothing; links never followed; PDFs in the media worker; size limits |
| **A hostile share** (image, video, caption) | exploit an image/video decoder; prompt injection in a caption | the media worker: its own container (`shelf-worker`) as its own user (`SHELF_WORKER_UID`, default 61000; it refuses to start as root or as the folder's owner) with `network_mode: none`, a read-only root, no capabilities, no-new-privileges, 768 MB and 64 processes; it sees only `work/in` (read-only) and `work/out` (which it cannot replace: its parent is the image's read-only `/work`), never the database or the keys; one job at a time, each in a child process (its own process group, killed with its result or at 20 s; after each job the worker looks in `/proc` for any other process of its user, one that escaped the group with a session of its own, and if there is one the job fails and the worker exits, so Docker restarts the container and its PID namespace with everything in it) with a 256 MB JavaScript heap (ArrayBuffers and libvips' memory are bounded by the container's 768 MB, not by the heap); types from the bytes (never names), and libvips' loaders blocked but JPEG, PNG, WebP and GIF; a 40-megapixel limit read from the header; re-encoded to a fresh JPEG with no metadata. The server treats the worker as taken over by its input: it opens what the worker writes without following links or blocking (`O_NOFOLLOW`, `O_NONBLOCK`), regular files only, within a size cap; checks each result against the job's id and kind, with caps on characters, rows and cells; walks a returned JPEG's markers (no APPn, no COM, nothing after EOI, the frame the reported size); keeps one job in flight with a short queue (`busy` beyond it), so `work/in` never holds another person's file; and the worker skips a job nobody waits for any more (`@shelf/contracts/media`, `media/client.ts`). Captions marked untrusted in prompts |
| **A hostile PDF** | exploit pdfjs, exhaust memory | media worker; never in the server process (text only: no fonts, no eval, no XFA, no WebAssembly, images never decoded) |
| **A compromised or manipulated AI provider, prompt injection** | make Shelf act, fetch URLs, leak data, skew picks | AI output is schema-validated data only; no tool use, no URLs fetched from output; scores come from `packages/scoring`; people confirm links; Ollama by default, Claude only by opt-in with a visible list of what leaves |
| **A malicious book page** (price lookup, Open Library) | oversized or script-laden pages, decompression bombs, redirects elsewhere | allowlisted hosts in one HTTP client; size/time limits; parsed as text; covers re-encoded by the worker |
| **Someone with a copy of the database** (a backup) | read the address | sealed with a key that is not in the database or its backup: standalone keeps it in `keys/`, apart from `data/` (back it up somewhere else, a password manager say); under HomersLab it is the app's secret `SHELF_SEALING_KEY`, kept and backed up by HomersLab with its secrets, not with the app's data |

| **Whoever writes the order mail** (Compose) | add recipients or headers through the bookshop's address; make Shelf send mail | Shelf never sends mail: Compose is a `mailto:` the person opens; the address must be one plain address (no `?`, `&`, `%`, commas, spaces or line breaks), and the text never holds a card number (`month/order-mail.ts`); the delivery address is write-only in Settings and appears only in the Compose text |
| **Another website the person visits** | make the browser change something in Shelf (CSRF) | SameSite=Strict session cookie; every change must carry Shelf's own `Origin`; CSP `frame-ancestors 'none'` |
| **Whoever reads Shelf's data folder** | the setup link | the same person could replace the database; the link works once, for 24 hours, and only while no admin can sign in |

## Rules that follow

The rules are ADR 0009's. Each new route, connector or job states which actor it is exposed to and which control
applies; a feature that cannot meet them waits.

## Open points

- The media worker has no seccomp profile beyond Docker's default, and no Landlock; an address-space limit on the child (`prlimit --as`) is not set (the container's memory limit is the bound).
- Whether the HomersLab proxy authenticates itself to Shelf with more than its address (mTLS, a shared secret) depends
  on HomersLab's feedstock format. Until then the address is trusted only because HomersLab ADR 0020's firewall keeps
  everything but the edge off Shelf's port.
- Sign-in rate limits count per client address. Behind a reverse proxy every client has the proxy's address, so the
  limit is shared by the household (20 sign-in steps a minute); a proxy in front of standalone Shelf should keep its
  own limits.

## Rotating the sealing key

There is no re-encryption step, on purpose: Shelf never holds two keys. To rotate (or after a key is lost):

1. Replace the key: a new `SHELF_SEALING_KEY` under HomersLab; standalone, delete `keys/sealing.key` (a new one is
   made on the next save).
2. Settings keeps working for everyone; "Where orders go" says the addresses need entering again (`needsReentry`), and
   Compose answers 409 until they are.
3. An admin enters the bookshop's address and the delivery address again; they are sealed under the new key.

The old rows cannot be opened with the new key (each row carries its key's id, and GCM refuses anything else).
