// Web Push (shelf#8 h): RFC 8291's encryption checked against its own example, VAPID (RFC 8292) verified with the
// public key, the key sealed like the delivery address, subscriptions per adult and checked, sends only to the push
// services through the egress client, 404/410 removing a device, a payload that says only its kind. No real push
// service is ever reached: the sends go to a fake egress client, or to the real one with a fake resolver.
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import type { Db } from '../src/db/open';
import * as t from '../src/db/schema';
import { editPerson } from '../src/household/people';
import { EgressError, createEgress, type Egress } from '../src/net/egress';
import { DEFAULT_PUSH_HOSTS, PUSH, PushError, VAPID_SEALED, VAPID_SUBJECT, checkSubscription, listSubscriptions, notify, pushClient, pushEgressRules, subscribe, unsubscribe, vapidKeys } from '../src/push/push';
import { b64u, encrypt, fromB64u, vapidAuthorization } from '../src/push/webpush';
import { PUSH_LIMITS } from '../src/routes/push';
import { ORIGIN, TEST_SEALING_KEY, household, sessionCookie } from './helpers';

const cfg = loadConfig({ SHELF_MODE: 'standalone', SHELF_DATA_DIR: '/nonexistent', SHELF_SEALING_KEY: TEST_SEALING_KEY });

/** A browser: its key pair and auth secret, and the decryption RFC 8291 asks of it. */
function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.from(Array.from({ length: 16 }, (_, i) => i * 7 + 1));
  return {
    keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) },
    open(body: Buffer): string {
      const salt = body.subarray(0, 16), idlen = body[20]!, sender = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
      const secret = ecdh.computeSecret(sender);
      const h = (s: Buffer, k: Buffer, info: Buffer, n: number) => Buffer.from(hkdfSync('sha256', k, s, info, n));
      const ikm = h(auth, secret, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), sender]), 32);
      const d = createDecipheriv('aes-128-gcm', h(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), h(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12));
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      expect(plain.at(-1)).toBe(2);
      return plain.subarray(0, -1).toString();
    },
  };
}
const ENDPOINT = (n: number | string = 1) => `https://fcm.googleapis.com/fcm/send/device-${n}`;
const sub = (b = browser(), n: number | string = 1) => ({ endpoint: ENDPOINT(n), keys: b.keys });

/** A push client that keeps what it was asked to send and answers with `status(url)`. */
function fakeEgress(status: (url: string) => number = () => 201) {
  const sent: { url: string; body: Buffer; headers: Record<string, string> }[] = [];
  const e: Egress = {
    get: async () => { throw new Error('no GETs'); },
    post: async () => { throw new Error('no POSTs'); },
    push: async (url, body, o) => {
      sent.push({ url, body, headers: o.headers });
      const s = status(url);
      if (s >= 300) throw new EgressError('status', `answered ${s}`, s);
      return { status: s, type: '', body: Buffer.alloc(0), url };
    },
  };
  return { e, sent };
}

describe('RFC 8291 and RFC 8292', () => {
  it('the encryption reproduces RFC 8291 §5\'s example byte for byte', () => {
    const body = encrypt(Buffer.from('When I grow up, I want to be a watermelon'), {
      p256dh: fromB64u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'), auth: fromB64u('BTBZMqHH6r4Tts7J_aSIgg'),
    }, { senderPrivate: fromB64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: fromB64u('DGv6ra1nlYgDCS1FRnbzlw') });
    expect(b64u(body)).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  });

  it('every message has its own key and salt; only the browser opens it', () => {
    const b = browser();
    const k = { p256dh: fromB64u(b.keys.p256dh), auth: fromB64u(b.keys.auth) };
    const one = encrypt(Buffer.from('{"kind":"plan"}'), k), two = encrypt(Buffer.from('{"kind":"plan"}'), k);
    expect(one.subarray(0, 86).equals(two.subarray(0, 86))).toBe(false);
    expect(b.open(one)).toBe('{"kind":"plan"}');
    expect(() => browser().open(one)).toThrow();
  });

  it('VAPID: an ES256 token for the push service\'s origin, valid 12 hours, the project as contact, verified by the public key', () => {
    const db = household();
    const keys = vapidKeys(db, cfg);
    const now = new Date('2026-12-01T20:00:00Z');
    const h = vapidAuthorization(ENDPOINT(), keys, VAPID_SUBJECT, now);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h)!;
    expect(m[4]).toBe(b64u(keys.publicKey));
    expect(JSON.parse(fromB64u(m[2]!).toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: now.getTime() / 1000 + 12 * 3600, sub: VAPID_SUBJECT });
    const pub = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(keys.publicKey.subarray(1, 33)), y: b64u(keys.publicKey.subarray(33)) } });
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, fromB64u(m[3]!))).toBe(true);
  });
});

