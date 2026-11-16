# ADR 0006: Instagram ingestion

> Written when the app was called **Shelf**; it is **Philobiblos** since 2026-11-16 (philobiblos#30). This record is
> kept as decided: read Shelf as Philobiblos, `SHELF_*` as `PHILOBIBLOS_*` and `shelf_session` as `philobiblos_session`;
> a shelf of books is still a shelf.

Status: **Accepted** · 2026-11-15 (option 3 dropped by the maintainer on 2026-11-15, see "Changed")

**Decision**: Phone share is the way in. A share carries the post's **images, link and caption**; Shelf never holds an
Instagram session.

- A shared Instagram link alone cannot be read by a server without the user's session, and Shelf will not have one.
- What remains:
  1. **Share images, not only the link**: the iOS Shortcut / Android PWA share target sends the post's images (users save
     the carousel to Photos first, or the Shortcut extracts them) with the link and caption. Reliable, more taps.
  2. **oEmbed** without any user login: caption and first image only. Cheap, incomplete; optional. (Meta's oEmbed needs
     an app access token; whether Shelf uses it is an open question.)
- Video: the share sends the video file; frames are taken in the media worker (ADR 0009).
- **Changed** (2026-11-15): option 3, an opt-in helper with the user's own session (a headless browser on the server or
  a browser extension pushing slides), is dropped. Holding a person's Instagram session would put a valuable credential
  on the server, break Instagram's terms and fail silently; security comes first (ADR 0009).
- Until M3, the prototype's scheduled tasks keep reading carousels.
