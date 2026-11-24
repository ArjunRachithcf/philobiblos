// In src/net for node:net's address helpers only (BlockList, isIP): nothing here opens a connection.
// The household's networks (ADR 0011, philobiblos#34 slice 2): the home network ranges an admin lists (Settings →
// People → Home network). A join link opens only from one of them; with none listed no link can be made, and an empty
// list never means "anywhere". Ranges are CIDRs (no GPS, no IP geolocation). The client address is the connection's, or
// the forwarded one only from PHILOBIBLOS_TRUSTED_PROXY (net/proxy.ts clientAddress, philobiblos#34 slice 3).
import { existsSync, readFileSync } from 'node:fs';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { networkInterfaces } from 'node:os';
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
export function plainAddress(a: string | null | undefined): string {
  if (!a) return '';
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  return m ? m[1]! : a;
}

/** A CIDR as an admin types it, normalised (host bits cleared); null if it is not one, or wider than NETWORKS allows. */
export function parseCidr(input: unknown): Cidr | null {
  return parseCidrAnyWidth(input, NETWORKS.minPrefix4, NETWORKS.minPrefix6);
}

export function parseCidrAnyWidth(input: unknown, min4 = 0, min6 = 0): Cidr | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const m = /^([0-9A-Fa-f:.]+)\/(\d{1,3})$/.exec(input);
  if (!m) return null;
  const addr = m[1]!, prefix = Number(m[2]);
  if (isIPv4(addr)) {
    if (prefix < min4 || prefix > 32) return null;
    const size = 2 ** (32 - prefix);
    const network = intToV4(Math.floor(v4ToInt(addr) / size) * size);
    return { cidr: `${network}/${prefix}`, family: 'ipv4', network, prefix };
  }
  if (isIPv6(addr)) {
    if (prefix < min6 || prefix > 128) return null;
    // An IPv4-mapped range (::ffff:0:0/96) never matches: a client's mapped address is checked as its IPv4 one.
    if ((v6ToBig(addr) >> 32n) === 0xffffn) return null;
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

/**
 * Where Philobiblos runs, read once at start. In a container (/.dockerenv, /run/.containerenv) every client behind a
 * published port, and a proxy beside it, arrives from one of the container's own networks (its interfaces' on-link
 * prefixes, IPv4 and IPv6, from os.networkInterfaces) or a default next hop (/proc/net/route, /proc/net/ipv6_route).
 * Such an address is a hop, not a person's network: it never counts as home, no range may overlap one, and nothing is
 * proposed from one; behind a proxy only PHILOBIBLOS_TRUSTED_PROXY's forwarded address names the person
 * (net/proxy.ts). Loopback is a hop everywhere. A container whose surroundings cannot be read (`known: false`) treats
 * every address as a hop (fail closed); `unknown` says why, for the log and People: `no-ipv6-route` when the host
 * booted with IPv6 off (ipv6.disable=1 leaves no /proc/net/ipv6_route), `unreadable` otherwise.
 */
export interface Surroundings { container: boolean; known: boolean; hops: string[]; onLink: Cidr[]; unknown?: 'no-ipv6-route' | 'unreadable' }
export const NO_SURROUNDINGS: Surroundings = { container: false, known: true, hops: [], onLink: [] };

const hexV4 = (h: string) => { const n = parseInt(h, 16); return [0, 8, 16, 24].map((s) => (n >>> s) & 255).join('.'); };
const hexV6 = (h: string) => bigToV6(BigInt(`0x${h}`));
const HEX8 = /^[0-9A-Fa-f]{8}$/, HEX32 = /^[0-9A-Fa-f]{32}$/;

/** The default next hops of /proc/net/route (IPv4) and /proc/net/ipv6_route. */
export function defaultHops(route: string, ipv6Route: string): string[] {
  const hops: string[] = [];
  for (const line of route.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 8 && HEX8.test(f[1]!) && HEX8.test(f[2]!) && f[1] === '00000000' && f[2] !== '00000000') hops.push(hexV4(f[2]!));
  }
  for (const line of ipv6Route.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 10 && HEX32.test(f[0]!) && HEX32.test(f[4]!) && /^0+$/.test(f[0]!) && f[1] === '00' && !/^0+$/.test(f[4]!)) hops.push(hexV6(f[4]!));
  }
  return [...new Set(hops)];
}

export interface InterfaceAddress { cidr: string | null; internal: boolean }

/** The surroundings from what the system says (tests give their own). */
export function surroundingsFrom(o: { container: boolean; interfaces: InterfaceAddress[]; route: string; ipv6Route: string }): Surroundings {
  const onLink = o.interfaces.filter((i) => !i.internal && i.cidr).map((i) => parseCidrAnyWidth(i.cidr!.replace(/%[^/]*/, ''))).filter((c): c is Cidr => c !== null);
  return { container: o.container, known: true, hops: defaultHops(o.route, o.ipv6Route), onLink };
}

/** What readSurroundings reads (tests give their own). */
export interface System { exists: (path: string) => boolean; interfaces: () => InterfaceAddress[]; read: (path: string) => string }
const SYSTEM: System = {
  exists: existsSync,
  interfaces: () => Object.values(networkInterfaces()).flat().filter((i): i is NonNullable<typeof i> => Boolean(i)),
  read: (f) => readFileSync(f, 'utf8'),
};

