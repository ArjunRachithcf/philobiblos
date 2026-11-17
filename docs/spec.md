# Philobiblos: product spec (v0.1, 2026-11-15)

**Philobiblos** (Greek: lover of books), *what to read next*. A HomersLab app (HomersLab is the maker; its manager is
Homeward), standalone first. It was called Shelf until 2026-11-16 (philobiblos#30); the word "shelf" in this spec means a
shelf of books.

## 1. Purpose

Security comes first, then polish, then features (ADR 0009, `docs/security.md`).


Philobiblos is a family's reading brain. For each adult it keeps a **map of ideas** they have read about, shows where to focus next
so knowledge grows in **breadth** (new ideas) and **depth** (each idea getting denser), and turns that into a **monthly
order** within a shared budget. For each child it keeps an **emotional map** of themes and picks varied picture books.

Philobiblos plans and buys. It is not an ebook reader or a daily reading log; Kavita, BookLore, Calibre-Web and Jelu do those.

## 2. People

- **Household**: from HomersLab (or the standalone household). Roles: admin, adult, kid. Kids have a birth year.
  Sign-in: passkeys in standalone, HomersLab's sign-in under HomersLab (ADR 0010). Kids never sign in before the first
  release.
- **A household of one** is a whole install: one admin, no family features until a second person exists (ADR 0011).
- **Joining** (ADR 0011): standalone, an admin invites a person or makes a join link (7 days, 5 uses, revocable, rate
  limited); who opens it enrols a passkey and waits (at most 10 waiting) for an admin to approve them, as an adult by
  default (every approve and decline with a fresh sign-in). Rules an admin sets (a verified mail domain, the
  household's networks) can only narrow, and accept a match as an adult with use at once, never as an admin; the
  default is the home network plus approval, and with no network listed no link can be made. Under HomersLab the edge
  signs people in; only people it sends arrive, each waits for a Philobiblos admin, Homeward admins are approved
  automatically, and nobody's role is above their Homeward role (a promotion there never raises it by itself). A
  waiting person can use nothing. Open sign-up never.
- **Themes and ideas**: an adult's picked theme is an idea in their own brain, confirmed by them, with no books yet
  (shown as a gap). It stays private to them: not in the shared vocabulary, and nobody else sees, merges or renames
  it until they share it. It counts at once as confirmed; the weight it carries in §6's scores comes with new rows in
  `contracts/scoring-vectors.json` (philobiblos#34 slice 5), and until then it changes no score.
- **Visibility**: owned and read books are the household's; a person's themes, ideas, takeaways and sentences are theirs
  unless they share them.
- **Adults** each have their own brain, picks and reading status. One shared monthly budget.
- **Kids** each have a profile: age band and their own emotional map. Adults give feedback for them.
- **Everyone adult** can share posts to the Inbox, add to the backlog and mark orders.

## 3. Core objects

| Object | Meaning |
|---|---|
| **Book** | A work (title, authors, ISBN when known, language, fiction or not, audience adult or kids, price estimate, cover cached locally) |
| **Copy** | A household owns a book: source (order, invoice, manual), date, price paid |
| **Reading** | One person's status for a book: to_read, reading, read, abandoned; finished date; optional takeaway (one line) |
| **Idea** | A node in an adult's brain ("Markets and value"). Shared vocabulary across the household, per-person density |
| **BookIdea** | A book contributes to an idea at a **layer**: intro, core, deep, counterpoint. Proposed by the AI, confirmed or not |
| **Theme** | A kids' emotional theme (14, see §7; a kids' book has 1–2), or an adult's theme from the starter list (about 30) or typed by them. Picked themes count at once |
| **Sentence** | A free sentence a person writes about what they feel and want to read; private; matched to themes and titles as proposals |
| **Join link** | An admin's household link: expiry, use limit, rules; revocable (ADR 0011) |
| **Candidate** | A book in the backlog for a person or a kid, with where it came from (share, wishlist, AI, manual) and its score parts |
| **Order** | A month's basket → Compose (a mailto with the text filled in) → bookshop quote → invoice → copies |
| **Share** | Something sent to the Inbox from a phone (URL, images, note) and what the AI found in it |

## 4. Screens (see the design canvas)

- **This month**: budget bar (drag both ends; one-month override), Focus card (where the brain grows this month, with a
  mini graph), 2 adult picks labelled with their move and idea, kids' picks (one theme and one author each), order
  progress (picked → composed → quote → invoice → in library), unread pile note.
- **Brain**: ideas as nodes; size = books read; four rings = layers filled; lines = read books spanning two ideas
  (thickness = count); dashed = gap or new idea; focus glows. Views: all, this month's focus, gaps. Side panel: each
  layer, its books, the next suggestion for an empty layer.
- **Backlog**: a GitHub-style list. One filter bar with qualifiers (`is:open is:adult move:deepen price:<30 sort:score`,
  grammar in `contracts/backlog-query.md`), dropdowns per qualifier with counts, saved filters, open/closed tabs
  (closed = not for me, snoozed, owned, repeats), clickable labels that add their qualifier, bulk actions on selected rows.
  Score opens into its parts. Untouched candidates sink.
- **Library**: per person. Adults: status control per book, takeaway prompt when marked read, stats (read, reading,
  unread pile vs limit). Kids: emotional map (theme bars) and loved / meh / not yet per book.
- **Inbox**: shares and AI suggestions; for each, the slides read and the books found with proposed idea/layer or
  kids' theme; add or skip per book.
- **First visit**: skippable, reopenable from Settings: pick themes (the starter list, or your own words), then add read
  books (Goodreads CSV, StoryGraph CSV, a generic CSV of title, author and ISBN, pasted ISBNs or titles; read, not
  owned, unless "I own these" is ticked; unmatched rows go to the Inbox; their ideas are proposals with "accept all"),
  and optionally free sentences. Adults run it for kids, and write sentences only for kids under 13 (by birth year);
  for a kid of 13 or more they pick themes and add read books only.
- **Settings**: budget and split; the household's currency and unknown price (no currency is assumed; a bookshop
  counts only in it); bookshops (the connectors, what each allows, enabled by an admin with a fresh
  sign-in); how your brain grows (mix, unread limit, counterpoints, takeaways); AI plugin
  (provider, jobs on/off, wildcards); score weights; kids' themes; sources; family (people, waiting people, join
  links and their rules, the home network); where Philobiblos runs; what leaves (Open Library,
  the price lookup, SMTP when set, Claude when opted in; Open Library can be turned off).
