// Amounts as the screens write them (philobiblos#27): the API's money is in hundredths of the household's currency
// (Me.money), written here in that currency in the reader's own locale. No currency is built in: a household that has
// not chosen one yet sees plain numbers. Each currency is written and typed with its own decimals, as the server counts
// them (Me.money.digits, Settings' currencies; philobiblos#40, #62): never this browser's Intl count, which can differ.
import { createContext, useContext } from 'react';
import { belowHundredths, parseAmount, unitC } from '@philobiblos/contracts/money';

export type Currency = string | null | undefined;

/**
 * `c` hundredths in the household's currency, with its `digits` decimals; whole amounts without decimals unless `cents`
 * asks for them. An amount kept from before that the currency cannot write (a fraction where it has none) is shown in
 * hundredths, as it is, never rounded.
 */
export function money(c: number, currency: Currency, digits: number, cents: 'auto' | 'always' = 'auto'): string {
  const max = c % unitC(digits) ? 2 : digits;
  const min = cents === 'always' || c % 100 ? max : 0;
  const opts: Intl.NumberFormatOptions = { minimumFractionDigits: min, maximumFractionDigits: Math.max(min, max) };
  if (currency) {
    try { return new Intl.NumberFormat(undefined, { ...opts, style: 'currency', currency }).format(c / 100); } catch { /* a code this browser does not know: the code, then the number */ }
    return `${currency} ${new Intl.NumberFormat(undefined, opts).format(c / 100)}`;
  }
  return new Intl.NumberFormat(undefined, opts).format(c / 100);
}

/** An amount as typed in a field (`18.90`, `18,90`, `1500`), in hundredths; null when the currency cannot write it. */
export const typed = (s: string, digits: number): number | null => parseAmount(s, digits);

/** An amount to show as an example of how to type one: `18.90`, `1890` in a currency without decimals, `18.900` with three. */
export const amountExample = (digits: number): string => (digits ? (18.9).toFixed(digits) : '1890');

/** Why a typed amount is not one, and how to write one: a thousandth is said as such (amounts are kept in hundredths). */
export const amountHelp = (s: string, digits: number): string => (belowHundredths(s)
  ? `amounts are kept to hundredths, so the third decimal is 0, for example ${amountExample(digits)}`
  : `for example ${amountExample(digits)}`);

/** `c` hundredths as a field shows it to edit: digits and a point, the currency's decimals only when there are some. */
export function asTyped(c: number, digits: number): string {
  const units = Math.floor(c / 100);
  const rest = c % 100;
  if (!rest) return String(units);
  return `${units}.${String(rest).padStart(2, '0')}${'0'.repeat(Math.max(0, digits - 2))}`;
}

/**
 * The budget bar's step and its end, in hundredths, sized by the household's own amounts so a bar looks and moves the
 * same in any currency: a step is a fifth of the unknown price or a sixtieth of the budget's top, whichever is larger
 * (25 and 150 → steps of 5), the end at least 16 unknown prices (400). Without an unknown price the budget sets both. Both are
 * whole units of the currency.
 */
export function budgetBar(b: { min: number; max: number }, total: number, unknownC: number, digits: number): { step: number; scale: number } {
  const unit = unitC(digits);
  const whole = (c: number) => Math.max(unit, Math.round(c / unit) * unit);
  const top = Math.max(b.max, total);
  const ref = whole(unknownC > 0 ? unknownC : top / 6 || 5 * unit);
  const step = whole(Math.max(ref / 5, top / 60));
  const round = 4 * ref;
  return { step, scale: Math.max(16 * ref, Math.ceil((top * 1.5) / round) * round) };
}

/** The currency as a field's label says it ("At least (…)"); "amount" before the household has one. */
export const unit = (currency: Currency): string => currency || 'amount';

/** The scores' price limits in force (Me.money): null = none; own false while they follow the unknown price. */
export interface PriceLimits { high: number | null; max: number | null; own?: boolean }