export function readSurroundings(sys: System = SYSTEM): Surroundings {
  const container = sys.exists('/.dockerenv') || sys.exists('/run/.containerenv');
  let missing = null as string | null;
  try {
    const interfaces = sys.interfaces();
    const file = (f: string) => {
      try { return sys.read(f); } catch (e) {
        if (!container) return '';
        if ((e as { code?: string }).code === 'ENOENT') missing = f;
        throw e;
      }
    };
    return surroundingsFrom({ container, interfaces, route: file('/proc/net/route'), ipv6Route: file('/proc/net/ipv6_route') });
  } catch {
    // In a container that does not say where it is, nothing counts as home.
    return { container, known: !container, hops: [], onLink: [], ...(container ? { unknown: missing === '/proc/net/ipv6_route' ? 'no-ipv6-route' as const : 'unreadable' as const } : {}) };
  }
}

/** The log line for surroundings that fail closed, or null. */
export function surroundingsWarning(s: Surroundings): string | null {
  if (s.known) return null;
  return s.unknown === 'no-ipv6-route'
    ? 'join links: /proc/net/ipv6_route is missing (the host booted with ipv6.disable=1?), so Philobiblos cannot tell the container\'s IPv6 next hops from people: no join link opens here (invites still work)'
    : 'join links: the container\'s networks and routes could not be read, so no address counts as home and no join link opens here (invites still work)';
}

const LOOPBACK: Cidr[] = [parseCidrAnyWidth('127.0.0.0/8')!, parseCidrAnyWidth('::1/128')!];
const blockOf = (cidrs: Cidr[]) => { const b = new BlockList(); for (const c of cidrs) b.addSubnet(c.network, c.prefix, c.family); return b; };
const familyOf = (a: string) => (isIPv4(a) ? 'ipv4' as const : isIPv6(a) ? 'ipv6' as const : null);
/** Whether an address (a mapped one as its IPv4 one) is in one of the ranges. */
export const inRanges = (cidrs: Cidr[], address: string | null | undefined) => { const a = plainAddress(address); const f = familyOf(a); return f !== null && blockOf(cidrs).check(a, f); };
/** Two ranges overlap when one holds the other's network address (either way round). */
const overlaps = (x: Cidr, y: Cidr) => x.family === y.family && (inRanges([x], y.network) || inRanges([y], x.network));

/**
 * A hop, not a person: loopback; in a container, a default next hop or any address on the container's own networks,
 * and every address when its surroundings could not be read. Never home, never proposed (both families, mapped too).
 */
export function isHop(s: Surroundings, address: string | null | undefined): boolean {
  const a = plainAddress(address);
  if (inRanges(LOOPBACK, a)) return true;
  if (!s.container) return false;
  return !s.known || s.hops.includes(a) || inRanges(s.onLink, a);
}

/** Why a range cannot be a home network here, or null: loopback, or (in a container) one of its networks or next hops. */
export function rangeProblem(s: Surroundings, c: Cidr): string | null {
  if (LOOPBACK.some((l) => overlaps(l, c))) return `${c.cidr} is loopback: every visitor a proxy on this machine forwards would count as home`;
  if (!s.container) return null;
  if (!s.known) return 'Philobiblos cannot tell which networks are its container\'s own: no range counts as home until it can';
  if (s.hops.some((h) => inRanges([c], h)) || s.onLink.some((n) => overlaps(n, c))) {
    return `${c.cidr} overlaps the container's own networks: everyone behind the published port, or a proxy beside it, would count as home`;
  }
  return null;
}

/**
 * Whether an address is in one of the household's networks. Always reads the whole list, whatever the address; a hop
 * (isHop) is never in it, so behind a proxy or a published port a link opens for no one unless the proxy is
 * PHILOBIBLOS_TRUSTED_PROXY and the address is the one it forwards (net/proxy.ts clientAddress).
 */
export function inHomeNetwork(db: Db, address: string | null | undefined, s: Surroundings = NO_SURROUNDINGS): boolean {
  const list = new BlockList();
  for (const { cidr } of homeNetworks(db)) {
    const c = parseCidr(cidr);
    if (c) list.addSubnet(c.network, c.prefix, c.family);
  }
  const a = plainAddress(address);
  const family = familyOf(a);
  const hop = isHop(s, a);
  return family !== null && list.check(a, family) && !hop;
}

// 172.16.0.0/12 is left out: Docker's bridges are there, and behind a published port the admin's address is the bridge's.
const PRIVATE4: [string, number][] = [['10.0.0.0', 8], ['192.168.0.0', 16], ['100.64.0.0', 10]];

/**
 * The private range an admin is on, for them to confirm (never added by itself): their IPv4 address's /24 when it is
 * in 10/8, 192.168/16 (RFC 1918) or 100.64/10 (RFC 6598, a mesh's), or the /64 of a unique local IPv6 address. A
 * gateway's address (x.x.x.1: a router, or Docker's bridge behind a published port), 172.16/12 (Docker's bridges),
 * loopback, link-local and public addresses propose nothing, nor a hop or (in a container) its own networks.
 */
export function proposeNetwork(address: string | null | undefined, s: Surroundings = NO_SURROUNDINGS): string | null {
  const a = plainAddress(address);
  // A proxy's or a bridge's address, or one on the container's own networks, says nothing of the home network.
  if (isHop(s, a)) return null;
  if (isIPv4(a)) {
    const n = v4ToInt(a);
    const ok = PRIVATE4.some(([net, p]) => Math.floor(n / 2 ** (32 - p)) === Math.floor(v4ToInt(net) / 2 ** (32 - p)));
    return ok && n % 256 !== 1 ? parseCidr(`${a}/24`)!.cidr : null;
  }
  if (isIPv6(a) && (v6ToBig(a) >> 121n) === 0x7en) return parseCidr(`${a}/64`)!.cidr; // fc00::/7
  return null;
}
