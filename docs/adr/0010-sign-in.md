# ADR 0010: Sign-in

> Written when the app was called **Shelf**; it is **Philobiblos** since 2026-11-16 (philobiblos#30). This record is
> kept as decided: read Shelf as Philobiblos, `SHELF_*` as `PHILOBIBLOS_*` and `shelf_session` as `philobiblos_session`;
> a shelf of books is still a shelf.

Status: **Accepted** · 2026-11-15

> **Superseded in part** (2026-11-16, ADR 0011):
> - **Standalone, everyone else**: besides an admin's invites, an admin may make household join links (7 days, 5 uses,
>   revocable); who opens one enrols a passkey and waits for an admin, unless a rule accepts them as an adult.
> - **HomersLab**: a person the edge sends for the first time is no longer added with the role it sends. They wait for
>   a Philobiblos admin's approval, except a Homeward admin, who is approved as admin. After that a person follows
>   HomersLab's name, but not its role: the role is capped at the Homeward one, not copied, so a demotion lowers it and
>   a promotion never raises it by itself. Household editing still answers 409 there, except approving and declining
>   waiting people and setting a role within the ceiling (each with a fresh sign-in: the edge's recent sign-in signal,
>   or a Philobiblos step-up).
> - **Considered**, magic links: Philobiblos may now send mail, but only a code that proves an address for a join rule.
>   It is never a sign-in; the passkey still is.

**Decision**: Standalone Shelf signs people in with **passkeys only**; under HomersLab it trusts HomersLab's forwarded
identity from the configured proxy only. There are no passwords anywhere.

- **Standalone, the first admin.** At start-up, while no admin has a passkey, Shelf writes a one-time setup link to
  `SHELF_DATA_DIR/setup-link.txt` (mode 0600; valid 24 hours; a restart replaces it). The log names the file, never the
  link. Whoever can read Shelf's data folder can become its first admin, which is the same person who could replace
  the database. If the household was imported (`pnpm seed`), the setup claims the admin of the same name.
- **Standalone, everyone else.** An admin adds people (adults, admins, kids) and sends an adult without a passkey a
  one-time invite link (7 days). Once someone has a passkey, only they add more: "Add a passkey on another device"
  makes a one-time link for themselves (24 hours). An admin cannot slip a passkey into an adult's account, and each
  passkey records whose invite made it (shown in "Your passkeys"). A person's enrolment spends every other open link
  of theirs, and an admin's invite is refused at the last step if the person has a passkey by then. An admin who is
  removed or stops being one takes their open invites along. Each link has its kind (`setup`, `admin`, `self`,
  `recovery`) in the database. Kids never sign in; adults act for them.
- **Fresh sign-in.** Making any link that adds a passkey (an invite, or your own) needs a sign-in in the last
  10 minutes; an older session gets 403 and signs in again. A stolen, older cookie cannot add a passkey.
- **Links** carry their token in the `#fragment`: it never reaches a server log or a `Referer`, and the page removes
  it from the address bar and history at once. The database keeps only the token's SHA-256.
- **Passkeys** (WebAuthn via `@simplewebauthn/server`): discoverable credentials, user verification required at
  enrolment and at every sign-in, no attestation, the signature counter checked. Challenges are one-time and last
  5 minutes. The sign-in steps are rate limited (20 a minute per address). A failed sign-in has one answer whatever
  failed, so it does not reveal which passkeys exist.
- **Sessions**: a 256-bit random cookie `shelf_session` (HttpOnly, Secure, SameSite=Strict, Path=/); the database keeps
  its SHA-256, and which passkey signed it in. A sign-in replaces the browser's earlier session. A session ends after
  30 days, after 7 days unused, at sign-out, at "Sign out everywhere", when the passkey that signed it in is removed,
  when the person is removed, or when they become a kid.
- **Requests**: every request that changes something must carry an `Origin` equal to `SHELF_ORIGIN`, in both modes.
  The one exception is `POST /shares` with a phone share token (an iOS Shortcut sends no Origin): a request with
  `Authorization: Bearer` is authenticated by that token alone, never by a cookie or a header next to it.
- **The last admin** is the last admin who can sign in: an admin stops being one, or is removed, only while another
  admin with a passkey remains.
- **`SHELF_ORIGIN`** is the address people open: WebAuthn's origin and relying party. It must be https, or http on
  localhost. Under HomersLab it is required (HomersLab gives the address).
- **HomersLab**: `X-HomersLab-Person` (a stable id), `X-HomersLab-Name` and `X-HomersLab-Role` (exactly `admin`,
  `adult` or `kid`), read only from `SHELF_TRUSTED_PROXY`. The address alone is not enough: HomersLab's edge must
  delete every `X-HomersLab-*` header a client sends and set the three itself (HomersLab #236), and only the edge may
  reach Shelf's port (HomersLab ADR 0020's per-app firewall). HomersLab promises the first by setting
  `SHELF_EDGE_IDENTITY=homerslab-v1` (the manifest asks for it as `identity.edge` and does not set it); homerslab
  mode refuses to start without it, without `SHELF_TRUSTED_PROXY` and
  without `SHELF_ORIGIN`. A person (an admin too) is added the first time the edge sends them, with the role it sends,
  and follows HomersLab's name and role after that; without a valid role, or as a kid, the answer is 403. The
  manifest's audience is `adults`. People are managed in HomersLab, so Shelf's own household editing answers 409 and
  its passkey and session routes 404 there.
- **Recovery**: an admin who loses every passkey asks another admin for an invite. Without one, whoever runs Shelf's
  container runs `shelf recover <admin handle>` (`docker exec <container> shelf recover alex`): it writes a one-time
  link (24 hours) for that admin into `setup-link.txt`, the same file, mode 0600, never to the terminal or a log. The
  file goes once the link is used. The file is created anew each time (`O_EXCL|O_NOFOLLOW` after removing the old
  name), so a link planted at that path is never followed.

**Considered**: passwords with TOTP (phishable, and a second secret to protect); magic links by mail (Shelf would
need to send mail, which ADR 0007 rules out); letting the first visitor become admin (anyone who reaches the port
first wins).
