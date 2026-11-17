// The screens' amounts (src/money.ts): in the household's currency, never a built-in one.
import { describe, expect, it } from 'vitest';
import { money, unit } from '../src/money';

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