- **Phone share**: share target (Android PWA, iOS Shortcut). Shows progress while the AI reads.

## 5. Monthly cycle

1. On the 1st (configurable) Philobiblos refreshes: new invoices → copies; new shares processed; prices refreshed for the top
   candidates; scores recomputed.
2. **Adult picks** per adult: `picks = 2` by default, `1` if their unread pile exceeds their limit, `0` if over twice it.
   Mix by setting: **Deepen + Connect** (default; one pick becomes **Broaden** every third month), Deepen + Broaden, or AI.
   Never fiction (unless the person turns it on), never redundant, never owned.
3. **Kids' picks** fill the remaining budget: greedy by kid score, at most one per theme and one per author per month,
   across kids round-robin; skip authors already on the shelf if that setting is on.
4. The order total must be ≤ max; if it is < min, add the next best kids' book that fits.
   Each month starts at the set budget (or its one-month override): unspent money does not roll over.
5. A push notification goes to adults. They adjust, then **Compose**: their own mail app opens with the order filled in.
6. Philobiblos reads the bookshop's reply (quote with prices and delivery), updates the total and marks missing books;
   they roll over to next month's order. The invoice turns order lines into copies.

## 6. Scoring (pure, deterministic; the AI never sets scores)

Adult candidate *c* for person *p* (weights editable, defaults shown):

```
links      = read books of p that c builds on (a confirmed link or BookIdea; or one of the seed's guesses at confidence ≥ 0.8)
bridge     = distinct ideas of p touched by links − 1   (≥ 0)
layerFill  = 12 if c fills an empty core layer, 10 deep, 14 counterpoint (only if intro+core read), 0 otherwise
stale      = min(months since p last finished a book in c's main idea, 4)
newIdea    = 15 if c starts an idea p has no read books in (Broaden), else 0
source     = 5 if on the person's "To buy" list + 5 if from a share
age        = 6 if waiting > 90 days
sink       = −4 per month untouched after 3 months in the backlog (floor −20)
price      = −8 if price > 40, excluded if > 60 (per-person setting)
score      = 15·links + 8·bridge + layerFill + 2·stale + newIdea + source + age + sink + price
move       = the first that applies, in this order (packages/scoring adultMove):
             Fiction if c is fiction; Wildcard if newIdea and links = 0; Broaden if newIdea;
             Counterpoint if layerFill > 0 and the filled layer is counterpoint; Deepen if layerFill > 0;
             Connect if bridge ≥ 1 and both ideas have ≥ 2 read books; else Intro
```