/** What Settings' currency form holds: the code chosen, and each amount as typed. */
export interface MoneyForm { code: string; unknown: string; own: boolean; high: string; max: string }
export interface MoneyBody { currency?: string; unknownPrice?: number; priceLimits?: { high: number; max: number } | null }

/**
 * Settings.money as a PATCH sends it: only what was changed (philobiblos#62). A field left as it was shown is not sent,
 * so a stored amount its currency cannot write now (a fraction from before it lost its decimals) is never rounded by an
 * unrelated save. What was changed is typed in the currency being saved, with the decimals the server says it has
 * (`digitsOf`).
 */
export function moneyPatch(f: MoneyForm, stored: { currency: Currency; unknownPrice: number | null; priceLimits: PriceLimits | null }, digitsOf: (code: Currency) => number): { body: MoneyBody } | { error: string } {
  const before = digitsOf(stored.currency);
  const shown = (c: number | null | undefined) => (c == null ? '' : asTyped(c, before));
  const cur = f.code || stored.currency;
  const digits = digitsOf(cur);
  const body: MoneyBody = {};
  if (f.code && f.code !== stored.currency) body.currency = f.code;
  if (f.unknown.trim() !== shown(stored.unknownPrice)) {
    const u = typed(f.unknown, digits);
    if (u === null) return { error: `Enter the unknown price as an amount: ${amountHelp(f.unknown, digits)}.` };
    body.unknownPrice = u;
  }
  const l = stored.priceLimits;
  const wasOwn = Boolean(l?.own);
  if (!f.own) { if (wasOwn) body.priceLimits = null; }
  else if (!wasOwn || f.high.trim() !== shown(l?.high) || f.max.trim() !== shown(l?.max)) {
    // Both parts go together (the server wants both); a field shows its amount exactly (asTyped), so an untouched one reads as stored.
    const h = typed(f.high, digits);
    const m = typed(f.max, digits);
    if (h === null || m === null) return { error: `Enter both price limits as amounts: ${amountHelp(h === null ? f.high : f.max, digits)}.` };
    if (h > m) return { error: 'The price above which a book is dear is above the one that leaves it out.' };
    body.priceLimits = { high: h, max: m };
  }
  return { body };
}

/** A budget's end as its field shows it: whole units of the household's currency. */
export const wholeUnits = (c: number): string => String(Math.round(c / 100));

/** Settings.budget as a PATCH sends it: whole units, and only an end that was changed (an untouched one is kept as stored). */
export function budgetPatch(min: string, max: string, stored: { min: number; max: number }): { body: { min?: number; max?: number } } | { error: string } {
  const read = (s: string, kept: number) => (s === wholeUnits(kept) ? kept : /^\d+$/.test(s) ? typed(s, 0) : undefined);
  const lo = read(min, stored.min);
  const hi = read(max, stored.max);
  if (lo === undefined || hi === undefined) return { error: 'Enter whole amounts, for example 100.' };
  if (lo === null || hi === null) return { error: 'Enter at most 10,000,000,000.' };
  if (lo > hi) return { error: 'The lower end is above the upper end.' };
  return { body: { ...(lo !== stored.min ? { min: lo } : {}), ...(hi !== stored.max ? { max: hi } : {}) } };
}

/** The household's money for the screens below the app (App.tsx provides it from /me). */
export const MoneyContext = createContext<{ currency: Currency; digits: number; unknownPrice: number | null; priceLimits: PriceLimits | null }>({ currency: null, digits: 2, unknownPrice: null, priceLimits: null });

/** The household's currency, its decimals, its unknown price, and `format` for amounts in it. */
export function useMoney() {
  const m = useContext(MoneyContext);
  return { ...m, format: (c: number, cents: 'auto' | 'always' = 'auto') => money(c, m.currency, m.digits, cents) };
}
