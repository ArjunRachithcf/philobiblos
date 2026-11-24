// Amounts (philobiblos#27, #40, #62): every amount is an integer of hundredths of the household's currency, whichever it
// is. Hundredths are a fixed scale, not the currency's minor unit: a currency without decimals keeps whole units as
// multiples of 100. How many decimals a person types and reads is the currency's own (`digits`), as the server's Intl
// knows it (apps/server household/currency.ts `currencyDigits`): the server sends it to the screens, so a browser whose
// Intl counts differently never accepts what the server refuses. No currency is built in.
//
// A currency with three decimals is kept in hundredths too (docs/spec.md §6): its amounts read when their
// third decimal is 0 (`1.250`), and one with a thousandth (`1.255`) is refused everywhere, never rounded.

/**
 * The most any amount may be, in hundredths: 10,000,000,000 of any currency. Not a typo guard (no one number is one in
 * every currency) but arithmetic's: an entry's every line at the most copies still sums exactly.
 */
export const AMOUNT_CEILING_C = 1_000_000_000_000;

/** The unit an amount in a currency with `digits` decimals is a multiple of, in hundredths: 100 without decimals, else 1. */
export const unitC = (digits: number): number => 10 ** (2 - Math.min(2, Math.max(0, digits)));

/** Whether `c` is whole hundredths that a currency with `digits` decimals can write: without decimals, whole units only. */
export function wholeIn(c: number, digits: number): boolean {
  return Number.isInteger(c) && c % unitC(digits) === 0;
}

/**
 * Whole units and the decimals of an amount as written, in hundredths: decimals beyond the second must be 0 (a
 * thousandth is not kept), and the amount must be whole in the currency and at most the ceiling; else null.
 */
export function toHundredths(units: string, decimals: string, digits: number): number | null {
  if (/[1-9]/.test(decimals.slice(2))) return null;
  const c = Number(units) * 100 + Number(decimals.slice(0, 2).padEnd(2, '0'));
  return c <= AMOUNT_CEILING_C && wholeIn(c, digits) ? c : null;
}

/**
 * An amount as a person types it, in hundredths: digits, then a point or a comma and at most the currency's decimals
 * (two in one without them, for a spreadsheet's `1500.00`), an amount the currency can write (`1500` or `1500.00` in
 * one without decimals, never `1500.50`; `1.250` in one with three, never `1.255`). No sign, symbol or grouping: what
 * cannot be placed is refused, never guessed.
 */
export function parseAmount(s: string, digits: number): number | null {
  const m = /^(\d{1,11})(?:[.,](\d{1,4}))?$/.exec(s.trim());
  if (!m || (m[2] ?? '').length > Math.max(2, digits)) return null;
  return toHundredths(m[1]!, m[2] ?? '', digits);
}

/** Whether an amount as written has a part below hundredths (`1.255`): why it is refused, said as such. */
export function belowHundredths(s: string): boolean {
  const m = /[.,](\d{3,4})$/.exec(s.trim());
  return m !== null && /[1-9]/.test(m[1]!.slice(2));
}
