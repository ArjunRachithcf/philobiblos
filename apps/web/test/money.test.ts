// The screens' amounts (src/money.ts): in the household's currency, never a built-in one.
import { describe, expect, it } from 'vitest';
import { asTyped, budgetBar, money, typed, unit } from '../src/money';

const plain = (s: string) => s.replace(/\s/g, ' ');

describe('amounts on the screens', () => {
  it('in the household\'s currency, whichever it is', () => {
    expect(plain(money(1990, 'CHF'))).toMatch(/CHF ?19\.90/);
    expect(money(500, 'EUR')).toMatch(/€/);
    expect(money(500, 'GBP')).toMatch(/£/);
    expect(money(2500, 'JPY')).toMatch(/25/);
  });

  it('whole amounts without decimals unless asked; hundredths always kept', () => {
    expect(plain(money(18000, 'CHF'))).toMatch(/CHF ?180$/);
    expect(plain(money(18000, 'CHF', 'always'))).toMatch(/CHF ?180\.00$/);
    expect(plain(money(18050, 'CHF'))).toMatch(/180\.50$/);
  });

  it('no currency chosen yet: a plain number, no currency assumed', () => {
    expect(money(1990, null)).toBe('19.90');
    expect(money(2500, undefined)).toBe('25');
    expect(unit(null)).toBe('amount');
    expect(unit('SEK')).toBe('SEK');
  });

  it('a code the browser does not know is written as given, never another currency', () => {
    expect(plain(money(100, 'ZZZ'))).toMatch(/ZZZ ?1/);
  });
});

describe('a currency\'s own decimals (philobiblos#40)', () => {
  it('a currency without decimals is written without them, even when asked for hundredths', () => {
    expect(money(150000, 'JPY')).not.toMatch(/[.,]\d{2}$/);
    expect(money(150000, 'JPY', 'always')).not.toMatch(/[.,]0/);
    expect(money(150000, 'JPY')).toMatch(/1,500|1\.500|1 500/);
    expect(plain(money(1990, 'CHF', 'always'))).toMatch(/19\.90$/);
  });

  it('an amount typed in Settings or an entry reads with those decimals: none in a currency without them', () => {
    expect(typed('1500', 'JPY')).toBe(150000);
    expect(typed('1500.5', 'JPY')).toBeNull();
    expect(typed('24.90', 'CHF')).toBe(2490);
    expect(typed('2500000', 'IDR')).toBe(250_000_000);
    expect(typed('', 'CHF')).toBeNull();
  });

  it('an amount as a field shows it to edit: the currency\'s decimals only when it has them', () => {
    expect(asTyped(150000, 'JPY')).toBe('1500');
    expect(asTyped(2490, 'CHF')).toBe('24.90');
    expect(asTyped(2500, 'CHF')).toBe('25');
    expect(asTyped(250_000_000, 'IDR')).toBe('2500000');
  });

  it('the budget bar moves in steps that follow the household\'s unknown price, so any currency has the same bar', () => {
    const chf = budgetBar({ min: 10000, max: 15000 }, 0, 2500, 'CHF');
    expect(chf).toEqual({ step: 500, scale: 40000 });
    expect(budgetBar({ min: 1000000, max: 1500000 }, 0, 250000, 'JPY')).toEqual({ step: 50000, scale: 4000000 });
    expect(budgetBar({ min: 100000000, max: 150000000 }, 0, 25000000, 'IDR')).toEqual({ step: 5000000, scale: 400000000 });
    expect(budgetBar({ min: 10000, max: 60000 }, 0, 2500, 'CHF').scale).toBe(90000);
    // No unknown price to follow: the budget itself sets the size; a step is never less than one unit.
    expect(budgetBar({ min: 10000, max: 15000 }, 0, 0, 'CHF')).toEqual({ step: 500, scale: 40000 });
    expect(budgetBar({ min: 0, max: 0 }, 0, 0, 'JPY').step).toBe(100);
  });
});
