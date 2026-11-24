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
// The client address is the connection's, or the forwarded one only from PHILOBIBLOS_TRUSTED_PROXY (net/proxy.ts
// clientAddress): a forged X-Forwarded-For from anywhere else is ignored, and a trusted proxy that sends none Philobiblos
// can read gives no address (in no household network; limited as the proxy). A link's rules (household/join-links.ts):
// whoever matches every rule of a link that accepts automatically is an adult at once, never an admin; whatever the
// body says, nothing here sets a role but RULE_ROLE.
//
// The mail-domain rule (slice 4a, household/join-code.ts), only while SMTP is set (404 otherwise):
// - /join/open says `askAddress` for a link that has it; POST /join/code: an address, and a code mailed to it when it may
//   be (always the same answer, a request token, whether a mail went out or not); POST /join/code/check: the code;
//   /join/options then carries the request whose code was right, and the enrolment judges the rules with its domain.
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
import { JOIN_LINK, JoinLinkError, RULE_ROLE, checkLink, createJoinLink, linkNetworks, listJoinLinks, presentedHash, revokeJoinLink, rulesView, spendUse, type LinkRules } from '../household/join-links';
import { NETWORKS, NO_SURROUNDINGS, homeNetworks, isHop, parseCidr, proposeNetwork, rangeProblem, setHomeNetworks, surroundingsWarning, type Cidr, type Surroundings } from '../net/networks';
import { addressKey, clientAddress } from '../net/proxy';
import { domainOf, plainAddress } from '../net/smtp';
import { askCode, checkCode, codeMail, mailDomain, pruneCodes, requestHash, requestLink, takeVerified, verifiedAddress, type CodeMail } from '../household/join-code';

export { addressKey };
import { suggestHandle, view } from '../household/people';
import { lapseIn, lapseWaiting } from '../household/waiting-rows';
import { Limiter } from '../shares/tokens';

/** Opening a link: 20 in 10 minutes per client address, and per link. */
export const JOIN_OPEN = { max: 20, windowMs: 10 * 60_000 } as const;
/** Joining (a passkey's options and its enrolment): 10 in 10 minutes per client address, and per link. */
export const JOIN_ENROL = { max: 10, windowMs: 10 * 60_000 } as const;
/**
 * Asking for a code: 20 in 10 minutes per client address, and per link. Above the send limits (household/join-code.ts
 * JOIN_CODE), so a link's 11th code of a day gets the answer every other request does, not a 429 that would tell.
 */
export const JOIN_CODE_ASK = { max: 20, windowMs: 10 * 60_000 } as const;
/** Trying a code: 10 in 10 minutes per client address, and per link (each request has 5 tries of its own). */
export const JOIN_CODE_TRY = { max: 10, windowMs: 10 * 60_000 } as const;
/** No answer of the public join routes comes sooner than this after the request. */
export const JOIN_FLOOR_MS = 200;

/** The one answer for every link that does not open here. */
export const NOT_HERE = { error: 'This link does not open here. Ask whoever sent it to you.' } as const;
const TOO_MANY = { error: 'Too many tries with this link: wait a few minutes.' } as const;
/** The one answer for a code that does not let anyone in: wrong, expired, out of tries, or never sent. */
export const WRONG_CODE = { error: 'That code is not right, or it expired. Ask for a new one.' } as const;

/** A name as a person gives it: 1 to 60 characters, no control characters; null otherwise. */
export function joinName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // Control characters, line separators and default-ignorable ones (bidi controls, zero-width, joiners, variation
  // selectors, tags): a name an admin reads must look like what it is.
  if (/[\p{Cc}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u.test(v)) return null;
  const name = v.normalize('NFC').trim();
  return name.length >= 1 && name.length <= 60 ? name : null;
}

export interface JoinOptions { joined?: () => void; floorMs?: number; surroundings?: Surroundings; linkKeys?: number; mail?: CodeMail }

/** How many links (presented tokens) a per-link limiter counts at once; past it, new ones are refused. */
export const JOIN_LINK_KEYS = 10_000;

