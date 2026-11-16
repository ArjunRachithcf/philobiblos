# Sharing to Shelf from a phone

A share sends a post's images, its link and its caption to your Inbox (ADR 0006). Shelf never logs in to Instagram.
Images only for now (JPEG, PNG, WebP, GIF); video arrives with M3 f. The rules are in `contracts/connectors.md` ("Phone
share") and `docs/security.md`.

## Android

1. Open Shelf in Chrome and sign in once.
2. Chrome's menu → **Add to home screen** (Install). Shelf now appears in the share sheet.
3. In Instagram: save the post's images (or share the post), then **Share** → **Shelf**. The share screen opens and shows
   what arrived; tap **Send to the Inbox** (or **Discard**). Shelf never sends a share without that tap, because any
   website could open the share screen too. An untouched share is gone after an hour, and sharing again replaces it.
   Then the screen shows the media worker's progress. If it says to open Shelf once, open it and share again (the share target
   needs Shelf to have been opened in that browser before).

## iPhone: the "Send to Shelf" Shortcut

The Shortcut sends with a **share token** of yours. A token can post to your Inbox and do nothing else; it is shown
once, and you can revoke it in Settings at any time (do so when a phone is lost).

1. In Shelf: **Settings** → **Phone share** → name it (say "iPhone Shortcut") → **Make a share token**. Leave the page
   open: the token and its QR code are shown this once.
2. On the iPhone, open **Shortcuts** → **+** → name it **Send to Shelf**. In its details, turn on **Show in Share Sheet**
   and let it receive **Images** and **URLs** (and Text).
3. Add **Convert Image** (Shortcut Input → **JPEG**). iPhone photos are HEIC, which Shelf refuses.
4. Add **Get Contents of URL**:
   - URL: the address Settings shows, `https://<your Shelf>/api/shares`;
   - Method **POST**, Request Body **Form**;
   - Headers: **Authorization** = scan the QR code with the Camera, tap the text to copy it (it starts with
     `Bearer `), and paste it here;
   - Form fields: `url` = Shortcut Input's **URLs**, `text` = Shortcut Input's **Text** (the caption), and `media` =
     **Converted Image**, as a File.
5. Back in Shelf, press **Done**: the token is gone from the page, and Shelf cannot show it again (it keeps only a
   hash). Lost it? Revoke it and make another.
6. Try it: in Instagram, **Share** → **Send to Shelf**. The share is in your Inbox a moment later.

Limits: 30 files of 20 MB a share, 30 shares in ten minutes. A valid token always works; after ten wrong ones from one
address, or naming one token, in ten minutes, Shelf answers further wrong ones with "wait" (429).
