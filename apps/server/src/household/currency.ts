// A currency as Philobiblos accepts it (PHILOBIBLOS_CURRENCY, Settings' money, a connector's locale): an ISO 4217 code
// this server's Intl knows, so every screen can write amounts in it. No imports, so config.ts can read it.
const KNOWN = new Set(Intl.supportedValuesOf('currency'));

export function validCurrency(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Z]{3}$/.test(code) && KNOWN.has(code);
}

/**
 * The decimals amounts in `currency` are written with, as this server's Intl knows them (philobiblos#62): the one source
 * for them. The screens get them from the server (Me.money.digits, Settings' currencies), never from their own Intl,
 * whose data can differ (a browser may count none where the server counts two). Without a currency, or with one it
 * does not know: 2, hundredths as stored.
 */
export function currencyDigits(currency: string | null | undefined): number {
  if (!currency || !KNOWN.has(currency)) return 2;
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Every currency this server knows, with its decimals: Settings' choice of the household's. */
export const currencyList = (): { code: string; digits: number }[] => [...KNOWN].map((code) => ({ code, digits: currencyDigits(code) }));
