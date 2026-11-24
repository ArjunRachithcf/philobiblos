// The mail-domain rule's code (standalone; ADR 0011, philobiblos#34 slice 4a). A join link may ask for an address at a
// domain; whoever opens it may prove one with a 6-digit code that Philobiblos mails there (net/smtp.ts, the one mail it
// sends), and is then judged by the link's rules with that domain verified.
//
// - The code is random (crypto.randomInt), bound to the request that asked for it: a request token only that page
//   holds (its SHA-256 here) and that page's link, so it works from no other link or browser. It is kept only as an
//   HMAC over the request's id and the code, keyed by a key derived from the sealing key with HKDF-SHA-256
//   (info "join-code"): a copy of the database cannot try the million codes. Compared in constant time.
// - 10 minutes, 5 tries (a request's tries, right or wrong), one live code an address: a new one ends the one before.
// - Sends: at most 3 an hour and 10 a day per address, 10 a day per join link, 30 a day per household (JOIN_CODE), so
//   made-up addresses at the domain get at most 150 tries a day against a household. Counted in join_code_sent with an
//   HMAC of the address, never the address.
// - Every request gets the same answer (a request token), whether a mail went out or not: a link that does not open,
//   another domain, a member's address, a full list, a limit reached. A request that sent nothing is stored like one
//   that did, without an address or a code, so its tries answer alike too.
// - The address is on the request (join_code) until the passkey's enrolment, at most 30 minutes; then on the waiting
//   person's join_request only, gone when they are decided or lapse. Someone the rule let in keeps only the domain.
import { createHmac, hkdfSync, randomInt, timingSafeEqual } from 'node:crypto';
import { and, count, eq, gte, isNull, lt } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { hashToken, looksLikeToken, newToken } from '../auth/tokens';
import { domainOf, plainAddress, sendCode as smtpSend } from '../net/smtp';
import { sealingKey } from './sealed';

export const JOIN_CODE = {
  ttlMs: 10 * 60_000, tries: 5, keepMs: 30 * 60_000,
  perAddressHour: 3, perAddressDay: 10, perLinkDay: 10, perHouseholdDay: 30,
} as const;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The HMAC key of join codes: HKDF-SHA-256 of the sealing key, info "join-code" (the sealing key is never an HMAC key itself). */
export function codeKey(sealing: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', sealing, Buffer.alloc(0), 'join-code', 32));
}

/** The code's HMAC, bound to its request's id. */
const codeMac = (key: Buffer, requestId: string, code: string) => createHmac('sha256', key).update(`code\n${requestId}\n${code}`).digest();
/** What the send log keeps of an address. */
const addressMac = (key: Buffer, address: string) => createHmac('sha256', key).update(`address\n${address}`).digest('hex');

/** A mail domain as an admin gives it: a host name of at least two labels, lowercased; null otherwise. */
export function mailDomain(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const d = v.trim().toLowerCase().replace(/^@/, '');
  return d.length <= 253 && plainAddress(`x@${d}`) === `x@${d}` ? d : null;
}

/** Whether codes can be sent here: SMTP set and a sealing key to derive the code key from. */
export interface CodeMail {
  /** The key, or null: the rule is not offered (no SMTP, or no sealing key). */
  key: Buffer | null;
  /** The SMTP host the codes go through (what leaves), or null. */
  host: string | null;
  publicDomains: ReadonlySet<string>;
  send: (to: string, code: string) => Promise<void>;
}

export function codeMail(cfg: Pick<Config, 'smtp' | 'sealingKey' | 'publicMailDomains'>, send?: CodeMail['send']): CodeMail {
  let key: Buffer | null = null;
  if (cfg.smtp) { try { const k = sealingKey(cfg); key = k ? codeKey(k) : null; } catch { key = null; } }
  const smtp = cfg.smtp;
  return { key, host: key && smtp ? smtp.host : null, publicDomains: cfg.publicMailDomains, send: send ?? ((to, code) => smtpSend(smtp!, to, code)) };
}

/** Codes asked for more than JOIN_CODE.keepMs ago go, and sends older than a day. */
export function pruneCodes(db: Db, now = new Date()): void {
  db.delete(t.joinCode).where(lt(t.joinCode.createdAt, new Date(now.getTime() - JOIN_CODE.keepMs).toISOString())).run();
  db.delete(t.joinCodeSent).where(lt(t.joinCodeSent.sentAt, new Date(now.getTime() - DAY).toISOString())).run();
}

const sentSince = (db: Db, since: number, where?: ReturnType<typeof eq>) =>
  db.select({ n: count() }).from(t.joinCodeSent).where(and(gte(t.joinCodeSent.sentAt, new Date(since).toISOString()), where)).get()?.n ?? 0;

/**
 * A code asked for. `linkId`: the link the token names, if one does (kept on the request whether or not a mail goes out,
 * so its tries are limited with the link's others alike). `to` is the address when a mail may go out to it (the route
 * checked the link opens for this client, has the mail rule, that the address is at its domain and that it is not a
 * public provider's); null when no mail goes out whatever the limits say. Returns the request token (the same answer
 * in every case) and, when the limits leave room, the code to send to `to`.
 */
