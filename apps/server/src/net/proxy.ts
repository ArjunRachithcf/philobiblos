// In src/net for node:net's address helpers only: nothing here opens a connection.
// The trusted proxy (PHILOBIBLOS_TRUSTED_PROXY; ADR 0009, ADR 0011, philobiblos#34 slice 3). Its addresses and ranges
// come from the environment only and are checked at start: a bad entry stops Philobiblos (config.ts), never widens
// trust. Under HomersLab the identity headers count only from it (identity.ts); in both modes it is the only sender
// whose X-Forwarded-For is read, for the household's networks and the join routes' limits.
//
// The client address (clientAddress): a connection from anywhere else is its own address, whatever X-Forwarded-For it
// carries (a forged header is ignored). From the trusted proxy it is the right-most entry of X-Forwarded-For that is
// not itself a trusted proxy (the one the last proxy saw; entries to its left are whatever the client wrote, never
// read). A trusted proxy that sends no X-Forwarded-For, an empty one, one too long, or an entry that is not a plain
// address (a port, brackets, a zone, a name) before that one, gives no client address (null): such a visitor is in no
// household network (fail closed).
import { BlockList, isIP, isIPv4 } from 'node:net';
import { parseCidr, parseCidrAnyWidth, plainAddress, type Cidr } from './networks';

/** At most `max` entries, none wider than a /24 (IPv4) or a /64 (IPv6); X-Forwarded-For past `headerMax` is not read. */
export const TRUSTED_PROXY = { max: 10, minPrefix4: 24, minPrefix6: 64, headerMax: 2048 } as const;

/**
 * PHILOBIBLOS_TRUSTED_PROXY as given: comma-separated addresses (each is a /32 or /128; an IPv4-mapped one is its IPv4
 * address) or CIDRs. null when unset or empty; throws on anything else (an unspecified address, a name, a range wider
 * than TRUSTED_PROXY allows, an empty entry, too many).
 */
export function parseTrustedProxy(raw: string | undefined): Cidr[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  const entries = raw.split(',').map((e) => e.trim());
  if (entries.length > TRUSTED_PROXY.max) throw new Error(`PHILOBIBLOS_TRUSTED_PROXY: at most ${TRUSTED_PROXY.max} addresses or ranges`);
  return entries.map((raw) => {
    const e = plainAddress(raw);
    const withPrefix = e.includes('/') ? e : `${e}/${isIPv4(e) ? 32 : 128}`;
    const c = parseCidrAnyWidth(withPrefix, TRUSTED_PROXY.minPrefix4, TRUSTED_PROXY.minPrefix6);
    if (!c || c.network === '0.0.0.0' || c.network === '::') {
      throw new Error(`PHILOBIBLOS_TRUSTED_PROXY: ${JSON.stringify(e.slice(0, 64))} is not the proxy's address or a range of at most /${TRUSTED_PROXY.minPrefix4} (IPv4) or /${TRUSTED_PROXY.minPrefix6} (IPv6)`);
    }
    return c;
  });
}

/** Whether an address (a mapped one as its IPv4 one) is the trusted proxy's. */
const blocks = new WeakMap<Cidr[], BlockList>();
export function isTrustedProxy(list: Cidr[] | null, address: string | null | undefined): boolean {
  if (list === null || !address) return false;
  let b = blocks.get(list);
  if (!b) { b = new BlockList(); for (const c of list) b.addSubnet(c.network, c.prefix, c.family); blocks.set(list, b); }
  const a = plainAddress(address);
  const family = isIPv4(a) ? 'ipv4' : isIP(a) === 6 ? 'ipv6' : null;
  return family !== null && b.check(a, family);
}

/** One entry of X-Forwarded-For as a plain address, or null when it is anything else. */
function entry(raw: string): string | null {
  const a = plainAddress(raw.trim());
  return isIP(a) !== 0 && !a.includes('%') ? a : null;
}

/**
 * The client's address: the connection's, or (only from the trusted proxy) the forwarded one, as described at the top of
 * this file. null: the trusted proxy forwarded none Philobiblos can read.
 */
export function clientAddress(list: Cidr[] | null, peer: string | undefined, forwarded: string | string[] | undefined): string | null {
  const p = plainAddress(peer);
  if (!p) return null;
  if (!isTrustedProxy(list, p)) return p;
  const header = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (typeof header !== 'string' || header.length > TRUSTED_PROXY.headerMax) return null;
  const hops = header.split(',');
  for (let i = hops.length - 1; i >= 0; i--) {
    const a = entry(hops[i]!);
    if (a === null) return null;
    if (!isTrustedProxy(list, a)) return a;
  }
  // Every entry a proxy of ours: no client named.
  return null;
}

/**
 * The key a client is limited by: an IPv6 address by its /64 (one household's, or one attacker's, whole block), an
 * IPv4 one (a mapped one too) as it is.
 */
export function addressKey(address: string | null | undefined): string {
  const a = plainAddress(address);
  if (!a.includes(':')) return `a:${a}`;
  const c = parseCidr(`${a}/64`);
  return c ? `a6:${c.network}` : `a:${a}`;
}

/**
 * PHILOBIBLOS_TRUSTED_PROXY under HomersLab: the edge's one address (ADR 0009, contracts/homerslab-app.yaml), never a
 * range or a list, since whoever is in it may name any person and role.
 */
export function edgeAddress(list: Cidr[] | null): boolean {
  return list !== null && list.length === 1 && list[0]!.prefix === (list[0]!.family === 'ipv4' ? 32 : 128);
}
