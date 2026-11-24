// The screens' amounts (src/money.ts): in the household's currency, never a built-in one, with the decimals the server
// says it has (Me.money.digits, Settings' currencies: philobiblos#62), never the browser's own count.
import { describe, expect, it } from 'vitest';
import { amountExample, asTyped, budgetBar, budgetPatch, money, moneyPatch, typed, unit } from '../src/money';

const plain = (s: string) => s.replace(/\s/g, ' ');

describe('amounts on the screens', () => {
  it('in the household\'s currency, whichever it is', () => {
    expect(plain(money(1990, 'CHF', 2))).toMatch(/CHF ?19\.90/);
    expect(money(500, 'EUR', 2)).toMatch(/€/);
    expect(money(500, 'GBP', 2)).toMatch(/£/);
    expect(money(2500, 'JPY', 0)).toMatch(/25/);
  });

  it('whole amounts without decimals unless asked; hundredths always kept', () => {
    expect(plain(money(18000, 'CHF', 2))).toMatch(/CHF ?180$/);
    expect(plain(money(18000, 'CHF', 2, 'always'))).toMatch(/CHF ?180\.00$/);
    expect(plain(money(18050, 'CHF', 2))).toMatch(/180\.50$/);
  });

  it('no currency chosen yet: a plain number, no currency assumed', () => {
    expect(money(1990, null, 2)).toBe('19.90');
    expect(money(2500, undefined, 2)).toBe('25');
    expect(unit(null)).toBe('amount');
    expect(unit('SEK')).toBe('SEK');
  });

  it('a code the browser does not know is written as given, never another currency', () => {
    expect(plain(money(100, 'ZZZ', 2))).toMatch(/ZZZ ?1/);
  });
});

describe('a currency\'s own decimals, as the server counts them (philobiblos#40, #62)', () => {
  it('a currency without decimals is written without them, even when asked for hundredths', () => {
    expect(money(150000, 'JPY', 0)).not.toMatch(/[.,]\d{2}$/);
    expect(money(150000, 'JPY', 0, 'always')).not.toMatch(/[.,]0/);
    expect(money(150000, 'JPY', 0)).toMatch(/1,500|1\.500|1 500/);
    expect(plain(money(1990, 'CHF', 2, 'always'))).toMatch(/19\.90$/);
  });

  it('the server\'s count wins over the browser\'s: two decimals where this browser\'s Intl knows none', () => {
    expect(plain(money(250050, 'IDR', 2, 'always'))).toMatch(/2,500\.50$|2\.500,50$|2 500,50$/);
    expect(typed('2500.50', 2)).toBe(250050);
    expect(typed('2500.50', 0)).toBeNull();
  });

  it('three decimals: written with three, typed with the third 0; an example says so', () => {
    expect(plain(money(125, 'KWD', 3, 'always'))).toMatch(/1\.250$/);
    expect(typed('1.250', 3)).toBe(125);
    expect(typed('1.255', 3)).toBeNull();
    expect(asTyped(125, 3)).toBe('1.250');
    expect(amountExample(3)).toBe('18.900');
    expect(amountExample(2)).toBe('18.90');
    expect(amountExample(0)).toBe('1890');
  });

  it('an amount kept from before, which its currency cannot write now, is shown as it is, never rounded', () => {
    expect(asTyped(150050, 0)).toBe('1500.50');
    expect(money(150050, 'JPY', 0)).toMatch(/1,500\.50|1\.500,50|1 500,50/);
  });

  it('an amount typed in Settings or an entry reads with those decimals: none in a currency without them', () => {
    expect(typed('1500', 0)).toBe(150000);
    expect(typed('1500.5', 0)).toBeNull();
    expect(typed('24.90', 2)).toBe(2490);
    expect(typed('2500000', 0)).toBe(250_000_000);
    expect(typed('', 2)).toBeNull();
  });

  it('an amount as a field shows it to edit: the currency\'s decimals only when it has them', () => {
    expect(asTyped(150000, 0)).toBe('1500');
    expect(asTyped(2490, 2)).toBe('24.90');
    expect(asTyped(2500, 2)).toBe('25');
    expect(asTyped(250_000_000, 0)).toBe('2500000');
  });

  it('the budget bar moves in steps that follow the household\'s unknown price, so any currency has the same bar', () => {
    const chf = budgetBar({ min: 10000, max: 15000 }, 0, 2500, 2);
    expect(chf).toEqual({ step: 500, scale: 40000 });
    expect(budgetBar({ min: 1000000, max: 1500000 }, 0, 250000, 0)).toEqual({ step: 50000, scale: 4000000 });
    expect(budgetBar({ min: 100000000, max: 150000000 }, 0, 25000000, 0)).toEqual({ step: 5000000, scale: 400000000 });
    expect(budgetBar({ min: 10000, max: 60000 }, 0, 2500, 2)).toEqual({ step: 1000, scale: 90000 });
    // A small unknown price next to a large budget: steps from the budget, never a tiny one.
    expect(budgetBar({ min: 10000, max: 15000 }, 0, 100, 2).step).toBe(250);
    expect(budgetBar({ min: 0, max: 15050 }, 0, 0, 0).scale % 100).toBe(0);
    // No unknown price to follow: the budget itself sets the size; a step is never less than one unit.
    expect(budgetBar({ min: 10000, max: 15000 }, 0, 0, 2)).toEqual({ step: 500, scale: 40000 });
    expect(budgetBar({ min: 0, max: 0 }, 0, 0, 0).step).toBe(100);
  });
});

