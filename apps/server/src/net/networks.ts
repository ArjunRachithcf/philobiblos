// In src/net for node:net's address helpers only (BlockList, isIP): nothing here opens a connection.
// The household's networks (ADR 0011, philobiblos#34 slice 2): the home network ranges an admin lists (Settings →
// People → Home network). A join link opens only from one of them; with none listed no link can be made, and an empty
// list never means "anywhere". Ranges are CIDRs (no GPS, no IP geolocation). The client address is the connection's:
// slice 3 adds the forwarded one from PHILOBIBLOS_TRUSTED_PROXY.
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import type { Db } from '../db/open';
import * as t from '../db/schema';

/** At most this many ranges; none wider than /8 (IPv4) or /32 (IPv6), so a typo never opens the whole internet. */
export const NETWORKS = { max: 20, minPrefix4: 8, minPrefix6: 32 } as const;

export interface Cidr { cidr: string; family: 'ipv4' | 'ipv6'; network: string; prefix: number }

const v4ToInt = (a: string) => a.split('.').reduce((n, p) => n * 256 + Number(p), 0);
const intToV4 = (n: number) => [24, 16, 8, 0].map((s) => (Math.floor(n / 2 ** s) % 256)).join('.');

function v6ToBig(a: string): bigint {
  let s = a.toLowerCase();
  // An embedded IPv4 tail (::ffff:192.0.2.1) as two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const n = v4ToInt(dotted[1]!);
    s = s.slice(0, -dotted[1]!.length) + `${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const tl = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - tl.length).fill('0'), ...tl];
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g || '0', 16)), 0n);
}
const bigToV6 = (n: bigint) => {
  const groups = Array.from({ length: 8 }, (_, i) => ((n >> BigInt(16 * (7 - i))) & 0xffffn).toString(16));
  // The shortest form: the longest run of zero groups as ::.
  let best = -1, len = 0;
  for (let i = 0; i < 8; i++) {
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > len && j - i > 1) { best = i; len = j - i; }
    i = j;
  }
  if (best < 0) return groups.join(':');
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + len).join(':')}`;
};

/** A plain address as the socket gives it: an IPv4-mapped IPv6 address is the IPv4 one. */
export function plainAddress(a: string | undefined): string {
  if (!a) return '';
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  return m ? m[1]! : a;
}

/** A CIDR as an admin types it, normalised (host bits cleared); null if it is not one, or wider than NETWORKS allows. */
export function parseCidr(input: unknown): Cidr | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const m = /^([0-9A-Fa-f:.]+)\/(\d{1,3})$/.exec(input);
  if (!m) return null;
  const addr = m[1]!, prefix = Number(m[2]);
  if (isIPv4(addr)) {
    if (prefix < NETWORKS.minPrefix4 || prefix > 32) return null;
    const size = 2 ** (32 - prefix);
    const network = intToV4(Math.floor(v4ToInt(addr) / size) * size);
    return { cidr: `${network}/${prefix}`, family: 'ipv4', network, prefix };
  }
  if (isIPv6(addr)) {
    if (prefix < NETWORKS.minPrefix6 || prefix > 128) return null;
    const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
    const network = bigToV6(v6ToBig(addr) & mask);
    return { cidr: `${network}/${prefix}`, family: 'ipv6', network, prefix };
  }
  return null;
}

export function homeNetworks(db: Db): { cidr: string; addedAt: string }[] {
  return db.select({ cidr: t.homeNetwork.cidr, addedAt: t.homeNetwork.addedAt }).from(t.homeNetwork).orderBy(t.homeNetwork.addedAt, t.homeNetwork.cidr).all();
}

/** Replaces the list (already parsed and checked); keeps the time a range was first added. */
export function setHomeNetworks(db: Db, cidrs: Cidr[], by: string, now = new Date()): void {
  db.transaction((tx) => {
    const before = new Map(tx.select().from(t.homeNetwork).all().map((r) => [r.cidr, r]));
    tx.delete(t.homeNetwork).run();
    for (const c of new Set(cidrs.map((x) => x.cidr))) {
      const old = before.get(c);
      tx.insert(t.homeNetwork).values({ cidr: c, addedBy: old ? old.addedBy : by, addedAt: old?.addedAt ?? now.toISOString() }).run();
    }
  }, { behavior: 'immediate' });
}

/** Whether an address is in one of the household's networks. Always reads the whole list, whatever the address. */
export function inHomeNetwork(db: Db, address: string | undefined): boolean {
  const list = new BlockList();
  for (const { cidr } of homeNetworks(db)) {
    const c = parseCidr(cidr);
    if (c) list.addSubnet(c.network, c.prefix, c.family);
  }
  const a = plainAddress(address);
  const family = isIPv4(a) ? 'ipv4' : isIPv6(a) ? 'ipv6' : null;
  return family !== null && list.check(a, family);
}

const PRIVATE4: [string, number][] = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]];

/**
 * The private range an admin is on, for them to confirm (never added by itself): their IPv4 address's /24 when it is
 * a private (RFC 1918) or shared (RFC 6598, a mesh's) address, or the /64 of a unique local IPv6 address. Loopback,
 * link-local and public addresses propose nothing.
 */
export function proposeNetwork(address: string | undefined): string | null {
  const a = plainAddress(address);
  if (isIPv4(a)) {
    const n = v4ToInt(a);
    const ok = PRIVATE4.some(([net, p]) => Math.floor(n / 2 ** (32 - p)) === Math.floor(v4ToInt(net) / 2 ** (32 - p)));
    return ok ? parseCidr(`${a}/24`)!.cidr : null;
  }
  if (isIPv6(a) && (v6ToBig(a) >> 121n) === 0x7en) return parseCidr(`${a}/64`)!.cidr; // fc00::/7
  return null;
}
