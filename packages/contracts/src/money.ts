// Amounts (philobiblos#27, #40): every amount is an integer of hundredths of the household's currency, whichever it is.
// Hundredths are a fixed scale, not the currency's minor unit: a currency without decimals keeps whole units as
// multiples of 100, and one with three keeps two of them. How many a person types and reads is the currency's own, as
// Intl knows it: no currency is built in.

/**
 * The most any amount may be, in hundredths: 10,000,000,000 of any currency. Not a typo guard (no one number is one in
 * every currency) but arithmetic's: an entry's every line at the most copies still sums exactly.
 */
export const AMOUNT_CEILING_C = 1_000_000_000_000;

/** The decimals amounts in `currency` are written with: Intl's, at most the two hundredths hold; 2 without one. */
export function fractionDigits(currency: string | null | undefined): 0 | 1 | 2 {
  if (!currency) return 2;
  try {
    const d = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return Math.min(2, Math.max(0, d)) as 0 | 1 | 2;
  } catch { return 2; }
}

/** Whether `c` is whole hundredths that `currency` can write: in one without decimals, whole units only. */
export function wholeIn(c: number, currency: string | null | undefined): boolean {
  return Number.isInteger(c) && c % 10 ** (2 - fractionDigits(currency)) === 0;
}

/**
 * An amount as a person types it, in hundredths: digits, then a point or a comma and at most the currency's decimals
 * (none in a currency without them). No sign, symbol or grouping: what cannot be placed is refused, never guessed.
 */
export function parseAmount(s: string, currency: string | null | undefined): number | null {
  const d = fractionDigits(currency);
  const m = (d ? new RegExp(`^(\\d{1,11})(?:[.,](\\d{1,${d}}))?$`) : /^(\d{1,11})$/).exec(s.trim());
  if (!m) return null;
  const c = Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
  return c <= AMOUNT_CEILING_C ? c : null;
}