Kids' candidate *c* for kid *k*:

```
themeNew  = 15 if k has no loved/meh book in c's theme
themeThin = −5 × (books k has in that theme, loved counts 2)
author    = −15 if author already on the shelf; +10 if k loved another book by this author and the setting allows
source    = 12 To buy + 10 share
waiting   = min(days on list, 150) / 15
price     = −0.3 × price
score     = 20 + themeNew + themeThin + author + source + waiting + price
```

Test vectors: `contracts/scoring-vectors.json`.

What counts (changed 2026-11-16, M3 g): a link or a book's idea counts once a person confirmed it. A proposal written by
the AI never counts on its own, whatever confidence the model gave it, because the model chooses that number: one that
read a hostile blurb, mail line or caption could answer `confidence: 1` and put an injected idea or link into the brain
and the scores straight away. Only the seed's own guesses (proposed rows without an AI run) still count from 0.8, as the
prototype did. A new idea the AI names is a proposal by name only (`idea_proposal`): it becomes one of the household's
ideas when a person confirms it, and never otherwise (ADR 0009).

## 7. Kids' themes

Feelings & regulation, Worry & anxiety, Empathy & kindness, Friendship, Courage & resilience, Self-worth, Loss & healing,
Family & change, Diversity & belonging, Body & consent, Gender, Sensory & neurodiversity, Mindfulness, Curiosity & imagination.
Age bands: 0–2 board books, 3–5 picture books, 6–8 early readers, 9–12 middle grade. A candidate outside the kid's band is
skipped; books move up with the child.

## 8. AI plugin (see `contracts/ai-plugin.md`)

Jobs: read shares (titles from every slide and video frame), tag books with ideas and layers (adults) or themes and age
band (kids), propose links to read books with a reason and confidence, find gaps and suggest next reads (max 3 per month
per person to the Inbox; wildcards when enabled, at most one open island per person at a time), write the one-line why.
Providers: Ollama (local, the default) or Claude (API key, an explicit opt-in that shows what leaves), switchable. The AI proposes; scoring decides; people confirm links.

## 9. Sources (see `contracts/connectors.md`)

Bookshops are connectors, data an admin enables (philobiblos#27, `docs/connectors.md`): any shop, any mail provider
with IMAP. Mail (the bookshop's mail forwarded to a Philobiblos-only mailbox, read over IMAP; Compose links instead of
drafts), price lookup (an enabled connector's search page, read-only, best effort), metadata (Open Library,
cached; ISBNs and titles only, listed under what leaves, an admin can turn it off), phone share, manual add, imports
(Goodreads, StoryGraph, generic CSV, pasted). Optional outgoing SMTP, off by default, sends one thing only: a join
rule's 6-digit code (ADR 0011). A book can be ordered from the bookshop by email, so web availability never blocks a
pick.

## 10. Milestones

- **M0 Repo and contracts** (see HANDOFF.md)
- **M1 Library and backlog**: seed import, Library (status, takeaways), Backlog (score, sort, group), budget settings
- **M2 Brain and picks**: ideas, layers, links (confirmable), Brain screen, This month with the budget bar and order email copy.
  The published prototype page can retire.
- **M3 Sources and AI**: IMAP read + Compose + quote/invoice parsing (media worker), Inbox, share target, Claude and Ollama providers, monthly job,
  push. The Claude scheduled tasks can retire.
- **M4 Family and kids**: first bookshops and mail providers as configuration (philobiblos#27), then people, joining
  and the first visit (ADR 0011, slices in philobiblos#34); partner's brain, kid profiles and feedback, HomersLab
  packaging polish, backups
- **Later**: Jelu / BookLore sync for reading status, library availability (borrow before buying), wildcard islands view

## 11. Open questions (owner: the maintainer)

1. Instagram: decided (ADR 0006: images + link + caption, no session); whether to use Meta's oEmbed (it needs an app
   token) is still open.
2. Kids' names, birth years and the partner's name (the design uses placeholders).
3. ~~Should the budget roll over unspent money?~~ Decided 2026-11-15: no; each month starts at the set budget (§5).