describe('the application server key', () => {
  it('made once, sealed: the private half is not in the database in the clear', () => {
    const db = household();
    const a = vapidKeys(db, cfg), b = vapidKeys(db, cfg);
    expect(b.publicKey.equals(a.publicKey)).toBe(true);
    const row = db.select().from(t.sealedSecret).where(eq(t.sealedSecret.key, VAPID_SEALED)).get()!;
    expect(row.ciphertext.includes(a.privateKey)).toBe(false);
    expect(row.ciphertext.includes(Buffer.from(b64u(a.privateKey)))).toBe(false);
  });
  it('a sealing key that does not open the key keeps everything: no new key, no device removed, no push, and says so', async () => {
    const db = household();
    const old = vapidKeys(db, cfg);
    subscribe(db, 'p_sam', sub());
    const before = db.select().from(t.sealedSecret).where(eq(t.sealedSecret.key, VAPID_SEALED)).get()!;
    const wrong = loadConfig({ SHELF_MODE: 'standalone', SHELF_DATA_DIR: '/nonexistent', SHELF_SEALING_KEY: Buffer.alloc(32, 9).toString('base64') });
    expect(() => vapidKeys(db, wrong)).toThrow(expect.objectContaining({ status: 503, message: expect.stringContaining('sealing key does not open') }));
    expect(db.select().from(t.sealedSecret).where(eq(t.sealedSecret.key, VAPID_SEALED)).get()).toEqual(before);
    expect(listSubscriptions(db, 'p_sam')).toHaveLength(1);
    const f = fakeEgress();
    expect(await notify(db, wrong, f.e, 'plan')).toMatchObject({ status: 'blocked', detail: expect.stringContaining('sealing key does not open') });
    expect(f.sent).toEqual([]);
    // Settings → Notifications reads the same words from GET /push/key.
    const { app } = await buildApp(wrong, db, { push: f.e });
    const r = await app.inject({ url: '/api/push/key', headers: { cookie: sessionCookie(db, 'p_sam') } });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toContain('sealing key does not open');
    // The right key back: the same key and the same devices.
    expect(vapidKeys(db, cfg).publicKey.equals(old.publicKey)).toBe(true);
    expect(listSubscriptions(db, 'p_sam')).toHaveLength(1);
  });
  it('a sealed key that does not open (a changed row) is kept too', () => {
    const db = household();
    vapidKeys(db, cfg);
    const row = db.select().from(t.sealedSecret).where(eq(t.sealedSecret.key, VAPID_SEALED)).get()!;
    const bent = Buffer.from(row.ciphertext); bent[bent.length - 1]! ^= 1;
    db.update(t.sealedSecret).set({ ciphertext: bent }).where(eq(t.sealedSecret.key, VAPID_SEALED)).run();
    expect(() => vapidKeys(db, cfg)).toThrow(expect.objectContaining({ status: 503 }));
    expect(db.select().from(t.sealedSecret).where(eq(t.sealedSecret.key, VAPID_SEALED)).get()!.ciphertext.equals(bent)).toBe(true);
  });
  it('without a usable sealing key there are no notifications (503), and nothing is sent', async () => {
    const db = household();
    const none = loadConfig({ SHELF_MODE: 'homerslab', SHELF_DATA_DIR: '/nonexistent', SHELF_ORIGIN: 'https://shelf.example', SHELF_EDGE_IDENTITY: 'homerslab-v1', SHELF_TRUSTED_PROXY: '10.0.0.1' });
    expect(() => vapidKeys(db, none)).toThrow(PushError);
    db.insert(t.pushSubscription).values({ id: 's1', personId: 'p_alex', endpoint: ENDPOINT(), ...browser().keys, createdAt: new Date().toISOString() }).run();
    const f = fakeEgress();
    expect(await notify(db, none, f.e, 'plan')).toMatchObject({ status: 'blocked' });
    expect(f.sent).toEqual([]);
  });
});

