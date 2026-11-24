// Amounts as the screens write them (philobiblos#27): the API's money is in hundredths of the household's currency
// (Me.money), written here in that currency in the reader's own locale. No currency is built in: a household that has
// not chosen one yet sees plain numbers. Each currency is written and typed with its own decimals (none in one without
// them; packages/contracts money.ts, philobiblos#40).
import { createContext, useContext } from 'react';
import { fractionDigits, parseAmount } from '@philobiblos/contracts/money';

export type Currency = string | null | undefined;

/**
 * `c` hundredths in the household's currency; whole amounts without decimals unless `cents` asks for them, and never
 * more decimals than the currency has.
 */
export function money(c: number, currency: Currency, cents: 'auto' | 'always' = 'auto'): string {
  const digits = fractionDigits(currency);
  const min = cents === 'always' || c % 100 ? digits : 0;
  const opts: Intl.NumberFormatOptions = { minimumFractionDigits: min, maximumFractionDigits: digits };
  if (currency) {
    try { return new Intl.NumberFormat(undefined, { ...opts, style: 'currency', currency }).format(c / 100); } catch { /* a code this browser does not know: the code, then the number */ }
    return `${currency} ${new Intl.NumberFormat(undefined, opts).format(c / 100)}`;
  }
  return new Intl.NumberFormat(undefined, opts).format(c / 100);
}

/** An amount as typed in a field (`18.90`, `18,90`, `1500`), in hundredths; null when the currency cannot write it. */
export const typed = (s: string, currency: Currency): number | null => parseAmount(s, currency);

/** An amount to show as an example of how to type one: `18.90`, or `1890` in a currency without decimals. */
export const amountExample = (currency: Currency): string => asTyped(fractionDigits(currency) ? 1890 : 189000, currency);

/** `c` hundredths as a field shows it to edit: digits and a point, the currency's decimals only when there are some. */
export function asTyped(c: number, currency: Currency): string {
  const digits = fractionDigits(currency);
  const units = Math.floor(c / 100);
  const rest = c % 100;
  return rest && digits ? `${units}.${String(rest).padStart(2, '0').slice(0, digits)}` : String(Math.round(c / 100));
}

/**
 * The budget bar's step and its end, in hundredths: a fifth of the household's unknown price and at least 16 of it, so
 * a bar looks and moves the same in any currency (25 → steps of 5, to 400). Without an unknown price the budget sets
 * the size. A step is whole units of the currency.
 */
export function budgetBar(b: { min: number; max: number }, total: number, unknownC: number, currency: Currency): { step: number; scale: number } {
  const unit = 10 ** (2 - fractionDigits(currency));
  let ref = unknownC > 0 ? unknownC : Math.max(b.max, total) / 6;
  if (!(ref > 0)) ref = 5 * unit;
  const step = Math.max(unit, Math.round(ref / 5 / unit) * unit);
  const round = 4 * ref;
  return { step, scale: Math.max(16 * ref, Math.ceil((Math.max(b.max, total) * 1.5) / round) * round) };
}

/** The currency as a field's label says it ("At least (…)"); "amount" before the household has one. */
export const unit = (currency: Currency): string => currency || 'amount';

/** The household's money for the screens below the app (App.tsx provides it from /me). */
export const MoneyContext = createContext<{ currency: Currency; unknownPrice: number | null; priceLimits: PriceLimits | null }>({ currency: null, unknownPrice: null, priceLimits: null });

/** The scores' price limits in force (Me.money): null = none; own false while they follow the unknown price. */
export interface PriceLimits { high: number | null; max: number | null; own?: boolean }

/** The household's currency, its unknown price, and `format` for amounts in it. */
export function useMoney() {
  const m = useContext(MoneyContext);
  return { ...m, format: (c: number, cents: 'auto' | 'always' = 'auto') => money(c, m.currency, cents) };
}
