// Web Push to the household's adults (spec §5 step 5, shelf#8 h; Arjun chose Web Push): "this month's plan is ready",
// and nothing about who reads what.
//
// - The application server key (VAPID, P-256) is made once and sealed like the delivery address (household/sealed.ts,
//   the key outside the database): its private half is never logged or answered; only the public half is (GET /push/key).
// - Subscriptions are per person, adults only (kids never sign in; a person who becomes a kid loses theirs, and the role
//   is checked again at each send), at most PUSH.perPerson a person, each removable by its person.
// - An endpoint is https on 443 at a push service the server allows (SHELF_PUSH_HOSTS), without credentials, at most 1,024 characters; the
//   browser's keys are a P-256 point and a 16-byte secret. Every send goes through the egress client (net/egress.ts)
//   with those hosts as its whole allowlist: public addresses only, no redirects, a deadline and size limits.
// - The payload is encrypted (RFC 8291) and holds only its kind ({"kind":"plan"}); the service worker shows its own
//   words for the kind and opens Shelf's own origin (apps/web/public/sw.js).
// - A push service's 404 or 410 deletes the subscription; its 429 stops sends to that service for the run.
// - Rate limits: the plan's push once a period (the monthly refresh's step), a test push 3 times in 10 minutes a person,
//   10 subscriptions saved in 10 minutes a person.
import { and, count, eq, inArray } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { household } from '../household/people';
import { SealError, isSealed, keyProblem, sealIfAbsent, sealingKey, unseal } from '../household/sealed';
import type { Outcome } from '../jobs/books';
import { EgressError, createEgress, type Egress, type EgressOptions, type Rule } from '../net/egress';
import { DEFAULT_PUSH_HOSTS, LABEL, hostAllowed } from './hosts';

export { DEFAULT_PUSH_HOSTS } from './hosts';
import { b64u, encrypt, fromB64u, newVapidKeys, validClientKeys, vapidAuthorization, vapidFromPrivate, type VapidKeys } from './webpush';

export const PUSH = { perPerson: 10, ttlSeconds: 24 * 3600, endpointMax: 1024 } as const;
export const VAPID_SEALED = 'vapid_private_key';
/** RFC 8292's contact for the push services: the project's, never the household's address. */
export const VAPID_SUBJECT = 'https://github.com/ArjunRachithcf/shelf';

/** The push client's whole allowlist (net/egress.ts): those services, https on 443, public addresses only. */
export const pushEgressRules = (hosts: readonly string[] = DEFAULT_PUSH_HOSTS): Rule[] =>
  hosts.map((e) => (e.startsWith('*.') ? { host: '', hostPattern: new RegExp(`^${LABEL}${e.slice(1).replace(/\./g, '\\.')}$`) } : { host: e }));

/** The server's push client: SHELF_PUSH_HOSTS as its whole allowlist, off with SHELF_EGRESS=off. */
export const pushClient = (cfg: Pick<Config, 'pushHosts' | 'egress'>, o: Partial<EgressOptions> = {}): Egress => createEgress({ ...o, rules: pushEgressRules(cfg.pushHosts), enabled: cfg.egress });

export type PushKind = 'plan' | 'test';

export class PushError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message); }
}

export const WRONG_SEALING_KEY = 'the sealing key does not open the notification key (SHELF_SEALING_KEY is not the key it was sealed with): no notifications until the right key is back; the devices are kept';

/**
 * The household's VAPID keys; made and sealed the first time they are needed, and only then: when nothing is sealed yet
 * (of two first calls at once, the first sealed wins and both answer it). No usable sealing key: PushError 503. A
 * sealed key that does not open (another sealing key, or a changed row): PushError 503 too, and everything is kept (the
 * sealed key and every device), so the right sealing key brings them all back.
 */
export function vapidKeys(db: Db, cfg: Pick<Config, 'sealingKey'>): VapidKeys {
  const problem = keyProblem(cfg);
  if (problem) throw new PushError(503, `notifications need the sealing key, which is ${problem} (SHELF_SEALING_KEY)`);
  const key = sealingKey(cfg)!;
  if (!isSealed(db, VAPID_SEALED)) sealIfAbsent(db, key, VAPID_SEALED, b64u(newVapidKeys().privateKey));
  try { return vapidFromPrivate(fromB64u(unseal(db, key, VAPID_SEALED)!)); } catch (e) {
    if (e instanceof SealError) throw new PushError(503, WRONG_SEALING_KEY);
    throw e;
  }
}

/**
 * DELETE /push/key (an admin, with a fresh sign-in): a new notification key from now on. The sealed key and every
 * device go together, in one transaction (a device made for the old key could never be told again); each adult turns
 * notifications on again. The way out of a deliberate sealing-key change, or a key someone may have seen.
 */
export function resetPushKey(db: Db): { devices: number } {
  return db.transaction((tx) => {
    tx.delete(t.sealedSecret).where(eq(t.sealedSecret.key, VAPID_SEALED)).run();
    return { devices: tx.delete(t.pushSubscription).run().changes };
  }, { behavior: 'immediate' });
}

