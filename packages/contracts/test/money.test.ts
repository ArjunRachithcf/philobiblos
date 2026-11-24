// Amounts in hundredths of the household's currency (packages/contracts money.ts, philobiblos#40, #62): written and typed
// with the currency's own decimals, which the server's Intl knows and sends (`digits`); no currency is built in.
import { describe, expect, it } from 'vitest';
import { AMOUNT_CEILING_C, amountExample, belowHundredths, parseAmount, toHundredths, wholeIn } from '../src/money';

describe('an amount whole in a currency\'s decimals', () => {
  it('in one without decimals only whole units; with two or three (kept as hundredths), any whole hundredth', () => {
    expect(wholeIn(150000, 0)).toBe(true);
    expect(wholeIn(150050, 0)).toBe(false);
    expect(wholeIn(150050, 2)).toBe(true);
    expect(wholeIn(150055, 3)).toBe(true);
    expect(wholeIn(1.5, 2)).toBe(false);
  });
});

describe('an amount as a person types it', () => {
  it('a point or a comma and the currency\'s decimals, in hundredths', () => {
    expect(parseAmount('18.90', 2)).toBe(1890);
    expect(parseAmount('18,9', 2)).toBe(1890);
    expect(parseAmount(' 25 ', 2)).toBe(2500);
    expect(parseAmount('1500', 0)).toBe(150000);
    expect(parseAmount('1500.5', 0)).toBeNull();
    expect(parseAmount('1500.00', 0)).toBe(150000); // a spreadsheet's padding, as schema.org's
    expect(parseAmount('1500,0', 0)).toBe(150000);
    expect(parseAmount('18.905', 2)).toBeNull();
    expect(parseAmount('18.900', 2)).toBeNull(); // two decimals: a third is no padding of its
  });

  it('three decimals (KWD, BHD): typed with at most two, as hundredths; three are refused, never rounded or taken for grouping', () => {
    // `1.250` could be 1.25 or 1250 (en-KW groups thousands so): a typed field has no grouping, and refuses it.
    expect(parseAmount('1.250', 3)).toBeNull();
    expect(parseAmount('1,250', 3)).toBeNull();
    expect(parseAmount('1.25', 3)).toBe(125);
    expect(parseAmount('12', 3)).toBe(1200);
    expect(parseAmount('1.255', 3)).toBeNull();
    expect(parseAmount('1.2500', 3)).toBeNull();
    expect(belowHundredths('1.255', 3)).toBe(true);
    expect(belowHundredths(' 1,005 ', 3)).toBe(true);
    expect(belowHundredths('1.250', 3)).toBe(true);
    expect(belowHundredths('1.25', 3)).toBe(false);
    expect(belowHundredths('1500', 3)).toBe(false);
    expect(belowHundredths('18.905', 2)).toBe(false);
    expect(toHundredths('1', '255', 3)).toBe('below');
    expect(toHundredths('1', '250', 3)).toBe(125);
  });

  it('an example of an amount in a currency\'s decimals, the same on the server and the screens', () => {
    expect(amountExample(0)).toBe('1890');
    expect(amountExample(2)).toBe('18.90');
    expect(amountExample(3)).toBe('18.90'); // typed with at most two
  });

  it('a high-nominal amount reads in full; past the ceiling, a sign, a symbol or grouping is refused, never guessed', () => {
    expect(parseAmount('2500000', 0)).toBe(250_000_000);
    expect(parseAmount('9999999999', 0)).toBe(AMOUNT_CEILING_C - 100);
    expect(parseAmount('10000000000', 0)).toBe(AMOUNT_CEILING_C);
    expect(parseAmount('10000000000.01', 2)).toBeNull();
    for (const bad of ['-5', '1 500', '1,500.00', '5e3', '', '.5', '0x10', '¥1500']) expect(parseAmount(bad, 0), bad).toBeNull();
  });

  it('the ceiling keeps every sum exact: an entry\'s every line at the most copies', () => {
    expect(AMOUNT_CEILING_C * 100 * 20).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});
