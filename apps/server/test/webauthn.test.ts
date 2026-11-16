// simpleWebAuthn() against a software authenticator (ES256, attestation "none"): what a browser and a passkey would
// send, built here byte by byte, so the checks Philobiblos relies on are tested without a browser: origin, RP ID, user
// verification, the challenge and the signature counter.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RP_NAME, simpleWebAuthn, type StoredCredential } from '../src/auth/webauthn';
import { loadConfig } from '../src/config';
import { resetLegacyEnvWarning } from '@philobiblos/contracts/env';

const ORIGIN = 'https://philobiblos.example.org';
const RP_ID = 'philobiblos.example.org';
const sha256 = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest();
const b64u = (b: Buffer) => b.toString('base64url');

/** Just enough CBOR (RFC 8949) for an attestation object and a COSE key: unsigned/negative ints, bytes, text, maps. */
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('unsupported');
}

const UP = 0x01, UV = 0x04, AT = 0x40;

class SoftAuthenticator {
  readonly id = randomBytes(16);
  private readonly key: KeyObject;
  private readonly cose: Buffer;
  counter = 0;
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
  }
  private authData(rpId: string, flags: number, attested: boolean) {
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.counter);
    const parts: Buffer[] = [sha256(rpId), Buffer.from([flags | (attested ? AT : 0)]), counter];
    if (attested) {
      const len = Buffer.alloc(2); len.writeUInt16BE(this.id.length);
      parts.push(Buffer.alloc(16), len, this.id, this.cose); // AAGUID zero ("none" attestation)
    }
    return Buffer.concat(parts);
  }
  private clientData(type: string, challenge: string, origin: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }
  register(challenge: string, o: { origin?: string; rpId?: string; flags?: number } = {}) {
    const authData = this.authData(o.rpId ?? RP_ID, o.flags ?? UP | UV, true);
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(this.clientData('webauthn.create', challenge, o.origin ?? ORIGIN)), attestationObject: b64u(attestationObject), transports: ['internal'] },
    };
  }
  assert(challenge: string, o: { origin?: string; rpId?: string; flags?: number } = {}) {
    const authData = this.authData(o.rpId ?? RP_ID, o.flags ?? UP | UV, false);
    const clientDataJSON = this.clientData('webauthn.get', challenge, o.origin ?? ORIGIN);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.key);
    return {
      id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) },
    };
  }
}

const wa = simpleWebAuthn({ origin: ORIGIN, rpId: RP_ID });

async function enrolled() {
  const a = new SoftAuthenticator();
  const { challenge } = await wa.registrationOptions({ userId: 'p_alex', userName: 'Alex', exclude: [] });
  const cred = await wa.verifyRegistration({ response: a.register(challenge), challenge });
  expect(cred).not.toBeNull();
  const stored: StoredCredential = { id: cred!.id, publicKey: cred!.publicKey, counter: cred!.counter, transports: cred!.transports };
  return { a, stored };
}

describe('registration', () => {
  it('a valid passkey enrols', async () => {
    const { a, stored } = await enrolled();
    expect(stored.id).toBe(b64u(a.id));
  });
  it.each([
    ['another origin', { origin: 'https://evil.example' }],
    ['another RP ID', { rpId: 'evil.example' }],
    ['no user verification', { flags: UP }],
  ] as const)('refused: %s', async (_n, o) => {
    const a = new SoftAuthenticator();
    const { challenge } = await wa.registrationOptions({ userId: 'p_alex', userName: 'Alex', exclude: [] });
    expect(await wa.verifyRegistration({ response: a.register(challenge, o), challenge })).toBeNull();
  });
  it('refused: another challenge', async () => {
    const a = new SoftAuthenticator();
    const { challenge } = await wa.registrationOptions({ userId: 'p_alex', userName: 'Alex', exclude: [] });
    expect(await wa.verifyRegistration({ response: a.register(b64u(randomBytes(32))), challenge })).toBeNull();
  });
});

describe('sign-in', () => {
  it('a valid assertion signs in and moves the counter on', async () => {
    const { a, stored } = await enrolled();
    a.counter = 5;
    const { challenge } = await wa.authenticationOptions();
    const r = a.assert(challenge);
    expect(wa.credentialId(r)).toBe(stored.id);
    expect(await wa.verifyAuthentication({ response: r, challenge, credential: stored })).toEqual({ newCounter: 5 });
  });
  it.each([
    ['another origin', { origin: 'https://evil.example' }],
    ['another RP ID', { rpId: 'evil.example' }],
    ['no user verification', { flags: UP }],
  ] as const)('refused: %s', async (_n, o) => {
    const { a, stored } = await enrolled();
    a.counter = 1;
    const { challenge } = await wa.authenticationOptions();
    expect(await wa.verifyAuthentication({ response: a.assert(challenge, o), challenge, credential: stored })).toBeNull();
  });
  it('refused: a counter going backwards (a cloned passkey)', async () => {
    const { a, stored } = await enrolled();
    a.counter = 3;
    const { challenge } = await wa.authenticationOptions();
    expect(await wa.verifyAuthentication({ response: a.assert(challenge), challenge, credential: { ...stored, counter: 7 } })).toBeNull();
  });
  it('refused: another passkey\'s signature', async () => {
    const { stored } = await enrolled();
    const other = new SoftAuthenticator();
    const { challenge } = await wa.authenticationOptions();
    const r = other.assert(challenge);
    expect(await wa.verifyAuthentication({ response: { ...r, id: stored.id, rawId: stored.id }, challenge, credential: stored })).toBeNull();
  });
});

// philobiblos#30: the app was Shelf, and so was its RP name. A passkey is bound to the RP ID (the origin's host), never to
// the name, so one made before the rename, on the same address, still signs in after it.
describe('the rename keeps every passkey', () => {
  it('the prompt shows the new name; the RP ID is still the origin\'s host', async () => {
    const { options } = await wa.registrationOptions({ userId: 'p_alex', userName: 'Alex', exclude: [] });
    expect(options).toMatchObject({ rp: { name: RP_NAME, id: RP_ID } });
    expect(RP_NAME).toBe('Philobiblos');
  });
  it('a passkey enrolled by the old deployment (SHELF_ORIGIN) signs in to the new one (PHILOBIBLOS_ORIGIN)', async () => {
    const before = loadConfig({ SHELF_MODE: 'standalone', SHELF_DATA_DIR: '/nonexistent', SHELF_ORIGIN: ORIGIN });
    resetLegacyEnvWarning();
    const after = loadConfig({ PHILOBIBLOS_MODE: 'standalone', PHILOBIBLOS_DATA_DIR: '/nonexistent', PHILOBIBLOS_ORIGIN: ORIGIN });
    const old = simpleWebAuthn(before), now = simpleWebAuthn(after);
    const a = new SoftAuthenticator();
    const reg = await old.registrationOptions({ userId: 'p_alex', userName: 'Alex', exclude: [] });
    const cred = (await old.verifyRegistration({ response: a.register(reg.challenge), challenge: reg.challenge }))!;
    expect(cred).not.toBeNull();
    a.counter = 2;
    const { challenge } = await now.authenticationOptions();
    expect(await now.verifyAuthentication({ response: a.assert(challenge), challenge, credential: { id: cred.id, publicKey: cred.publicKey, counter: cred.counter, transports: cred.transports } })).toEqual({ newCounter: 2 });
  });
});
