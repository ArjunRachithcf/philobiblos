// A currency as Philobiblos accepts it (PHILOBIBLOS_CURRENCY, Settings' money, a connector's locale): an ISO 4217 code
// this server's Intl knows, so every screen can write amounts in it. No imports, so config.ts can read it.
const KNOWN = new Set(Intl.supportedValuesOf('currency'));

export function validCurrency(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Z]{3}$/.test(code) && KNOWN.has(code);
}