/** A subscription as the browser gives it (PushSubscription.toJSON()), checked field by field. */
export function checkSubscription(body: unknown, hosts: readonly string[] = DEFAULT_PUSH_HOSTS): { endpoint: string; p256dh: string; auth: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PushError(400, 'a subscription: { endpoint, keys: { p256dh, auth } }');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!['endpoint', 'keys', 'expirationTime'].includes(k)) throw new PushError(400, `unknown field ${k}`);
  const endpoint = b.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > PUSH.endpointMax) throw new PushError(400, 'endpoint: a URL of a push service');
  let u: URL;
  try { u = new URL(endpoint); } catch { throw new PushError(400, 'endpoint: a URL of a push service'); }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash || !hostAllowed(hosts, u.hostname)) {
    throw new PushError(400, 'endpoint: https at a browser\'s push service');
  }
  const keys = b.keys as Record<string, unknown> | undefined;
  const p256dh = keys?.p256dh, auth = keys?.auth;
  const b64 = /^[A-Za-z0-9_-]+=*$/;
  if (!keys || typeof keys !== 'object' || Object.keys(keys).some((k) => k !== 'p256dh' && k !== 'auth') || typeof p256dh !== 'string' || typeof auth !== 'string' || !b64.test(p256dh) || !b64.test(auth) || p256dh.length > 100 || auth.length > 30
    || !validClientKeys(fromB64u(p256dh), fromB64u(auth))) {
    throw new PushError(400, 'keys: the browser\'s P-256 key and its 16-byte secret');
  }
  return { endpoint: u.toString(), p256dh: b64u(fromB64u(p256dh)), auth: b64u(fromB64u(auth)) };
}

/** POST /push/subscriptions: this browser's subscription, for the signed-in adult. The same endpoint moves to them. */
export function subscribe(db: Db, personId: string, body: unknown, o: { hosts?: readonly string[]; now?: Date } = {}): { id: string } {
  const s = checkSubscription(body, o.hosts);
  const now = o.now ?? new Date();
  return db.transaction((tx) => {
    tx.delete(t.pushSubscription).where(eq(t.pushSubscription.endpoint, s.endpoint)).run();
    const n = tx.select({ n: count() }).from(t.pushSubscription).where(eq(t.pushSubscription.personId, personId)).get()!.n;
    if (n >= PUSH.perPerson) throw new PushError(409, `at most ${PUSH.perPerson} devices a person: remove one first`);
    const id = ulid();
    tx.insert(t.pushSubscription).values({ id, personId, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, createdAt: now.toISOString() }).run();
    return { id };
  });
}

/** GET /push/subscriptions: your own devices, by their push service's name only (the endpoint is never answered). */
export function listSubscriptions(db: Db, personId: string) {
  return db.select().from(t.pushSubscription).where(eq(t.pushSubscription.personId, personId)).orderBy(t.pushSubscription.createdAt).all()
    .map((r) => ({ id: r.id, service: new URL(r.endpoint).hostname, createdAt: r.createdAt, lastSentAt: r.lastSentAt ?? null }));
}

/** DELETE /push/subscriptions/{id}: yours only; anyone else's is 404 like a missing one. */
export function unsubscribe(db: Db, personId: string, id: string): void {
  const r = db.delete(t.pushSubscription).where(and(eq(t.pushSubscription.id, id), eq(t.pushSubscription.personId, personId))).run();
  if (!r.changes) throw new PushError(404, 'no such device');
}

/**
 * Sends `kind` to the subscriptions of `people` (default: every adult), each encrypted for its browser, through the push
 * client. Kids' subscriptions (a person who became one) are deleted, never sent to.
 */
export async function notify(db: Db, cfg: Pick<Config, 'sealingKey'>, egress: Egress, kind: PushKind, o: { people?: string[]; now?: () => Date } = {}): Promise<Outcome> {
  const now = o.now ?? (() => new Date());
  const everyone = household(db);
  const kids = everyone.filter((p) => p.role === 'kid').map((p) => p.id);
  if (kids.length) db.delete(t.pushSubscription).where(inArray(t.pushSubscription.personId, kids)).run();
  const adults = everyone.filter((p) => p.role !== 'kid' && (!o.people || o.people.includes(p.id))).map((p) => p.id);
  const subs = adults.length ? db.select().from(t.pushSubscription).where(inArray(t.pushSubscription.personId, adults)).all() : [];
  if (!subs.length) return { status: 'done', detail: 'no devices to notify' };
  let keys: VapidKeys;
  try { keys = vapidKeys(db, cfg); } catch (e) { if (e instanceof PushError) return { status: 'blocked', detail: e.message }; throw e; }
  const payload = Buffer.from(JSON.stringify({ kind }));
  const throttled = new Set<string>();
  let sent = 0, gone = 0, failed = 0;
  for (const s of subs) {
    const host = new URL(s.endpoint).hostname;
    if (throttled.has(host)) { failed++; continue; }
    try {
      await egress.push(s.endpoint, encrypt(payload, { p256dh: fromB64u(s.p256dh), auth: fromB64u(s.auth) }), {
        headers: { authorization: vapidAuthorization(s.endpoint, keys, VAPID_SUBJECT, now()), ttl: String(PUSH.ttlSeconds), urgency: 'normal', topic: kind, 'content-encoding': 'aes128gcm' },
      });
      sent++;
      db.update(t.pushSubscription).set({ lastSentAt: now().toISOString() }).where(eq(t.pushSubscription.id, s.id)).run();
    } catch (e) {
      if (!(e instanceof EgressError)) throw e;
      if (e.reason === 'off') return { status: 'blocked', detail: e.message };
      if (e.reason === 'status' && (e.status === 404 || e.status === 410)) { gone++; db.delete(t.pushSubscription).where(eq(t.pushSubscription.id, s.id)).run(); continue; }
      if (e.reason === 'status' && e.status === 429) throttled.add(host);
      failed++;
    }
  }
  const detail = `${sent} devices notified${gone ? `, ${gone} gone (removed)` : ''}${failed ? `, ${failed} failed` : ''}`;
  return { status: failed && !sent ? 'failed' : 'done', detail };
}
