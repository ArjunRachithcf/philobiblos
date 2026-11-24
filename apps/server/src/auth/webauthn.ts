// Passkeys (ADR 0010) with @simplewebauthn/server: discoverable credentials, user verification required at enrolment
// and at every sign-in, no attestation. Challenges live in memory for 5 minutes and are used once.
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransport, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { randomBytes } from 'node:crypto';
import type { Config } from '../config';

export interface NewCredential { id: string; publicKey: Uint8Array; counter: number; transports: string[]; backedUp: boolean }
export interface StoredCredential { id: string; publicKey: Uint8Array; counter: number; transports: string[] }

/** The WebAuthn operations Philobiblos needs; tests swap in a fake, production uses @simplewebauthn/server. */
export interface WebAuthn {
  registrationOptions(i: { userId: string; userName: string; exclude: StoredCredential[] }): Promise<{ challenge: string; options: object }>;
  verifyRegistration(i: { response: unknown; challenge: string }): Promise<NewCredential | null>;
  authenticationOptions(): Promise<{ challenge: string; options: object }>;
  /** The credential id the response claims, before any verification (to look the passkey up). */
  credentialId(response: unknown): string | null;
  verifyAuthentication(i: { response: unknown; challenge: string; credential: StoredCredential }): Promise<{ newCounter: number } | null>;
}

const transports = (t: string[]) => t as AuthenticatorTransport[];

/**
 * The name a passkey prompt shows (it was "Shelf" before philobiblos#30). Only the name: the RP ID stays the origin's
 * host (config.ts rpId), which is what a passkey is bound to, so the passkeys made under the old name keep signing in.
 */
export const RP_NAME = 'Philobiblos';

export function simpleWebAuthn(cfg: Pick<Config, 'origin' | 'rpId'>): WebAuthn {
  return {
    async registrationOptions({ userId, userName, exclude }) {
      const options = await generateRegistrationOptions({
        rpName: RP_NAME, rpID: cfg.rpId, userName, userDisplayName: userName,
        userID: new TextEncoder().encode(userId),
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: exclude.map((c) => ({ id: c.id, transports: transports(c.transports) })),
      });
      return { challenge: options.challenge, options };
    },
    async verifyRegistration({ response, challenge }) {
      try {
        const r = await verifyRegistrationResponse({
          response: response as RegistrationResponseJSON, expectedChallenge: challenge,
          expectedOrigin: cfg.origin, expectedRPID: cfg.rpId, requireUserVerification: true,
        });
        if (!r.verified) return null;
        const c = r.registrationInfo.credential;
        return { id: c.id, publicKey: c.publicKey, counter: c.counter, transports: c.transports ?? [], backedUp: r.registrationInfo.credentialBackedUp };
      } catch {
        return null;
      }
    },
    async authenticationOptions() {
      const options = await generateAuthenticationOptions({ rpID: cfg.rpId, userVerification: 'required' });
      return { challenge: options.challenge, options };
    },
    credentialId(response) {
      const id = (response as { id?: unknown } | null)?.id;
      return typeof id === 'string' && /^[A-Za-z0-9_-]{16,1400}$/.test(id) ? id : null;
    },
    async verifyAuthentication({ response, challenge, credential }) {
      try {
        const r = await verifyAuthenticationResponse({
          response: response as AuthenticationResponseJSON, expectedChallenge: challenge,
          expectedOrigin: cfg.origin, expectedRPID: cfg.rpId, requireUserVerification: true,
          credential: { id: credential.id, publicKey: new Uint8Array(credential.publicKey), counter: credential.counter, transports: transports(credential.transports) },
        });
        return r.verified ? { newCounter: r.authenticationInfo.newCounter } : null;
      } catch {
        return null;
      }
    },
  };
}

/** A passkey's label as a person gives it: trimmed, at most 40 characters, 'Passkey' when empty. */
export const passkeyLabel = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : 'Passkey');

/** The passkey row of a verified enrolment (auth.ts's links, join.ts's join links). */
export const passkeyRow = (cred: NewCredential, personId: string, label: string, createdAt: string, invitedBy: string | null = null) => ({
  id: cred.id, personId, publicKey: Buffer.from(cred.publicKey), counter: cred.counter,
  transportsJson: JSON.stringify(cred.transports), backedUp: cred.backedUp ? 1 : 0, label, createdAt, invitedBy,
});

export interface Pending {
  challenge: string; kind: 'enrol' | 'sign-in' | 'join'; inviteId?: string; name?: string; expires: number;
  /** 'join' (household/join-links.ts): the link, the presented token's hash (its rate limit) and the person to be. */
  joinLinkId?: string; tokenHash?: string; personId?: string;
}

/** One-time challenges, 5 minutes, at most 1000 waiting (the oldest go first). */
export class Challenges {
  private readonly m = new Map<string, Pending>();
  constructor(private readonly ttlMs = 5 * 60_000, private readonly max = 1000) {}
  put(p: Omit<Pending, 'expires'>, now = Date.now()): string {
    for (const [k, v] of this.m) if (v.expires <= now) this.m.delete(k);
    while (this.m.size >= this.max) this.m.delete(this.m.keys().next().value!);
    const id = randomBytes(18).toString('base64url');
    this.m.set(id, { ...p, expires: now + this.ttlMs });
    return id;
  }
  /** The step, left in place (a rate limit reads its link before deciding whether to take it). */
  peek(id: unknown, kind: Pending['kind'], now = Date.now()): Pending | null {
    if (typeof id !== 'string') return null;
    const p = this.m.get(id);
    return p && p.kind === kind && p.expires > now ? p : null;
  }
  take(id: unknown, kind: Pending['kind'], now = Date.now()): Pending | null {
    if (typeof id !== 'string') return null;
    const p = this.m.get(id);
    this.m.delete(id);
    return p && p.kind === kind && p.expires > now ? p : null;
  }
}
