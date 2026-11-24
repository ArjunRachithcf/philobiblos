// Joining with a household join link (standalone; ADR 0011, philobiblos#34 slice 2). Under HomersLab every route here
// answers 404: Homeward decides who arrives.
//
// Public, for whoever holds a link (the token comes in the body, from the page's #fragment):
// - POST /join/open: whether the link opens here (204), or the one answer for every link that does not;
// - POST /join/options: a name and a passkey's options; POST /join/verify: the passkey enrolled, the person waits.
// An unknown, expired, revoked, used-up or out-of-network link, and a full waiting list, all get the same answer
// (NOT_HERE, 404), after the same work and no sooner than JOIN_FLOOR_MS, so neither the answer nor its time tells
// them apart. A name is never compared with the household's: a member's name gets the same answer as any other.
// Opening, and joining (options and verify), are limited per client address and per link (429 past it); the limits
// are counted before the link is looked at, so a link that works and one that does not are limited alike.
//
// Admins (both with a fresh sign-in, as any change that lets people in or out): the home networks, and join links.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Config } from '../config';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { requireAdmin, requireFreshSignIn } from '../auth/hook';
import { requestSession, startSession } from '../auth/cookie';
import { anyPerson } from '../household/waiting';
import { passkeyLabel, passkeyRow, type Challenges, type WebAuthn } from '../auth/webauthn';
import { JOIN_LINK, JoinLinkError, checkLink, createJoinLink, listJoinLinks, presentedHash, revokeJoinLink, spendUse } from '../household/join-links';
import { NETWORKS, homeNetworks, parseCidr, proposeNetwork, setHomeNetworks, type Cidr } from '../net/networks';
import { view } from '../household/people';
import { lapseIn, lapseWaiting } from '../household/waiting-rows';
import { Limiter } from '../shares/tokens';

/** Opening a link: 20 in 10 minutes per client address, and per link. */
export const JOIN_OPEN = { max: 20, windowMs: 10 * 60_000 } as const;
/** Joining (a passkey's options and its enrolment): 10 in 10 minutes per client address, and per link. */
export const JOIN_ENROL = { max: 10, windowMs: 10 * 60_000 } as const;
/** No answer of the public join routes comes sooner than this after the request. */
export const JOIN_FLOOR_MS = 200;

/** The one answer for every link that does not open here. */
export const NOT_HERE = { error: 'This link does not open here. Ask whoever sent it to you.' } as const;
const TOO_MANY = { error: 'Too many tries with this link: wait a few minutes.' } as const;

/** A name as a person gives it: 1 to 60 characters, no control characters; null otherwise. */
export function joinName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v)) return null;
  const name = v.normalize('NFC').trim();
  return name.length >= 1 && name.length <= 60 ? name : null;
}

export interface JoinOptions { joined?: () => void; floorMs?: number }

