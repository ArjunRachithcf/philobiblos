# Philobiblos logo: how to use it

**The idea:** a Greek key (meander) that draws a **P** and runs out as a **bookmark ribbon**: Greek, the name, and "what to read next" in one line.

## Files
The masters are in this folder (`docs/brand/`); the web icons are in `apps/web/public/`.

| Use | File |
|---|---|
| Symbol (master, ≥ 32 px) | `symbol.svg` (+ `-black`, `-white`, `-mono-1b6e66`) |
| Symbol, small cut (< 32 px: favicon, tabs) | `symbol-small.svg` (one turn fewer, heavier) |
| Horizontal lockup | `horizontal.svg` (+ `-black`, `-white`, `-mono-1b6e66`) |
| Stacked lockup | `stacked.svg` (+ `-black`, `-white`, `-mono-1b6e66`) |
| Wordmark only | `wordmark.svg` |
| Web | `apps/web/public/`: `favicon.svg` (teal, white in a dark browser), `favicon.ico` (16/32/48, white on a teal tile), `apple-touch-icon.png`, `icon-192/512.png`, `maskable-512.png`; the icons are listed in `manifest.webmanifest` and linked from `apps/web/index.html` |

All masters are outlined paths: no live text, strokes, gradients or images.

## Construction
256-unit grid, one bar weight (18), equal gaps (19) everywhere, square corners. The ribbon notch is 11 deep.

## Colour
| | HEX | RGB |
|---|---|---|
| Philobiblos teal (primary) | `#1B6E66` | 27 110 102 |
| Ink (text, one-colour) | `#000000` | 0 0 0 |
| On dark backgrounds | `#FFFFFF` | 255 255 255 |

Teal on white has a contrast of 6.05:1 (AA for text). On dark or teal backgrounds, use the white version.

## Type
Wordmark: lowercase "philobiblos" in Adwaita Sans SemiBold (600), SIL Open Font License, outlined. The ascenders (h l b b l) echo spines on a shelf. Don't retype it; use the files. Adwaita Sans also works as the interface font.

## Clear space and sizes
- Clear space on every side: one bowl gap ×2 (≈ the width of the bar plus the gap, 37 units at 256).
- Symbol: use the small cut below 32 px; the minimum is 16 px.
- Horizontal lockup: minimum 96 px wide on screen, 25 mm in print.

## Don't
Rotate it, mirror it (the P must read), round its corners, outline it, add shadows or gradients, recolour parts of it (the ribbon stays the same colour as the key), place the teal version on busy photos, or set the name in another font.

## Trademark
- No trademark search has been done; do a professional check before a public release.
