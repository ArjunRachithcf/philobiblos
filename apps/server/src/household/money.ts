// The household's money (philobiblos#27): its one currency and what a price nobody knows counts as. Nothing in the core
// names a currency (apps/server/test/architecture.test.ts): every amount is in hundredths of the household's currency,
// and a connector counts only in it (connectors/enabled.ts). PHILOBIBLOS_CURRENCY gives a household that has none its
// currency at a start; after that, admins set it in Settings. It never changes under an enabled connector in another
// currency, a change turns every connector off (each is enabled again, in the new one), and nothing is converted
// (docs/connectors.md). Its price limits (philobiblos#40) are its own too: an admin's amounts, or none, and then they
// follow its unknown price (packages/scoring price.ts), so no currency's sizes are built into the scores.
import { and, eq, isNull } from 'drizzle-orm';
import { AMOUNT_CEILING_C, wholeIn } from '@philobiblos/contracts/money';
import { derivedPriceLimits } from '@philobiblos/scoring';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { validCurrency } from './currency';

/** What an unknown price counts as until an admin says otherwise: 25 of the household's currency (ADR 0008). */
export const DEFAULT_UNKNOWN_PRICE_C = 2500;

/** The limits in force (null = none) and whether they are the household's own or follow its unknown price. */
export interface PriceLimitsView { high: number | null; max: number | null; own: boolean }
export interface Money { currency: string | null; unknownPrice: number; priceLimits: PriceLimitsView }

export class MoneyError extends Error {
  constructor(readonly status: 400 | 409, message: string) { super(message); }
}

export function getMoney(db: Db): Money {
  const r = db.select({ currency: t.householdSettings.currency, unknownPrice: t.householdSettings.unknownPriceC, high: t.householdSettings.priceHighC, max: t.householdSettings.priceMaxC })
    .from(t.householdSettings).where(eq(t.householdSettings.id, 1)).get();
  const unknownPrice = r?.unknownPrice ?? DEFAULT_UNKNOWN_PRICE_C;
  const own = r?.high != null && r.max != null ? { highC: r.high, maxC: r.max } : null;
  const l = own ?? derivedPriceLimits(unknownPrice);
  return { currency: r?.currency ?? null, unknownPrice, priceLimits: { high: l.highC, max: l.maxC, own: own !== null } };
}

/** The household's own price limits for packages/scoring (householdWeights), or null when they follow its unknown price. */
export function ownPriceLimits(m: Money): { highC: number; maxC: number } | null {
  return m.priceLimits.own ? { highC: m.priceLimits.high!, maxC: m.priceLimits.max! } : null;
}

/** An amount an admin sets: whole hundredths from 0 to the ceiling, and whole in the household's currency (none: any). */
export function amountProblem(v: unknown, currency: string | null): string | null {
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > AMOUNT_CEILING_C) return `whole hundredths from 0 to ${AMOUNT_CEILING_C}`;
  if (!wholeIn(v as number, currency)) return `an amount ${currency} can write: whole units, or only the decimals it has`;
  return null;
}

/** PHILOBIBLOS_CURRENCY at a start: the currency of a household that has none yet; one it has is never replaced. */
export function initCurrency(db: Db, currency: string | null): void {
  if (currency === null) return;
  if (!validCurrency(currency)) throw new MoneyError(400, 'PHILOBIBLOS_CURRENCY: an ISO 4217 code');
  // Filling it in is a change of currency too: every enabling made before counts for nothing, and stays that way.
  db.transaction((tx) => {
    const filled = tx.update(t.householdSettings).set({ currency }).where(and(eq(t.householdSettings.id, 1), isNull(t.householdSettings.currency))).run();
    if (filled.changes) tx.delete(t.connectorEnabled).run();
  });
}

/**
 * Settings.money, checked before anything is written: `{ currency?, unknownPrice?, priceLimits? }`. `others` are the
 * currencies of the enabled connectors (by name): the household's currency does not change to one they do not use.
 * `current` is the household's currency now: amounts are checked against the one in force after the request.
 */
export function checkMoney(body: unknown, others: { name: string; currency: string }[], current: string | null): (tx: Db) => void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MoneyError(400, 'money: { currency, unknownPrice, priceLimits }');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'currency' && k !== 'unknownPrice' && k !== 'priceLimits') throw new MoneyError(400, `money: ${k.slice(0, 40)} is not one of its settings`);
  const set: Partial<typeof t.householdSettings.$inferInsert> = {};
  if (b.currency !== undefined) {
    const code = typeof b.currency === 'string' ? b.currency.trim().toUpperCase() : null;
    if (!validCurrency(code)) throw new MoneyError(400, 'money.currency: an ISO 4217 code this server knows, such as the one on your bookshop\'s invoices');
    const clash = others.find((o) => o.currency !== code);
    if (clash) throw new MoneyError(409, `${clash.name} is enabled with amounts in ${clash.currency}: turn it off before the household changes its currency`);
    set.currency = code;
  }
  const currency = set.currency ?? current;
  if (b.unknownPrice !== undefined) {
    const problem = amountProblem(b.unknownPrice, currency);
    if (problem) throw new MoneyError(400, `money.unknownPrice: ${problem}`);
    set.unknownPriceC = b.unknownPrice as number;
  }
  if (b.priceLimits !== undefined) {
    const l = b.priceLimits;
    if (l === null) Object.assign(set, { priceHighC: null, priceMaxC: null });
    else {
      if (!l || typeof l !== 'object' || Array.isArray(l)) throw new MoneyError(400, 'money.priceLimits: { high, max }, or null to follow the unknown price');
      const o = l as Record<string, unknown>;
      for (const k of Object.keys(o)) if (k !== 'high' && k !== 'max') throw new MoneyError(400, `money.priceLimits: ${k.slice(0, 40)} is not one of its parts`);
      for (const k of ['high', 'max'] as const) {
        const problem = o[k] === undefined ? 'both parts, or null to follow the unknown price' : amountProblem(o[k], currency);
        if (problem) throw new MoneyError(400, `money.priceLimits.${k}: ${problem}`);
      }
      // 0 would make every book with a price dear (and, as max, leave every adult's out): no limit is null, not 0.
      if (o.high === 0) throw new MoneyError(400, 'money.priceLimits.high: above 0 (null follows the unknown price)');
      if ((o.high as number) > (o.max as number)) throw new MoneyError(400, 'money.priceLimits: the "dear" limit is above the one that leaves a book out');
      Object.assign(set, { priceHighC: o.high as number, priceMaxC: o.max as number });
    }
  }
  return (tx) => {
    if (!Object.keys(set).length) return;
    // A new currency starts with no bookshop enabled: a connector enabled before, which counted for nothing since (in
    // another currency; an upgrade's), never comes back into force by itself when the currency comes round to its own.
    if (set.currency !== undefined && set.currency !== getMoney(tx).currency) tx.delete(t.connectorEnabled).run();
    tx.insert(t.householdSettings).values({ id: 1, ...set }).onConflictDoUpdate({ target: t.householdSettings.id, set }).run();
  };
}