describe('subscriptions', () => {
  it('only https at a browser\'s push service, no port or credentials, within 1,024 characters', () => {
    const k = browser().keys;
    for (const h of DEFAULT_PUSH_HOSTS) {
      const host = h.replace('*', 'wns2-par02p');
      expect(checkSubscription({ endpoint: `https://${host}/x`, keys: k }).endpoint).toBe(`https://${host}/x`);
    }
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://u:p@fcm.googleapis.com/x', 'https://u@fcm.googleapis.com/x', 'https://:p@fcm.googleapis.com/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x',
      'https://10.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', 'https://wns2-par02p.notify.windows.com.evil.example/x', 'https://notify.windows.com/x', 'https://a.b.notify.windows.com/x', 'https://evilnotify.windows.com/x', 'javascript:alert(1)', ENDPOINT('x'.repeat(PUSH.endpointMax)), 42]) {
      expect(() => checkSubscription({ endpoint, keys: k })).toThrow(PushError);
    }
  });
  it('no push vendor is built in: the server\'s SHELF_PUSH_HOSTS names them, checked as host names', async () => {
    const k = browser().keys;
    const own = loadConfig({ SHELF_MODE: 'standalone', SHELF_DATA_DIR: '/nonexistent', SHELF_SEALING_KEY: TEST_SEALING_KEY, SHELF_PUSH_HOSTS: 'push.example.org, *.push.example.net' });
    expect(own.pushHosts).toEqual(['push.example.org', '*.push.example.net']);
    expect(checkSubscription({ endpoint: 'https://push.example.org/d/1', keys: k }, own.pushHosts).endpoint).toBe('https://push.example.org/d/1');
    expect(checkSubscription({ endpoint: 'https://eu.push.example.net/d/1', keys: k }, own.pushHosts).endpoint).toBe('https://eu.push.example.net/d/1');
    expect(() => checkSubscription({ endpoint: ENDPOINT(), keys: k }, own.pushHosts)).toThrow(PushError);
    expect(cfg.pushHosts).toEqual(DEFAULT_PUSH_HOSTS);
    for (const bad of ['localhost', 'push.example.org/path', '*.*.example.org', 'https://push.example.org', '10.0.0.1', '*', '*.co.uk', '*.com.au', '*.org.uk', '*.co.jp', '*.ne.jp', '*.gov.uk', '*.ac.uk']) {
      expect(() => loadConfig({ SHELF_MODE: 'standalone', SHELF_DATA_DIR: '/nonexistent', SHELF_PUSH_HOSTS: bad })).toThrow(/SHELF_PUSH_HOSTS/);
    }
    // The server's push client and its routes use them.
    const looked: string[] = [];
    const c = pushClient(own, { resolve: async (h) => { looked.push(h); return [{ address: '10.0.0.5', family: 4 }]; } });
    await expect(c.push(ENDPOINT(), Buffer.from('x'), { headers: {} })).rejects.toMatchObject({ reason: 'not-allowed' });
    await expect(c.push('https://push.example.org/d/1', Buffer.from('x'), { headers: {} })).rejects.toMatchObject({ reason: 'private-address' });
    expect(looked).toEqual(['push.example.org']);
    // A wildcard under a real domain (not a public suffix) stays.
    expect(loadConfig({ SHELF_MODE: 'standalone', SHELF_DATA_DIR: '/nonexistent', SHELF_PUSH_HOSTS: '*.push.example.co.uk, *.notify.windows.com' }).pushHosts).toEqual(['*.push.example.co.uk', '*.notify.windows.com']);
    // SHELF_EGRESS=off: the push client sends nothing and looks nothing up.
    const off: string[] = [];
    const quiet = pushClient({ pushHosts: own.pushHosts, egress: false }, { resolve: async (h) => { off.push(h); return [{ address: '93.184.215.14', family: 4 }]; } });
    await expect(quiet.push('https://push.example.org/d/1', Buffer.from('x'), { headers: {} })).rejects.toMatchObject({ reason: 'off' });
    await expect(quiet.push('https://push.example.org/d/1', Buffer.from('x'), { headers: {} })).rejects.toBeInstanceOf(EgressError);
    expect(off).toEqual([]);
    const db = household();
    const { app } = await buildApp(own, db, { push: fakeEgress().e });
    const post = (endpoint: string) => app.inject({ method: 'POST', url: '/api/push/subscriptions', headers: { cookie: sessionCookie(db, 'p_sam'), origin: ORIGIN, 'content-type': 'application/json' }, payload: JSON.stringify({ endpoint, keys: k }) });
    expect((await post(ENDPOINT())).statusCode).toBe(400);
    expect((await post('https://push.example.org/d/2')).statusCode).toBe(201);
    expect(pushEgressRules(own.pushHosts).map((r) => r.host || String(r.hostPattern))).toEqual(['push.example.org', expect.stringContaining('push\\.example\\.net')]);
  });
  it('the browser\'s keys: a point on P-256 and a 16-byte secret', () => {
    const k = browser().keys;
    const offCurve = Buffer.alloc(65, 1); offCurve[0] = 4;
    for (const keys of [{ ...k, p256dh: b64u(offCurve) }, { ...k, p256dh: b64u(fromB64u(k.p256dh).subarray(0, 33)) }, { ...k, auth: b64u(Buffer.alloc(15)) }, { p256dh: k.p256dh }, { ...k, extra: 'x' }, null]) {
      expect(() => checkSubscription({ endpoint: ENDPOINT(), keys })).toThrow(PushError);
    }
  });
  it('a person\'s own, at most 10; the same browser moves to whoever subscribed it last; removed only by its person', () => {
    const db = household();
    const b = browser();
    for (let i = 0; i < PUSH.perPerson; i++) subscribe(db, 'p_alex', sub(browser(), i));
    expect(() => subscribe(db, 'p_alex', sub(browser(), 99))).toThrow(/at most 10/);
    const { id } = subscribe(db, 'p_sam', sub(b, 'shared'));
    expect(listSubscriptions(db, 'p_sam')).toEqual([{ id, service: 'fcm.googleapis.com', createdAt: expect.any(String), lastSentAt: null }]);
    expect(() => unsubscribe(db, 'p_alex', id)).toThrow(/no such device/);
    unsubscribe(db, 'p_sam', id);
    expect(listSubscriptions(db, 'p_sam')).toEqual([]);
  });
  it('becoming a kid removes a person\'s devices', () => {
    const db = household();
    subscribe(db, 'p_sam', sub());
    editPerson(db, 'p_sam', { role: 'kid', birthYear: 2020 });
    expect(listSubscriptions(db, 'p_sam')).toEqual([]);
  });
});