export async function joinRoutes(app: FastifyInstance, cfg: Config, db: Db, webauthn: WebAuthn, challenges: Challenges, o: JoinOptions = {}) {
  const floor = o.floorMs ?? JOIN_FLOOR_MS;
  const where = o.surroundings ?? NO_SURROUNDINGS;
  // Surroundings that fail closed are said once at start (and on People): no join link opens here.
  const warning = cfg.mode === 'standalone' ? surroundingsWarning(where) : null;
  if (warning) app.log.warn(warning);
  // Per address and per link in limiters of their own: a flood of addresses never evicts a link's count, and a link's
  // limiter refuses a new key when it is full rather than forget one (net effect: a flood of made-up links is refused).
  const opening = { byAddress: new Limiter(JOIN_OPEN.max, JOIN_OPEN.windowMs), byLink: new Limiter(JOIN_OPEN.max, JOIN_OPEN.windowMs, o.linkKeys ?? JOIN_LINK_KEYS, 'refuse') };
  const joining = { byAddress: new Limiter(JOIN_ENROL.max, JOIN_ENROL.windowMs), byLink: new Limiter(JOIN_ENROL.max, JOIN_ENROL.windowMs, o.linkKeys ?? JOIN_LINK_KEYS, 'refuse') };
  const asking = { byAddress: new Limiter(JOIN_CODE_ASK.max, JOIN_CODE_ASK.windowMs), byLink: new Limiter(JOIN_CODE_ASK.max, JOIN_CODE_ASK.windowMs, o.linkKeys ?? JOIN_LINK_KEYS, 'refuse') };
  const trying = { byAddress: new Limiter(JOIN_CODE_TRY.max, JOIN_CODE_TRY.windowMs), byLink: new Limiter(JOIN_CODE_TRY.max, JOIN_CODE_TRY.windowMs, o.linkKeys ?? JOIN_LINK_KEYS, 'refuse') };
  // The mail-domain rule's codes: a key only while SMTP is set (and the sealing key can be read), the rule offered then.
  const mail = o.mail ?? codeMail(cfg);
  const match = (verifiedDomain: string | null, assume = false) => ({ offered: mail.key !== null, publicDomains: mail.publicDomains, verifiedDomain, assume });
  const codesOn = (reply: FastifyReply) => {
    if (mail.key) return true;
    void reply.code(404).send({ error: 'not found' });
    return false;
  };
  const standaloneOnly = (reply: FastifyReply) => {
    if (cfg.mode === 'standalone') return true;
    void reply.code(404).send({ error: 'not found' });
    return false;
  };
  /** The client's address (null: the trusted proxy forwarded none it can read). */
  const address = (req: FastifyRequest) => clientAddress(cfg.trustedProxy, req.socket.remoteAddress, req.headers['x-forwarded-for']);
  /** The key a client is limited by; one the trusted proxy names no one for counts as the proxy. */
  const limitKey = (req: FastifyRequest) => addressKey(address(req) ?? `${req.socket.remoteAddress ?? ''}`);
  /** Both limits counted, whatever the first says. */
  const within = (l: typeof opening, req: FastifyRequest, hash: string) => {
    const byAddress = l.byAddress.hit(limitKey(req));
    const byLink = l.byLink.hit(hash);
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
    // The same 204 whether the person would wait or be let in at once: they learn which at the enrolment. A link with
    // the mail-domain rule opens for whoever would match it once their address is verified, and asks for one.
    const link = checkLink(db, { hash }, address(req), new Date(), where, match(null, true));
    if (!link) return answer(reply, start, 404, NOT_HERE);
    return link.link.mailDomain !== null && mail.key ? answer(reply, start, 200, { askAddress: true }) : answer(reply, start, 204);
  });

  app.post<{ Body: { token?: unknown; address?: unknown } }>('/join/code', pub, async (req, reply) => {
    const start = performance.now();
    if (!standaloneOnly(reply) || !codesOn(reply)) return;
    const hash = presentedHash(req.body?.token);
    if (!within(asking, req, hash)) return answer(reply, start, 429, TOO_MANY);
    // One plain address, the only recipient: no display name, line break, comma or space.
    const to = plainAddress(req.body?.address);
    if (!to) return answer(reply, start, 400, { error: 'One address, such as name@example.org.' });
    lapseWaiting(db);
    // A mail goes out only when the link opens for this client and this address would match its rules: its domain
    // exactly, never a public provider's; and the limits leave room. Whatever happens, the same answer.
    const admission = checkLink(db, { hash }, address(req), new Date(), where, match(domainOf(to)));
    const eligible = admission !== null && admission.link.mailDomain !== null && admission.matches === true;
    const { request, send } = askCode(db, mail.key!, { linkId: eligible ? admission.link.id : null, to: eligible ? to : null });
    // Sent after the answer is decided, never awaited: its time says nothing either.
    if (send) void mail.send(send.to, send.code).catch(() => app.log.warn('a join code was not sent: the SMTP server could not be reached or refused it'));
    return answer(reply, start, 200, { request });
  });

  app.post<{ Body: { request?: unknown; code?: unknown } }>('/join/code/check', pub, async (req, reply) => {
    const start = performance.now();
    if (!standaloneOnly(reply) || !codesOn(reply)) return;
    const hash = requestHash(req.body?.request);
    const byAddress = trying.byAddress.hit(limitKey(req));
    const byLink = trying.byLink.hit(requestLink(db, hash) ?? hash);
    if (!byAddress || !byLink) return answer(reply, start, 429, TOO_MANY);
    return checkCode(db, mail.key!, hash, req.body?.code) ? answer(reply, start, 204) : answer(reply, start, 400, WRONG_CODE);
  });

  app.post<{ Body: { token?: unknown; name?: unknown; request?: unknown } }>('/join/options', pub, async (req, reply) => {
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
    // The request whose code was right, if any: its domain counts for the rules (judged again at the enrolment).
    const codeRequest = req.body?.request === undefined ? null : requestHash(req.body.request);
    const peek = db.select({ id: t.joinLink.id }).from(t.joinLink).where(eq(t.joinLink.tokenHash, hash)).get();
    const verified = peek ? verifiedAddress(db, codeRequest, peek.id) : null;
    const admission = checkLink(db, { hash }, address(req), new Date(), where, match(verified ? domainOf(verified) : null));
    if (!admission) return answer(reply, start, 404, NOT_HERE);
    const link = admission.link;
    // The person to be: their id is the passkey's user handle. Nothing is stored until the passkey is enrolled.
    const personId = ulid();
    const { challenge, options } = await webauthn.registrationOptions({ userId: personId, userName: name, exclude: [] });
    return answer(reply, start, 200, { challengeId: challenges.put({ challenge, kind: 'join', joinLinkId: link.id, tokenHash: hash, personId, name, ...(codeRequest ? { codeRequest } : {}) }), options });
  });

  app.post<{ Body: { challengeId?: unknown; response?: unknown; label?: unknown } }>('/join/verify', pub, async (req, reply) => {
    const start = performance.now();
    if (!standaloneOnly(reply)) return;
    // Both limits before the one-time step is taken, so a 429 does not spend it; the link's is known from the step.
    const peeked = challenges.peek(req.body?.challengeId, 'join');
    const byAddress = joining.byAddress.hit(limitKey(req));
    const byLink = peeked?.tokenHash ? joining.byLink.hit(peeked.tokenHash) : true;
    if (!byAddress || !byLink) return answer(reply, start, 429, TOO_MANY);
    const pending = challenges.take(req.body?.challengeId, 'join');
    if (!pending?.joinLinkId || !pending.personId || !pending.name) return answer(reply, start, 401, { error: 'this step expired; start again' });
    const cred = await webauthn.verifyRegistration({ response: req.body?.response, challenge: pending.challenge });
    if (!cred) return answer(reply, start, 401, { error: 'the passkey could not be verified' });
    const label = passkeyLabel(req.body?.label);
    const now = new Date();
    let outcome: 'joined' | 'accepted' | 'not-here' | 'taken' = 'not-here';
    try {
      db.transaction((tx0) => {
        const tx = tx0 as unknown as Db;
        // The link is checked again here: revoked, expired, used up, the address or a full list since the options.
        lapseIn(tx, now);
        pruneCodes(tx, now);
        // The rules are judged here, at the enrolment, not at the options; a verified address is taken (its request
        // goes) and moves to the join request, or, for someone let in, only its domain stays.
        const verified = takeVerified(tx, pending.codeRequest, pending.joinLinkId!, now);
        const admission = checkLink(tx, { id: pending.joinLinkId! }, address(req), now, where, match(verified ? domainOf(verified) : null));
        if (!admission) return;
        const { link } = admission;
        const domainMatched = verified !== null && link.mailDomain !== null && admission.matches === true;
        if (tx.select({ id: t.passkey.id }).from(t.passkey).where(eq(t.passkey.id, cred.id)).get()) { outcome = 'taken'; return; }
        // Always RULE_ROLE (an adult), whatever anyone sent: a rule match is a member at once, anyone else waits.
        const accepted = admission.outcome === 'accept';
        tx.insert(t.person).values({
          id: pending.personId!, name: pending.name!, role: RULE_ROLE, state: accepted ? 'active' : 'waiting', handle: accepted ? suggestHandle(tx, pending.name!) : null,
          arrivedAt: now.toISOString(), settingsJson: '{}', ...(accepted ? { admittedLink: link.id, admittedBy: link.createdBy, admittedDomain: domainMatched ? link.mailDomain : null } : {}),
        }).run();
        if (!accepted) {
          tx.insert(t.joinRequest).values({
            personId: pending.personId!, joinLinkId: link.id, fromHomeNetwork: 1, matchesRules: admission.matches === null ? null : admission.matches ? 1 : 0,
            verifiedAddress: link.mailDomain !== null ? verified : null,
          }).run();
        }
        tx.insert(t.passkey).values(passkeyRow(cred, pending.personId!, label, now.toISOString())).run();
        // The use counts here and only here, with the passkey (checkLink saw room for it in this same transaction).
        if (!spendUse(tx, link.id, now)) throw new Error('a join link use was not counted');
        outcome = admission.outcome === 'accept' ? 'accepted' : 'joined';
      }, { behavior: 'immediate' });
    } catch (e) {
      if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') outcome = 'taken';
      else throw e;
    }
    if (outcome === 'taken') return answer(reply, start, 409, { error: 'this passkey is already enrolled' });
    if (outcome === 'not-here') return answer(reply, start, 404, NOT_HERE);
    startSession(db, req, reply, pending.personId, cred.id);
    // The admins are told (the push's kind alone): someone waits, or a link's rules let someone in (People lists them).
    o.joined?.();
    const p = db.select().from(t.person).where(eq(t.person.id, pending.personId)).get()!;
    return answer(reply, start, 200, { mode: cfg.mode, signedIn: true, setupNeeded: false, waiting: outcome === 'joined', person: view(db, p) });
  });

  // Admins ------------------------------------------------------------------
  const admin = (req: FastifyRequest, reply: FastifyReply) => standaloneOnly(reply) && requireAdmin(req, reply);
  // behindProxy: Philobiblos sees the admin as a hop (loopback, the container's own networks: a proxy that is not
  // PHILOBIBLOS_TRUSTED_PROXY, a published port), or the trusted proxy forwarded no address it can read, so every visitor
  // is: no link opens. trustedProxy: whether one is set (what the notice tells the admin to do). surroundings: why a
  // container fails closed, if it does (ipv6.disable=1 leaves no /proc/net/ipv6_route).
  const networksView = (req: FastifyRequest) => {
    const a = address(req);
    return {
      networks: homeNetworks(db), proposal: proposeNetwork(a, where), behindProxy: a === null || isHop(where, a),
      trustedProxy: cfg.trustedProxy !== null, surroundings: where.known ? 'known' as const : where.unknown ?? 'unreadable' as const,
      // What leaves for the mail-domain rule: the SMTP server codes go through; null: SMTP unset, the rule not offered.
      mailCodes: mail.key && mail.host ? { host: mail.host } : null,
    };
  };

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
      const problem = rangeProblem(where, c);
      if (problem) return reply.code(400).send({ error: problem });
      parsed.push(c);
    }
    setHomeNetworks(db, parsed, req.caller!.personId);
    return networksView(req);
  });

  app.get('/people/join-links', async (req, reply) => {
    if (!admin(req, reply)) return;
    return listJoinLinks(db);
  });

  const LINK_KEYS = new Set(['days', 'uses', 'accept', 'nonMatches', 'networks', 'mailDomain']);
  app.post<{ Body: Record<string, unknown> }>('/people/join-links', async (req, reply) => {
    if (!admin(req, reply) || !requireFreshSignIn(req, reply)) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const int = (v: unknown, max: number) => v === undefined || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max);
    if (typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !LINK_KEYS.has(k)) || !int(b.days, JOIN_LINK.maxDays) || !int(b.uses, JOIN_LINK.maxUses)
      || (b.accept !== undefined && b.accept !== 'approval' && b.accept !== 'automatic') || (b.nonMatches !== undefined && b.nonMatches !== 'wait' && b.nonMatches !== 'refuse')) {
      return reply.code(400).send({ error: `days: 1 to ${JOIN_LINK.maxDays} (${JOIN_LINK.days} by default); uses: 1 to ${JOIN_LINK.maxUses} (${JOIN_LINK.uses} by default); accept: approval (the default) or automatic; nonMatches: wait (the default) or refuse; networks: ranges inside the home network; mailDomain: a domain (with SMTP set)` });
    }
    let domain: string | null = null;
    if (b.mailDomain !== undefined && b.mailDomain !== null) {
      if (!mail.key) return reply.code(400).send({ error: 'mailDomain: the mail-domain rule needs outgoing SMTP, set by whoever runs Philobiblos (PHILOBIBLOS_SMTP_HOST)' });
      domain = mailDomain(b.mailDomain);
      if (!domain) return reply.code(400).send({ error: 'mailDomain: a domain such as example.org' });
      if (mail.publicDomains.has(domain)) return reply.code(400).send({ error: `mailDomain: anyone can have an address at ${domain} (a public mail provider), so it cannot let anyone in` });
    }
    try {
      const rules: LinkRules = {
        automatic: b.accept === 'automatic', refuseNonMatches: b.nonMatches === 'refuse',
        networks: b.networks === undefined ? null : linkNetworks(db, b.networks, where),
        mailDomain: domain,
      };
      const l = createJoinLink(db, cfg, { createdBy: req.caller!.personId, days: b.days as number | undefined, uses: b.uses as number | undefined, rules });
      return reply.code(201).send({ id: l.id, url: l.url, expiresAt: l.expiresAt.toISOString(), maxUses: l.maxUses, ...rulesView(rules) });
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

