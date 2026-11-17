// Amounts as the screens write them (philobiblos#27): the API's money is in hundredths of the household's currency
// (Me.money), written here in that currency in the reader's own locale. No currency is built in: a household that has
// not chosen one yet sees plain numbers.
import { createContext, useContext } from 'react';

export type Currency = string | null | undefined;

/** `c` hundredths in the household's currency; whole amounts without decimals unless `cents` asks for them. */
export function money(c: number, currency: Currency, cents: 'auto' | 'always' = 'auto'): string {
  const min = cents === 'always' || c % 100 ? 2 : 0;
  const opts: Intl.NumberFormatOptions = { minimumFractionDigits: min, maximumFractionDigits: 2 };
  if (currency) {
    try { return new Intl.NumberFormat(undefined, { ...opts, style: 'currency', currency }).format(c / 100); } catch { /* a code this browser does not know: the code, then the number */ }
    return `${currency} ${new Intl.NumberFormat(undefined, opts).format(c / 100)}`;
  }
  return new Intl.NumberFormat(undefined, opts).format(c / 100);
}

/** The currency as a field's label says it ("At least (…)"); "amount" before the household has one. */
export const unit = (currency: Currency): string => currency || 'amount';

/** The household's money for the screens below the app (App.tsx provides it from /me). */
export const MoneyContext = createContext<{ currency: Currency; unknownPrice: number | null }>({ currency: null, unknownPrice: null });

/** The household's currency, its unknown price, and `format` for amounts in it. */
export function useMoney() {
  const m = useContext(MoneyContext);
  return { ...m, format: (c: number, cents: 'auto' | 'always' = 'auto') => money(c, m.currency, cents) };
}
