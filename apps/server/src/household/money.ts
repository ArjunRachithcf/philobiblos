// The household's money (philobiblos#27): its one currency and what a price nobody knows counts as. Nothing in the core
// names a currency (apps/server/test/architecture.test.ts): every amount is in hundredths of the household's currency,
// and a connector counts only in it (connectors/enabled.ts). PHILOBIBLOS_CURRENCY gives a household that has none its
// currency at a start; after that, admins set it in Settings. It never changes under an enabled connector in another
// currency, a change turns every connector off (each is enabled again, in the new one), and nothing is converted
// (docs/connectors.md).
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { BUDGET_CEILING_C } from './budget';
import { validCurrency } from './currency';

/** What an unknown price counts as until an admin says otherwise: 25 of the household's currency (ADR 0008). */
export const DEFAULT_UNKNOWN_PRICE_C = 2500;

export interface Money { currency: string | null; unknownPrice: number }

export class MoneyError extends Error {
  constructor(readonly status: 400 | 409, message: string) { super(message); }
}

export function getMoney(db: Db): Money {
  const r = db.select({ currency: t.householdSettings.currency, unknownPrice: t.householdSettings.unknownPriceC }).from(t.householdSettings).where(eq(t.householdSettings.id, 1)).get();
  return { currency: r?.currency ?? null, unknownPrice: r?.unknownPrice ?? DEFAULT_UNKNOWN_PRICE_C };
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
 * Settings.money, checked before anything is written: `{ currency?, unknownPrice? }`. `others` are the currencies of the
 * enabled connectors (by name): the household's currency does not change to one they do not use.
 */
export function checkMoney(body: unknown, others: { name: string; currency: string }[]): (tx: Db) => void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MoneyError(400, 'money: { currency, unknownPrice }');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'currency' && k !== 'unknownPrice') throw new MoneyError(400, `money: ${k.slice(0, 40)} is not one of its settings`);
  const set: Partial<typeof t.householdSettings.$inferInsert> = {};
  if (b.currency !== undefined) {
    const code = typeof b.currency === 'string' ? b.currency.trim().toUpperCase() : null;
    if (!validCurrency(code)) throw new MoneyError(400, 'money.currency: an ISO 4217 code this server knows, such as the one on your bookshop\'s invoices');
    const clash = others.find((o) => o.currency !== code);
    if (clash) throw new MoneyError(409, `${clash.name} is enabled with amounts in ${clash.currency}: turn it off before the household changes its currency`);
    set.currency = code;
  }
  if (b.unknownPrice !== undefined) {
    if (!Number.isInteger(b.unknownPrice) || (b.unknownPrice as number) < 0 || (b.unknownPrice as number) > BUDGET_CEILING_C) {
      throw new MoneyError(400, `money.unknownPrice: whole hundredths from 0 to ${BUDGET_CEILING_C}`);
    }
    set.unknownPriceC = b.unknownPrice as number;
  }
  return (tx) => {
    if (!Object.keys(set).length) return;
    // A new currency starts with no bookshop enabled: a connector enabled before, which counted for nothing since (in
    // another currency; an upgrade's), never comes back into force by itself when the currency comes round to its own.
    if (set.currency !== undefined && set.currency !== getMoney(tx).currency) tx.delete(t.connectorEnabled).run();
    tx.insert(t.householdSettings).values({ id: 1, ...set }).onConflictDoUpdate({ target: t.householdSettings.id, set }).run();
  };
}
