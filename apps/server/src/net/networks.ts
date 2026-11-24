// In src/net for node:net's address helpers only (BlockList, isIP): nothing here opens a connection.
// The household's networks (ADR 0011, philobiblos#34 slice 2): the home network ranges an admin lists (Settings →
// People → Home network). A join link opens only from one of them; with none listed no link can be made, and an empty
// list never means "anywhere". Ranges are CIDRs (no GPS, no IP geolocation). The client address is the connection's:
// slice 3 adds the forwarded one from PHILOBIBLOS_TRUSTED_PROXY.
import { existsSync, readFileSync } from 'node:fs';
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
  return parseCidrAnyWidth(input, NETWORKS.minPrefix4, NETWORKS.minPrefix6);
}

function parseCidrAnyWidth(input: unknown, min4 = 0, min6 = 0): Cidr | null {
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
 * Where Philobiblos runs, read once at start: in a container (/.dockerenv, /run/.containerenv), its default gateways
 * and the networks it sits on (/proc/net/route, IPv4). In a container every client behind a published port arrives as
 * the bridge's gateway, and a reverse proxy on the same host arrives as loopback or that gateway: such an address is a
 * hop, not a person's network, so it never counts as home (until slice 3 reads the forwarded address from
 * PHILOBIBLOS_TRUSTED_PROXY).
 */
export interface Surroundings { container: boolean; gateways: string[]; localNets: Cidr[] }
export const NO_SURROUNDINGS: Surroundings = { container: false, gateways: [], localNets: [] };

const hexV4 = (h: string) => { const n = parseInt(h, 16); return [0, 8, 16, 24].map((s) => (n >>> s) & 255).join('.'); };
const maskBits = (h: string) => { let n = parseInt(h, 16) >>> 0, c = 0; while (n) { c += n & 1; n >>>= 1; } return c; };

/** /proc/net/route's default gateways and the directly connected networks. */
export function parseRoutes(text: string): { gateways: string[]; nets: Cidr[] } {
  const gateways: string[] = [], nets: Cidr[] = [];
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || !/^[0-9A-F]{8}$/i.test(f[1]!) || !/^[0-9A-F]{8}$/i.test(f[2]!) || !/^[0-9A-F]{8}$/i.test(f[7]!)) continue;
    if (f[1] === '00000000' && f[2] !== '00000000') gateways.push(hexV4(f[2]!));
    else if (f[2] === '00000000' && f[1] !== '00000000') {
      const c = parseCidrAnyWidth(`${hexV4(f[1]!)}/${maskBits(f[7]!)}`);
      if (c) nets.push(c);
    }
  }
  return { gateways, nets };
}

export function readSurroundings(): Surroundings {
  const container = existsSync('/.dockerenv') || existsSync('/run/.containerenv');
  let routes: { gateways: string[]; nets: Cidr[] } = { gateways: [], nets: [] };
  try { routes = parseRoutes(readFileSync('/proc/net/route', 'utf8')); } catch { /* not Linux: no routes known */ }
  return { container, gateways: routes.gateways, localNets: routes.nets };
}

const LOOPBACK: Cidr[] = [parseCidrAnyWidth('127.0.0.0/8')!, parseCidrAnyWidth('::1/128')!];
const blockOf = (cidrs: Cidr[]) => { const b = new BlockList(); for (const c of cidrs) b.addSubnet(c.network, c.prefix, c.family); return b; };
const familyOf = (a: string) => (isIPv4(a) ? 'ipv4' as const : isIPv6(a) ? 'ipv6' as const : null);
const contains = (cidrs: Cidr[], address: string) => { const a = plainAddress(address); const f = familyOf(a); return f !== null && blockOf(cidrs).check(a, f); };
/** Two ranges overlap when one holds the other's network address. */
const overlaps = (x: Cidr, y: Cidr) => x.family === y.family && (contains([x], y.network) || contains([y], x.network));

/** A hop, not a person: loopback, or (in a container) its gateway. Never home, never proposed. */
export function isHop(s: Surroundings, address: string | undefined): boolean {
  const a = plainAddress(address);
  return contains(LOOPBACK, a) || (s.container && s.gateways.includes(a));
}

/** Why a range cannot be a home network here, or null: loopback, or a range holding the container's gateway. */
export function rangeProblem(s: Surroundings, c: Cidr): string | null {
  if (LOOPBACK.some((l) => overlaps(l, c))) return `${c.cidr} is loopback: every visitor a proxy on this machine forwards would count as home`;
  if (s.container && s.gateways.some((g) => contains([c], g))) return `${c.cidr} holds the container's gateway: everyone behind the published port would count as home`;
  // (The hop an admin comes through is loopback or such a gateway: both refused above.)
  return null;
}

/**
 * Whether an address is in one of the household's networks. Always reads the whole list, whatever the address; a hop
 * (isHop) is never in it, so behind a proxy or a published port a link opens for no one until slice 3.
 */
export function inHomeNetwork(db: Db, address: string | undefined, s: Surroundings = NO_SURROUNDINGS): boolean {
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
export function proposeNetwork(address: string | undefined, s: Surroundings = NO_SURROUNDINGS): string | null {
  const a = plainAddress(address);
  // A proxy's or a bridge's address, or one on the container's own networks, says nothing of the home network.
  if (isHop(s, a) || (s.container && contains(s.localNets, a))) return null;
  if (isIPv4(a)) {
    const n = v4ToInt(a);
    const ok = PRIVATE4.some(([net, p]) => Math.floor(n / 2 ** (32 - p)) === Math.floor(v4ToInt(net) / 2 ** (32 - p)));
    return ok && n % 256 !== 1 ? parseCidr(`${a}/24`)!.cidr : null;
  }
  if (isIPv6(a) && (v6ToBig(a) >> 121n) === 0x7en) return parseCidr(`${a}/64`)!.cidr; // fc00::/7
  return null;
}
