# ADR 0011: People, joining and the first visit

Status: **Accepted** · 2026-11-16 (the grilling in philobiblos#28, Q1–Q21; the slices in philobiblos#34)

**Decision**: Standalone is the base: one person is a household of one, and more people join by an admin's invite or
by a join link an admin makes, never by open sign-up. Under HomersLab the same model applies, tightened: sign-in comes
from the edge, and a Philobiblos admin approves who may use the app. Every person has a skippable first visit (themes,
then read books). It changes parts of ADR 0007 (one kind of mail is sent), ADR 0009 (one more outgoing host) and
ADR 0010 (who is added under HomersLab, and how), which say so where they differ.

## People

- **A household of one.** A single user is a household with one admin. Family features (other people's picks, the
  budget's split, kids' sections, the People list beyond yourself) appear once there is a second person.
- **Kids** stay profiles run by adults and never sign in before the first release (ADR 0010).
- **What others see** (as before): owned and read books are visible to the household; a person's themes, their ideas
  and the density of their brain, their takeaways and their sentences (below) are private unless they share them. The
  vocabulary of idea names stays shared (ADR 0005).

## Joining, standalone

- **Invites** stay as ADR 0010 has them (one person, one-time, 7 days).
- **Join links**: an admin may make household join links. Defaults: valid 7 days, 5 uses; revocable at any time; made
  with a fresh sign-in (ADR 0010's 10 minutes). The token is in the `#fragment` and kept as its SHA-256, like every
  link. Whoever opens one gives a name and enrols a passkey, then waits for an admin, unless a rule accepts them. A
  name that matches a member's gets the same answer as any other (no "name taken"), so names reveal no one.
- **Waiting**: at most **10** people wait in a household; a full list takes no one new until an admin decides. Admins
  are told (the Inbox and a push of its kind alone) and approve or decline. **Every approval and every decline needs a
  fresh sign-in** (below). Approval sets the role, adult by default, admin only by an admin's choice. The waiting list
  shows, for each person, the link they used, when, whether they came from the household's networks, and the verified
  address if a rule asked for one: a stranger with a leaked link can type a family member's name, so a name alone is
  never the reason to approve. A waiting person can use nothing: one "waiting" page, no household data, nothing they
  add is stored. A decline, or 7 days unanswered, deletes the request and its passkey.
- **Fresh sign-in**: standalone, a sign-in in the last 10 minutes (ADR 0010). Under HomersLab, where Philobiblos has no
  sessions of its own, the edge's signal that the person signed in recently; where the edge sends none, a Philobiblos
  step-up before the change (philobiblos#34 slice 1). Either way the request is a change and carries Philobiblos's
  own `Origin`.
- **Rate limits** on opening a link, joining and asking for a code, per client address and per link; an unknown,
  expired, revoked, used-up or out-of-network link gets the same answer (no enumeration). Revoking a link declines its
  waiting people. An admin who is removed or stops being one takes their links along, like their invites.

## Joining under HomersLab (Homeward)

- Sign-in comes from HomersLab's edge (ADR 0010); Philobiblos's passkeys, invites and join links are off.
- Only people the edge sends can arrive, and each waits for a Philobiblos admin's approval, as above.
- **Homeward admins are approved automatically**, as Philobiblos admins (ADR 0010's earlier behaviour, within the
  ceiling below).
- **The ceiling**: a person's Philobiblos role is never above their Homeward role, and it is not a copy of it.
  Philobiblos follows removals and demotions at once: a demotion lowers the role on the person's next request, a
  person Homeward removes no longer arrives (the edge stops sending them), and the household provider marks them
  removed when it reports it. Until then Philobiblos may still hold the old role, so admin-only pushes (`join`) carry
  their kind alone and acting on one needs a request, which applies the ceiling; a removal or a demotion seen deletes
  the person's push subscriptions for admin-only kinds.
- **A Homeward promotion never raises a Philobiblos role by itself.** Only a first arrival as a Homeward admin is
  approved as admin; any later promotion is a Philobiblos admin's choice, with a fresh sign-in, within the ceiling.
- Kids: the edge's `kid` role is still answered 403.

## Rules that accept automatically

- An admin sets rules per household or per join link. **Rules only narrow**: a link's rules add to the household's and
  never loosen them.
- **Mail domain**: the person's address must end in `@<domain>` and be verified. Standalone: an optional outgoing SMTP
  server (off by default; set by whoever runs Philobiblos, like IMAP) sends a **6-digit code**, and nothing else
  (philobiblos#34 slice 4a has the limits). Under HomersLab: only the address the edge passes as verified by the
  household's sign-in (`X-HomersLab-Email`, ArjunRachithcf/homeward#248; slice 4b), never one a person types.
- **Location** means the household's networks: the home network ranges an admin lists, or the mesh under HomersLab
  (the edge's signal, ArjunRachithcf/homeward#252). Never GPS and never IP geolocation; "nearby" is not offered.
- A person who matches every rule of a link set to accept automatically is accepted **as an adult, never as an admin**,
  and can use the app at once. Everyone else waits, or is refused when the link allows only matches.
- **The default** for a new link is the household's home network plus approval: it opens only from the listed
  networks, and everyone who opens it waits. **With no network listed, no link can be made**: an empty list never
  means "anywhere". Settings proposes the private range the admin is on, for them to confirm.

## The first visit

- Every person gets one, **skippable** and reopenable from Settings: pick themes, then add read books. Adults run it for
  kids.
- **Starter themes** ship with Philobiblos: about 30 adult themes and the kids' themes by age band (spec §7), in
  translatable files. Anyone may type their own.
- **Picked themes count at once** (the person chose them; nothing to confirm).
- **Imports**: Goodreads CSV, StoryGraph CSV, a generic CSV (title, author, ISBN), and pasted ISBNs or titles. Barcode
  scanning comes later. Imported books are **read, not owned**, unless the person ticks "I own these". Unmatched rows go
  to the Inbox.
- **Ideas from imported books are proposals**, with "accept all" per import and per book (ADR 0004, ADR 0005: nothing a
  model or a data source says counts without a person's tap). Without AI, they come from the book data's subjects alone.
- **Free sentences**: a person may write what they feel and want to read about. They are private to that person. With
  the AI on, Ollama proposes matching themes and titles, Claude only if the household opted in and its "what leaves"
  lists sentences; without AI, plain matching against the vocabulary. Every match is a proposal until the person taps.
- **Kids' sentences**: adults write them only for a kid **under 13**, private to that kid's adults. For a kid of 13 or
  more, adults may still pick themes and add read books; the kid's own sentences wait for a kid sign-in (M4 or later).
  The age comes from the stored birth year.
- **Book data** comes from Open Library: ISBNs or titles only, through the egress allowlist (ADR 0009), listed under
  "what leaves" in Settings. An admin can turn it off; matching is then local only.

## Decided by default (writing this ADR)

These follow from the answers above and are the maintainer's to change:

- A kid's age is the current year minus the birth year, so the year they turn 13 counts as 13 (the stricter reading).
- "That kid's adults" are the household's adults, who already act for every kid; a per-kid list of adults is later.
- An import's to-read and currently-reading rows keep their status; only rows the export marks read are read.
- Under HomersLab the location rule is offered only once the edge says a request came over the mesh
  (ArjunRachithcf/homeward#252); until then it is not shown there.
- A domain on a shipped list of public mail providers cannot accept automatically (anyone can have such an address).
- The verification code is kept as an HMAC with a key outside the database, not a plain SHA-256: six digits are a
  million guesses for anyone with a copy of the database.
- The SMTP server's password is a secret from the environment or a file, never in SQLite, like IMAP's.
- At most **10** people wait in a household (#28 says "capped").
- A waiting request **lapses after 7 days**.
- **Revoking a link declines its waiting people** (a revoked link is one an admin no longer trusts).
- A link may be set to **refuse non-matches** instead of letting them wait.
- The code: **10 minutes, 5 tries, one live code per address**, bound to the join request that asked for it, at most 3
  codes an hour and 10 a day per address (50 tries a day at most, against a million codes), compared in constant time.
  Its HMAC key is derived from the sealing key with its own label (`join-code`), so there is no new secret to keep.
- The address being verified is kept on the join request only; once the request is decided or lapses it is deleted,
  and an accepted person keeps only the domain that matched.
- **Homeward admins arrive as Philobiblos admins**: Q3 says "approved automatically"; the role follows from ADR 0010's
  earlier behaviour and the ceiling.
- **A Homeward promotion never raises a Philobiblos role by itself.**
- **Every approve and decline needs a fresh sign-in**, in both modes; under HomersLab "fresh" is the edge's recent
  sign-in signal, or a Philobiblos step-up where it sends none.

**Considered**: open sign-up (anyone who finds the address joins); magic links by mail instead of passkeys (the mail
would become the sign-in, ADR 0010); GPS or IP geolocation for "location" (spoofable, and more than Philobiblos needs to
know); counting ideas from imports at once (an import would fill a brain no one confirmed).