export async function joinRoutes(app: FastifyInstance, cfg: Config, db: Db, webauthn: WebAuthn, challenges: Challenges, o: JoinOptions = {}) {
  const floor = o.floorMs ?? JOIN_FLOOR_MS;
  const opening = new Limiter(JOIN_OPEN.max, JOIN_OPEN.windowMs);
  const joining = new Limiter(JOIN_ENROL.max, JOIN_ENROL.windowMs);
  const standaloneOnly = (reply: FastifyReply) => {
    if (cfg.mode === 'standalone') return true;
    void reply.code(404).send({ error: 'not found' });
    return false;
  };
  const address = (req: FastifyRequest) => req.socket.remoteAddress;
  /** Both limits counted, whatever the first says. */
  const within = (l: Limiter, req: FastifyRequest, hash: string) => {
    const byAddress = l.hit(`a:${address(req) ?? ''}`);
    const byLink = l.hit(`l:${hash}`);
    return byAddress && byLink;
  };
  /** Waits out what is left of the floor, then sends. */
  const answer = async (reply: FastifyReply, start: number, status: number, body?: unknown) => {
    const left = floor - (performance.now() - start);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
    return body === undefined ? reply.code(status).send() : reply.code(status).send(body);
  };
  const pub = { config: { auth: 'public' as const } };

  app.post<{ Body: { token?: unknown } }>('/join/open', pub, async (req, reply) => {
    const start = performance.now();
    if (!standaloneOnly(reply)) return;
    const hash = presentedHash(req.body?.token);
    if (!within(opening, req, hash)) return answer(reply, start, 429, TOO_MANY);
    lapseWaiting(db);
    const link = checkLink(db, { hash }, address(req));
    return link ? answer(reply, start, 204) : answer(reply, start, 404, NOT_HERE);
  });

  app.post<{ Body: { token?: unknown; name?: unknown } }>('/join/options', pub, async (req, reply) => {
    const start = performance.now();
    if (!standaloneOnly(reply)) return;
    const hash = presentedHash(req.body?.token);
    if (!within(joining, req, hash)) return answer(reply, start, 429, TOO_MANY);
    const name = joinName(req.body?.name);
    if (!name) return answer(reply, start, 400, { error: 'Your name, as the household calls you: 1 to 60 characters.' });
    // A member signed in on this browser is not asked to join again (their session would give way to a new person's).
    const s = requestSession(db, req, reply);
    if (s && anyPerson(db, s.personId)?.state === 'active') return answer(reply, start, 409, { error: 'You are signed in to the household already: this link is for someone new.' });
    lapseWaiting(db);
    const link = checkLink(db, { hash }, address(req));
    if (!link) return answer(reply, start, 404, NOT_HERE);
    // The person to be: their id is the passkey's user handle. Nothing is stored until the passkey is enrolled.
    const personId = ulid();
    const { challenge, options } = await webauthn.registrationOptions({ userId: personId, userName: name, exclude: [] });
    return answer(reply, start, 200, { challengeId: challenges.put({ challenge, kind: 'join', joinLinkId: link.id, tokenHash: hash, personId, name }), options });
  });

  app.post<{ Body: { challengeId?: unknown; response?: unknown; label?: unknown } }>('/join/verify', pub, async (req, reply) => {
    const start = performance.now();
    if (!standaloneOnly(reply)) return;
    // The address first, so a limited request does not spend its one-time step; then its link, once it is known.
    if (!joining.hit(`a:${address(req) ?? ''}`)) return answer(reply, start, 429, TOO_MANY);
    const pending = challenges.take(req.body?.challengeId, 'join');
    if (pending?.tokenHash && !joining.hit(`l:${pending.tokenHash}`)) return answer(reply, start, 429, TOO_MANY);
    if (!pending?.joinLinkId || !pending.personId || !pending.name) return answer(reply, start, 401, { error: 'this step expired; start again' });
    const cred = await webauthn.verifyRegistration({ response: req.body?.response, challenge: pending.challenge });
    if (!cred) return answer(reply, start, 401, { error: 'the passkey could not be verified' });
    const label = passkeyLabel(req.body?.label);
    const now = new Date();
    let outcome: 'joined' | 'not-here' | 'taken' = 'not-here';
    try {
      db.transaction((tx0) => {
        const tx = tx0 as unknown as Db;
        // The link is checked again here: revoked, expired, used up, the address or a full list since the options.
        lapseIn(tx, now);
        const link = checkLink(tx, { id: pending.joinLinkId! }, address(req), now);
        if (!link) return;
        if (tx.select({ id: t.passkey.id }).from(t.passkey).where(eq(t.passkey.id, cred.id)).get()) { outcome = 'taken'; return; }
        tx.insert(t.person).values({ id: pending.personId!, name: pending.name!, role: 'adult', state: 'waiting', handle: null, arrivedAt: now.toISOString(), settingsJson: '{}' }).run();
        tx.insert(t.joinRequest).values({ personId: pending.personId!, joinLinkId: link.id, fromHomeNetwork: 1 }).run();
        tx.insert(t.passkey).values(passkeyRow(cred, pending.personId!, label, now.toISOString())).run();
        // The use counts here and only here, with the passkey (checkLink saw room for it in this same transaction).
        if (!spendUse(tx, link.id, now)) throw new Error('a join link use was not counted');
        outcome = 'joined';
      }, { behavior: 'immediate' });
    } catch (e) {
      if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') outcome = 'taken';
      else throw e;
    }
    if (outcome === 'taken') return answer(reply, start, 409, { error: 'this passkey is already enrolled' });
    if (outcome === 'not-here') return answer(reply, start, 404, NOT_HERE);
    startSession(db, req, reply, pending.personId, cred.id);
    o.joined?.();
    const p = db.select().from(t.person).where(eq(t.person.id, pending.personId)).get()!;
    return answer(reply, start, 200, { mode: cfg.mode, signedIn: true, setupNeeded: false, waiting: true, person: view(db, p) });
  });

  // Admins ------------------------------------------------------------------
  const admin = (req: FastifyRequest, reply: FastifyReply) => standaloneOnly(reply) && requireAdmin(req, reply);
  const networksView = (req: FastifyRequest) => ({ networks: homeNetworks(db), proposal: proposeNetwork(address(req)) });

  app.get('/people/home-networks', async (req, reply) => {
    if (!admin(req, reply)) return;
    return networksView(req);
  });

  app.put<{ Body: { networks?: unknown } }>('/people/home-networks', async (req, reply) => {
    if (!admin(req, reply) || !requireFreshSignIn(req, reply)) return;
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'networks') || !Array.isArray(b.networks) || b.networks.length > NETWORKS.max) {
      return reply.code(400).send({ error: `networks: a list of at most ${NETWORKS.max} ranges` });
    }
    const parsed: Cidr[] = [];
    for (const n of b.networks) {
      const c = parseCidr(n);
      if (!c) return reply.code(400).send({ error: `not a range Philobiblos takes: ${String(n).slice(0, 64)} (a CIDR such as 192.0.2.0/24, at most /${NETWORKS.minPrefix4} wide, or /${NETWORKS.minPrefix6} for IPv6)` });
      parsed.push(c);
    }
    setHomeNetworks(db, parsed, req.caller!.personId);
    return networksView(req);
  });

  app.get('/people/join-links', async (req, reply) => {
    if (!admin(req, reply)) return;
    return listJoinLinks(db);
  });

  app.post<{ Body: { days?: unknown; uses?: unknown } }>('/people/join-links', async (req, reply) => {
    if (!admin(req, reply) || !requireFreshSignIn(req, reply)) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const int = (v: unknown, max: number) => v === undefined || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max);
    if (typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'days' && k !== 'uses') || !int(b.days, JOIN_LINK.maxDays) || !int(b.uses, JOIN_LINK.maxUses)) {
      return reply.code(400).send({ error: `days: 1 to ${JOIN_LINK.maxDays} (${JOIN_LINK.days} by default); uses: 1 to ${JOIN_LINK.maxUses} (${JOIN_LINK.uses} by default)` });
    }
    try {
      const l = createJoinLink(db, cfg, { createdBy: req.caller!.personId, days: b.days as number | undefined, uses: b.uses as number | undefined });
      return reply.code(201).send({ id: l.id, url: l.url, expiresAt: l.expiresAt.toISOString(), maxUses: l.maxUses });
    } catch (e) {
      if (e instanceof JoinLinkError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });

  app.delete<{ Params: { id: string } }>('/people/join-links/:id', async (req, reply) => {
    if (!admin(req, reply) || !requireFreshSignIn(req, reply)) return;
    try { revokeJoinLink(db, req.params.id); return reply.code(204).send(); } catch (e) {
      if (e instanceof JoinLinkError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });
}