describe('Settings sends only what was changed (philobiblos#62)', () => {
  const digits = (code: string | null) => ({ JPY: 0, CHF: 2, KWD: 3, IDR: 2 } as Record<string, number>)[code ?? ''] ?? 2;
  // A household in a currency without decimals, with an unknown price kept from before (1500.50) and its own limits.
  const stored = { currency: 'JPY', unknownPrice: 150050, priceLimits: { high: 400000, max: 600000, own: true } };
  const form = { code: 'JPY', unknown: asTyped(150050, 0), own: true, high: asTyped(400000, 0), max: asTyped(600000, 0) };

  it('an unrelated save never rounds a stored amount its currency cannot write now: an untouched field is not sent', () => {
    expect(moneyPatch({ ...form, high: '5000' }, stored, digits)).toEqual({ body: { priceLimits: { high: 500000, max: 600000 } } });
    expect(moneyPatch(form, stored, digits)).toEqual({ body: {} });
    expect(moneyPatch({ ...form, own: false }, stored, digits)).toEqual({ body: { priceLimits: null } });
  });

  it('a field that was changed is typed in the currency being saved, with the server\'s decimals for it', () => {
    expect(moneyPatch({ ...form, unknown: '1500.5' }, stored, digits)).toEqual({ error: expect.stringMatching(/for example 1890/) });
    expect(moneyPatch({ ...form, code: 'IDR', unknown: '2500.50' }, stored, digits)).toEqual({ body: { currency: 'IDR', unknownPrice: 250050 } });
    expect(moneyPatch({ ...form, code: 'KWD', unknown: '1.255' }, stored, digits)).toEqual({ error: expect.stringMatching(/hundredths.*18\.900/) });
    expect(moneyPatch({ ...form, high: '7000' }, stored, digits)).toEqual({ error: expect.stringMatching(/dear/) });
  });

  it('own limits turned on send both; following again sends null', () => {
    const following = { ...stored, priceLimits: { high: 4000, max: 6000, own: false } };
    expect(moneyPatch({ ...form, high: '', max: '' }, following, digits)).toEqual({ error: expect.stringMatching(/both price limits/) });
    expect(moneyPatch({ ...form, high: '3000', max: '5000' }, following, digits)).toEqual({ body: { priceLimits: { high: 300000, max: 500000 } } });
  });

  it('the budget: an end kept as it was is not sent, so a stored fraction is never rounded', () => {
    const b = { min: 1000050, max: 2000000 };
    expect(budgetPatch('10001', '30000', b)).toEqual({ body: { max: 3000000 } });
    expect(budgetPatch('9000', '20000', b)).toEqual({ body: { min: 900000 } });
    expect(budgetPatch('30000', '20000', b)).toEqual({ error: expect.stringMatching(/above/) });
    expect(budgetPatch('1.5', '20000', b)).toEqual({ error: expect.stringMatching(/whole/) });
  });
});