export function askCode(db: Db, key: Buffer, o: { linkId: string | null; to: string | null }, now = new Date()): { request: string; send: { to: string; code: string } | null } {
  const request = newToken();
  const id = ulid();
  return db.transaction((tx0) => {
    const tx = tx0 as unknown as Db;
    pruneCodes(tx, now);
    const ms = now.getTime();
    let send: { to: string; code: string } | null = null;
    if (o.to && o.linkId) {
      const am = addressMac(key, o.to);
      const room = sentSince(tx, ms - HOUR, eq(t.joinCodeSent.addressMac, am)) < JOIN_CODE.perAddressHour
        && sentSince(tx, ms - DAY, eq(t.joinCodeSent.addressMac, am)) < JOIN_CODE.perAddressDay
        && sentSince(tx, ms - DAY, eq(t.joinCodeSent.joinLinkId, o.linkId)) < JOIN_CODE.perLinkDay
        && sentSince(tx, ms - DAY) < JOIN_CODE.perHouseholdDay;
      if (room) {
        send = { to: o.to, code: String(randomInt(0, 1_000_000)).padStart(6, '0') };
        // One live code an address: the one before stops working.
        tx.update(t.joinCode).set({ mac: null }).where(and(eq(t.joinCode.address, o.to), isNull(t.joinCode.verifiedAt))).run();
        tx.insert(t.joinCodeSent).values({ sentAt: now.toISOString(), joinLinkId: o.linkId, addressMac: am }).run();
      }
    }
    tx.insert(t.joinCode).values({
      id, requestHash: hashToken(request), joinLinkId: o.linkId, address: send ? send.to : null, mac: send ? codeMac(key, id, send.code) : null,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + JOIN_CODE.ttlMs).toISOString(),
    }).run();
    return { request, send };
  }, { behavior: 'immediate' });
}

/** The hash a presented request token is looked up by (anything else hashes as the empty one: the same work). */
export const requestHash = (request: unknown) => hashToken(looksLikeToken(request) ? request : '');

/** The link a presented request belongs to (for the per-link limit), without spending a try. */
export function requestLink(db: Db, hash: string): string | null {
  return db.select({ l: t.joinCode.joinLinkId }).from(t.joinCode).where(eq(t.joinCode.requestHash, hash)).get()?.l ?? null;
}

const SIX = /^\d{6}$/;

/**
 * A code tried: true when it is the request's live code, within its 10 minutes and its 5 tries. Every try counts, and
 * the comparison takes the same time whatever is stored (an HMAC of the given code against the stored one, or against
 * a stand-in when there is none). The right code is spent: the request is verified, and no code is live any more.
 */
export function checkCode(db: Db, key: Buffer, hash: string, code: unknown, now = new Date()): boolean {
  return db.transaction((tx0) => {
    const tx = tx0 as unknown as Db;
    const row = tx.select().from(t.joinCode).where(eq(t.joinCode.requestHash, hash)).get();
    const given = codeMac(key, row?.id ?? '', typeof code === 'string' && SIX.test(code) ? code : '');
    const stored = row?.mac && row.mac.length === given.length ? row.mac : Buffer.alloc(given.length);
    const same = timingSafeEqual(given, stored);
    if (!row) return false;
    const ok = same && row.mac !== null && typeof code === 'string' && SIX.test(code) && row.tries < JOIN_CODE.tries && row.expiresAt > now.toISOString() && row.verifiedAt === null;
    const tries = Math.min(row.tries + 1, JOIN_CODE.tries);
    tx.update(t.joinCode).set(ok ? { tries, mac: null, verifiedAt: now.toISOString() } : { tries, ...(tries >= JOIN_CODE.tries ? { mac: null } : {}) })
      .where(eq(t.joinCode.id, row.id)).run();
    return ok;
  }, { behavior: 'immediate' });
}

/** The address a request verified for this link (within JOIN_CODE.keepMs), or null; the request stays. */
export function verifiedAddress(db: Db, hash: string | null | undefined, linkId: string, now = new Date()): string | null {
  if (!hash) return null;
  const row = db.select().from(t.joinCode).where(eq(t.joinCode.requestHash, hash)).get();
  return row ? verifiedOf(row, linkId, now) : null;
}

const verifiedOf = (row: typeof t.joinCode.$inferSelect, linkId: string, now: Date) =>
  row.joinLinkId === linkId && row.verifiedAt !== null && row.address !== null && row.createdAt >= new Date(now.getTime() - JOIN_CODE.keepMs).toISOString() ? row.address : null;

/**
 * At the enrolment, inside its transaction: the address a request verified for this link (within JOIN_CODE.keepMs),
 * or null. The request goes either way: the address moves to the join request, or nowhere.
 */
export function takeVerified(tx: Db, hash: string | null | undefined, linkId: string, now = new Date()): string | null {
  if (!hash) return null;
  const row = tx.select().from(t.joinCode).where(eq(t.joinCode.requestHash, hash)).get();
  if (!row) return null;
  tx.delete(t.joinCode).where(eq(t.joinCode.id, row.id)).run();
  return verifiedOf(row, linkId, now);
}

/** Whether an address's domain is the rule's (exact, never a subdomain). */
export const atDomain = (address: string, domain: string) => domainOf(address) === domain;
