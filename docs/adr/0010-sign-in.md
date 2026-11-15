# ADR 0010: Sign-in

Status: **Accepted** · 2026-11-15

**Decision**: Standalone Shelf signs people in with **passkeys only**; under HomersLab it trusts HomersLab's forwarded
identity from the configured proxy only. There are no passwords anywhere.

- **Standalone, the first admin.** At start-up, while no admin has a passkey, Shelf writes a one-time setup link to
  `SHELF_DATA_DIR/setup-link.txt` (mode 0600; valid 24 hours; a restart replaces it). The log names the file, never the
  link. Whoever can read Shelf's data folder can become its first admin, which is the same person who could replace
  the database. If the household was imported (`pnpm seed`), the setup claims the admin of the same name.
- **Standalone, everyone else.** An admin adds people (adults, admins, kids) and sends an adult a one-time invite link
  (7 days). Kids never sign in; adults act for them. A person adds a passkey on another device with a new invite.
- **Links** carry their token in the `#fragment`: it never reaches a server log or a `Referer`, and the page removes
  it from the address bar and history at once. The database keeps only the token's SHA-256.
- **Passkeys** (WebAuthn via `@simplewebauthn/server`): discoverable credentials, user verification required at
  enrolment and at every sign-in, no attestation, the signature counter checked. Challenges are one-time and last
  5 minutes. The sign-in steps are rate limited (20 a minute per address). A failed sign-in has one answer whatever
  failed, so it does not reveal which passkeys exist.
- **Sessions**: a 256-bit random cookie `shelf_session` (HttpOnly, Secure, SameSite=Strict, Path=/); the database keeps
  its SHA-256. A session ends after 30 days, after 7 days unused, at sign-out, when the person is removed, or when they
  become a kid. Every request that changes something must carry an `Origin` equal to `SHELF_ORIGIN`
  (a phone share with its token excepted).
- **`SHELF_ORIGIN`** is the address people open: WebAuthn's origin and relying party. It must be https, or http on
  localhost. Under HomersLab it is required (HomersLab gives the address).
- **HomersLab**: `X-HomersLab-Person` (a stable id), `X-HomersLab-Name` and `X-HomersLab-Role` (admin, adult or kid),
  read only from `SHELF_TRUSTED_PROXY`. A person is added the first time HomersLab sends them and follows HomersLab's
  name and role after that; without a role, or as a kid, the answer is 403. People are managed in HomersLab, so
  Shelf's own household editing and passkey routes answer 409 and 404 there.
- **Recovery**: an admin who loses every passkey asks another admin for an invite. A household with one admin keeps
  a second passkey (another device, or a synced one). A command-line way to issue an invite is open.

**Considered**: passwords with TOTP (phishable, and a second secret to protect); magic links by mail (Shelf would
need to send mail, which ADR 0007 rules out); letting the first visitor become admin (anyone who reaches the port
first wins).
