// A book's ISBN as Philobiblos keeps it: 13 digits starting 978 or 979 whose check digit holds. An ISBN-10 is kept as its
// ISBN-13. A wrong check digit (a typo) would match no book, or the wrong one, so it is no ISBN (philobiblos#43).

const digits13 = (s: string) => [...s].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0);

/** The ISBN-13 check digit of 12 digits. */
export const checkDigit13 = (twelve: string): number => (10 - (digits13(twelve) % 10)) % 10;

/**
 * `raw` as an ISBN-13, or null: spaces and hyphens are left out, then it must be an ISBN-13 (978 or 979) or an ISBN-10
 * (its last character may be X) whose check digit holds. Another product's EAN-13 is null.
 */
export function bookIsbn(raw: string): string | null {
  if (raw.length > 40) return null;
  const s = raw.replace(/[\s-]/g, '').toUpperCase();
  if (/^97[89]\d{10}$/.test(s)) return checkDigit13(s.slice(0, 12)) === Number(s[12]) ? s : null;
  if (!/^\d{9}[\dX]$/.test(s)) return null;
  const d = [...s].map((c) => (c === 'X' ? 10 : Number(c)));
  if (d.reduce((n, x, i) => n + x * (10 - i), 0) % 11 !== 0) return null;
  const twelve = `978${s.slice(0, 9)}`;
  return twelve + checkDigit13(twelve);
}
