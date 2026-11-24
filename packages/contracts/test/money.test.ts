// Amounts in hundredths of the household's currency (packages/contracts money.ts, philobiblos#40): written and typed with
// the currency's own decimals, which Intl knows; no currency is built in.
import { describe, expect, it } from 'vitest';
import { AMOUNT_CEILING_C, fractionDigits, parseAmount, wholeIn } from '../src/money';

describe('a currency\'s decimals', () => {
  it('as Intl knows them, at most the two that hundredths hold', () => {
    expect(fractionDigits('CHF')).toBe(2);
    expect(fractionDigits('JPY')).toBe(0);
    expect(fractionDigits('KRW')).toBe(0);
    expect(fractionDigits('BHD')).toBe(2); // three of its own: hundredths keep two
    expect(fractionDigits(null)).toBe(2);
    expect(fractionDigits('ZZZ')).toBe(2); // a code Intl does not know: hundredths as stored
  });

  it('an amount is whole in a currency without decimals only in whole units', () => {
    expect(wholeIn(150000, 'JPY')).toBe(true);
    expect(wholeIn(150050, 'JPY')).toBe(false);
    expect(wholeIn(150050, 'CHF')).toBe(true);
    expect(wholeIn(1.5, 'CHF')).toBe(false);
  });
});

describe('an amount as a person types it', () => {
  it('a point or a comma and the currency\'s decimals, in hundredths', () => {
    expect(parseAmount('18.90', 'CHF')).toBe(1890);
    expect(parseAmount('18,9', 'CHF')).toBe(1890);
    expect(parseAmount(' 25 ', 'CHF')).toBe(2500);
    expect(parseAmount('1500', 'JPY')).toBe(150000);
    expect(parseAmount('1500.5', 'JPY')).toBeNull();
    expect(parseAmount('1500.00', 'JPY')).toBeNull();
    expect(parseAmount('18.905', 'CHF')).toBeNull();
  });

  it('a high-nominal amount reads in full; past the ceiling, a sign, a symbol or grouping is refused, never guessed', () => {
    expect(parseAmount('2500000', 'IDR')).toBe(250_000_000);
    expect(parseAmount('9999999999', 'IDR')).toBe(AMOUNT_CEILING_C - 100);
    expect(parseAmount('10000000000', 'IDR')).toBe(AMOUNT_CEILING_C);
    expect(parseAmount('10000000000.01', 'CHF')).toBeNull();
    for (const bad of ['-5', '1 500', '1,500.00', '5e3', '', '.5', '0x10', '¥1500']) expect(parseAmount(bad, 'JPY'), bad).toBeNull();
  });

  it('the ceiling keeps every sum exact: an entry\'s every line at the most copies', () => {
    expect(AMOUNT_CEILING_C * 100 * 20).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});
