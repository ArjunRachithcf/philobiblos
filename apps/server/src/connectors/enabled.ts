// Which bookshop connectors count (philobiblos#27). A connector widens nothing by itself: it is data in a folder until an
// admin enables it in Settings, with a fresh sign-in, having read what it allows (its mail domains, its signing domains,
// its quote senders, its price host, its order address). The enabling holds for that file's version only: when the file
// changes (a new Philobiblos, an edited local connector), it allows nothing until an admin enables it again. Two enabled
// connectors never share a mail domain, so a mail always belongs to one of them. A connector counts only in the
// household's currency (household/money.ts): its amounts are read as the household's, so one in another currency is
// never enabled, and one enabled before the household's currency changed underneath it counts for nothing.
//
// Everything that reaches outside reads only `enabledConnectors`: the mail checks (which senders count), the parsers
// (how their mails read), the price lookup and the egress allowlist (which host it may ask).
import { eq } from 'drizzle-orm';
import type { Connector } from '@philobiblos/contracts/connector';
import type { Mode } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import type { LoadedConnector, Registry } from './load';
import { getMoney } from '../household/money';

export interface Enabled { id: string; version: string; connector: Connector }

/** The connectors that count now: enabled by an admin, for the file as it is, sound, and in the household's currency. */
export function enabledConnectors(db: Db, reg: Registry): Enabled[] {
  const rows = db.select().from(t.connectorEnabled).all();
  const { currency } = getMoney(db);
  return reg.all.flatMap((c) => {
    const row = rows.find((r) => r.id === c.id);
    return row && c.connector && !c.problem && c.version && row.version === c.version && c.connector.locale.currency === currency
      ? [{ id: c.id, version: c.version, connector: c.connector }] : [];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/** The price hosts of these connectors: the only shop hosts on the egress allowlist (net/egress.ts egressRules). */
export const shopHosts = (enabled: Enabled[]) => enabled.flatMap((e) => (e.connector.prices ? [allows(e.connector).priceHost!] : []));

/**
 * Where Compose writes: the address an admin set in Settings, or else the order address of the one enabled bookshop
 * that names one (two that do, and Compose waits for an admin to choose in Settings).
 */
export function orderAddress(set: string | null, enabled: Enabled[]): string | null {
  if (set) return set;
  const named = enabled.flatMap((e) => (e.connector.order ? [e.connector.order.to] : []));
  return named.length === 1 ? named[0]! : null;
}

/** What a connector allows, as Settings shows it before an admin enables it. */
export function allows(c: Connector) {
  const priceHost = c.prices ? new URL(c.prices.url.replace('{query}', 'q')).hostname : null;
  return {
    mailFrom: c.mail?.domains ?? [],
    signedBy: c.mail ? (c.mail.dkim_domains ?? c.mail.domains) : [],
    quoteSenders: c.mail?.quote?.senders ?? [],
    priceHost,
    orderTo: c.order?.to ?? null,
    // Its signed mail's schema.org Order and Invoice markup counts: an invoice there makes copies, as a PDF one does.
    markup: Boolean(c.mail?.markup),
  };
}

/** Why the household's currency stands in the way of this connector (null when it does not). */
function currencyBlock(db: Db, c: Connector): string | null {
  const { currency } = getMoney(db);
  if (currency === null) return `the household has no currency yet (this connector's amounts are in ${c.locale.currency}); choose it under Currency`;
  return c.locale.currency === currency ? null : `its amounts are in ${c.locale.currency}, the household's currency is ${currency}`;
}

/**
 * A connector as Settings shows it. `mode` says whether an admin can enable it here at all: under HomersLab enabling
 * waits for the edge's recent sign-in (auth/hook.ts requireFreshSignIn, homeward#253).
 */
export function connectorView(db: Db, c: LoadedConnector, mode: Mode = 'standalone') {
  const row = db.select().from(t.connectorEnabled).where(eq(t.connectorEnabled.id, c.id)).get();
  const usable = Boolean(c.connector && !c.problem);
  const money = c.connector && usable ? currencyBlock(db, c.connector) : null;
  // Why an admin cannot enable it now, when it could be used otherwise (a problem says it for an unusable one).
  const blocked = !usable ? null : money ?? (mode === 'homerslab' ? 'enabling needs a recent sign-in, which HomersLab does not tell Philobiblos yet' : null);
  return {
    id: c.id,
    name: c.connector?.name ?? c.id,
    origin: c.origin,
    version: c.version,
    usable,
    ...(c.problem ? { problem: c.problem } : {}),
    enabled: Boolean(row && usable && row.version === c.version && !money),
    // Enabled once, for a file that has changed since: it allows nothing until an admin enables it again.
    changed: Boolean(row && row.version !== c.version),
    ...(c.connector ? { currency: c.connector.locale.currency, language: c.connector.locale.language, allows: allows(c.connector) } : {}),
    ...(blocked ? { enableBlocked: blocked } : {}),
  };
}

export class ConnectorError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * PUT /connectors/{id}: `{ enabled: true, acceptVersion }` enables the file whose version Settings showed (refused when it
 * is not the file as it is now); `{ enabled: false }` turns it off. The caller checked the admin and the fresh sign-in.
 */
export function setConnector(db: Db, reg: Registry, id: string, body: unknown, by: string, now = new Date(), mode: Mode = 'standalone') {
  const c = reg.get(id);
  if (!c) throw new ConnectorError(404, 'no such connector');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ConnectorError(400, 'a JSON object is needed');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'enabled' && k !== 'acceptVersion') throw new ConnectorError(400, `${k.slice(0, 40)} is not one of its settings`);
  if (typeof b.enabled !== 'boolean') throw new ConnectorError(400, 'enabled: true or false');
  if (!b.enabled) {
    db.delete(t.connectorEnabled).where(eq(t.connectorEnabled.id, id)).run();
    return connectorView(db, c, mode);
  }
  if (!c.connector || c.problem) throw new ConnectorError(409, `this connector cannot be used: ${c.problem ?? 'it could not be read'}`);
  if (typeof b.acceptVersion !== 'string' || b.acceptVersion !== c.version) throw new ConnectorError(409, 'the connector changed since Settings showed it: read what it allows again');
  const money = currencyBlock(db, c.connector);
  if (money) throw new ConnectorError(409, `this connector counts only in the household's currency: ${money}`);
  const mine = new Set(c.connector.mail?.domains ?? []);
  const clash = enabledConnectors(db, reg).find((o) => o.id !== id && (o.connector.mail?.domains ?? []).some((d) => mine.has(d)));
  if (clash) throw new ConnectorError(409, `${clash.connector.name} is enabled with the same mail domain: turn it off first`);
  const v = { version: c.version, enabledBy: by, enabledAt: now.toISOString() };
  db.insert(t.connectorEnabled).values({ id, ...v }).onConflictDoUpdate({ target: t.connectorEnabled.id, set: v }).run();
  return connectorView(db, c, mode);
}