describe('sending', () => {
  it('to adults only; the payload is its kind and nothing else, encrypted for each browser', async () => {
    const db = household();
    const alex = browser(), sam = browser();
    subscribe(db, 'p_alex', sub(alex, 'a'));
    subscribe(db, 'p_sam', sub(sam, 's'));
    // A kid's subscription (written past the API, which never lets a kid in) is deleted, never sent to.
    db.insert(t.pushSubscription).values({ id: 'k1', personId: 'p_kid1', endpoint: ENDPOINT('k'), ...browser().keys, createdAt: new Date().toISOString() }).run();
    const f = fakeEgress();
    expect(await notify(db, cfg, f.e, 'plan')).toEqual({ status: 'done', detail: '2 devices notified' });
    expect(f.sent.map((s) => s.url).sort()).toEqual([ENDPOINT('a'), ENDPOINT('s')]);
    expect(db.select().from(t.pushSubscription).where(eq(t.pushSubscription.personId, 'p_kid1')).all()).toEqual([]);
    for (const s of f.sent) {
      const text = (s.url.endsWith('a') ? alex : sam).open(s.body);
      expect(text).toBe('{"kind":"plan"}');
      expect(s.body.toString('latin1')).not.toContain('plan');
      expect(s.headers).toMatchObject({ 'content-encoding': 'aes128gcm', ttl: String(PUSH.ttlSeconds), topic: 'plan', authorization: expect.stringMatching(/^vapid t=/) });
    }
    const all = JSON.stringify(f.sent.map((s) => s.headers));
    for (const secret of ['Alex', 'Sam', 'Kid 1', ORIGIN, b64u(vapidKeys(db, cfg).privateKey)]) expect(all).not.toContain(secret);
  });
  it('a device the push service says is gone (404, 410) is removed; a 429 stops that service for the run', async () => {
    const db = household();
    for (const n of ['gone404', 'gone410', 'ok', 'slow1', 'slow2']) subscribe(db, 'p_alex', sub(browser(), n));
    db.update(t.pushSubscription).set({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/slow1' }).where(eq(t.pushSubscription.endpoint, ENDPOINT('slow1'))).run();
    db.update(t.pushSubscription).set({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/slow2' }).where(eq(t.pushSubscription.endpoint, ENDPOINT('slow2'))).run();
    const f = fakeEgress((u) => (u.endsWith('gone404') ? 404 : u.endsWith('gone410') ? 410 : u.includes('mozilla') ? 429 : 201));
    expect((await notify(db, cfg, f.e, 'plan')).detail).toBe('1 devices notified, 2 gone (removed), 2 failed');
    expect(f.sent.filter((s) => s.url.includes('mozilla'))).toHaveLength(1);
    expect(listSubscriptions(db, 'p_alex').map((s) => s.service).sort()).toEqual(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'updates.push.services.mozilla.com']);
  });
  it('the push client reaches the push services only, and never a private address', async () => {
    const rules = pushEgressRules();
    const looked: string[] = [];
    const e = createEgress({ rules, resolve: async (h) => { looked.push(h); return [{ address: '10.0.0.5', family: 4 }]; } });
    await expect(e.push(ENDPOINT(), Buffer.from('x'), { headers: {} })).rejects.toMatchObject({ reason: 'private-address' });
    for (const url of ['https://evil.example/x', 'https://openlibrary.org/x', 'http://fcm.googleapis.com/x', 'https://wns2-par02p.notify.windows.com.evil.example/x']) {
      await expect(e.push(url, Buffer.from('x'), { headers: {} })).rejects.toMatchObject({ reason: 'not-allowed' });
    }
    expect(looked).toEqual(['fcm.googleapis.com']);
    // And the book sites' client cannot push.
    const books = createEgress({ rules: [{ host: 'openlibrary.org' }], resolve: async () => [{ address: '93.184.215.14', family: 4 }] });
    await expect(books.push(ENDPOINT(), Buffer.from('x'), { headers: {} })).rejects.toMatchObject({ reason: 'not-allowed' });
  });
});

describe('through the app', () => {
  const app = async (db: Db = household()) => {
    const f = fakeEgress();
    const built = await buildApp(cfg, db, { push: f.e });
    const as = (p: string) => ({ cookie: sessionCookie(db, p), origin: ORIGIN });
    return { db, f, app: built.app, as };
  };
  it('GET /push/key answers the public key only; a subscription saved and listed without its endpoint', async () => {
    const a = await app();
    const key = (await a.app.inject({ url: '/api/push/key', headers: a.as('p_sam') })).json();
    expect(key).toEqual({ publicKey: b64u(vapidKeys(a.db, cfg).publicKey) });
    const r = await a.app.inject({ method: 'POST', url: '/api/push/subscriptions', headers: { ...a.as('p_sam'), 'content-type': 'application/json' }, payload: JSON.stringify({ ...sub(), expirationTime: null }) });
    expect(r.statusCode).toBe(201);
    const list = (await a.app.inject({ url: '/api/push/subscriptions', headers: a.as('p_sam') })).body;
    expect(list).toContain('fcm.googleapis.com');
    expect(list).not.toContain('device-1');
    expect((await a.app.inject({ url: '/api/push/subscriptions', headers: a.as('p_alex') })).json()).toEqual([]);
  });
  it('a test goes to your own devices only, at most 3 times in 10 minutes', async () => {
    const a = await app();
    subscribe(a.db, 'p_alex', sub(browser(), 'alex'));
    subscribe(a.db, 'p_sam', sub(browser(), 'sam'));
    const test = () => a.app.inject({ method: 'POST', url: '/api/push/test', headers: a.as('p_sam') });
    for (let i = 0; i < PUSH_LIMITS.test.max; i++) expect((await test()).statusCode).toBe(200);
    expect((await test()).statusCode).toBe(429);
    expect(new Set(a.f.sent.map((s) => s.url))).toEqual(new Set([ENDPOINT('sam')]));
    expect(a.f.sent).toHaveLength(PUSH_LIMITS.test.max);
  });
  it('kids get no access; another site cannot subscribe a browser (Origin)', async () => {
    const a = await app();
    expect((await a.app.inject({ url: '/api/push/key', headers: a.as('p_kid1') })).statusCode).toBe(403);
    expect((await a.app.inject({ method: 'POST', url: '/api/push/subscriptions', headers: { cookie: sessionCookie(a.db, 'p_sam'), origin: 'https://evil.example', 'content-type': 'application/json' }, payload: JSON.stringify(sub()) })).statusCode).toBe(403);
  });
});
