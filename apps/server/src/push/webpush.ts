// Web Push's two pieces of cryptography, nothing else (no network here: push/push.ts sends through net/egress.ts):
// - the message encryption of RFC 8291 (aes128gcm, RFC 8188): a fresh key pair and salt per message, so only the
//   browser that subscribed can read it, and the push service carries ciphertext;
// - the VAPID authorization of RFC 8292: an ES256 JWT for the push service's origin, signed with the household's
//   application server key (sealed like the delivery address: push/push.ts).
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';

export const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
export const fromB64u = (s: string) => Buffer.from(s, 'base64url');

export interface VapidKeys { publicKey: Buffer; privateKey: Buffer }

export function newVapidKeys(): VapidKeys {
  const e = createECDH('prime256v1');
  e.generateKeys();
  return { publicKey: e.getPublicKey(), privateKey: e.getPrivateKey() };
}

/** The public key of a private one (P-256, uncompressed, 65 bytes). */
export function vapidFromPrivate(privateKey: Buffer): VapidKeys {
  const e = createECDH('prime256v1');
  e.setPrivateKey(privateKey);
  return { publicKey: e.getPublicKey(), privateKey };
}

/** True when the browser's key is a point on P-256 (uncompressed) and its auth secret 16 bytes. */
export function validClientKeys(p256dh: Buffer, auth: Buffer): boolean {
  if (p256dh.length !== 65 || p256dh[0] !== 0x04 || auth.length !== 16) return false;
  // computeSecret refuses a point that is not on the curve.
  try { const e = createECDH('prime256v1'); e.generateKeys(); e.computeSecret(p256dh); return true; } catch { return false; }
}

const RECORD_SIZE = 4096;
/** The most a payload may hold in one record (RFC 8291 §4: one record, its padding delimiter and the tag). */
export const PAYLOAD_MAX = RECORD_SIZE - 17;

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, len: number) => Buffer.from(hkdfSync('sha256', ikm, salt, info, len));

/** RFC 8291: the body of one push message to one browser. `test` fixes the sender's key and salt (RFC 8291 §5's example). */
export function encrypt(payload: Buffer, client: { p256dh: Buffer; auth: Buffer }, test?: { senderPrivate: Buffer; salt: Buffer }): Buffer {
  if (payload.length > PAYLOAD_MAX) throw new Error('a push payload fits one record');
  const sender = createECDH('prime256v1');
  if (test) sender.setPrivateKey(test.senderPrivate); else sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  const secret = sender.computeSecret(client.p256dh);
  const ikm = hkdf(client.auth, secret, Buffer.concat([Buffer.from('WebPush: info\0'), client.p256dh, senderPublic]), 32);
  const salt = test?.salt ?? randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  // The last (and only) record: the payload, then the delimiter 0x02 (RFC 8188 §2), no padding.
  const body = Buffer.concat([c.update(Buffer.concat([payload, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([senderPublic.length]), senderPublic, body]);
}

/** RFC 8292: the Authorization header for one push service (its origin is the token's audience), valid 12 hours. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now: Date): string {
  const aud = new URL(endpoint).origin;
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: subject })));
  const key = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: b64u(keys.privateKey), x: b64u(keys.publicKey.subarray(1, 33)), y: b64u(keys.publicKey.subarray(33, 65)) } });
  const sig = sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${b64u(keys.publicKey)}`;
}
