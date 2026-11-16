// The session cookie on a request and its reply (ADR 0010), with the cookie's old name (sessions.ts
// LEGACY_SESSION_COOKIE) read until 0.2.0 and moved to the new one the first time it comes.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/open';
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE, cookieOptions, endSession, liveSession, sessionToken, type Session } from './sessions';

/**
 * The live session the request's cookie names, or null. A request that brought only the old cookie gets the new one
 * (the same token, for what is left of the session) and the old one cleared, whether or not it was still alive.
 */
export function requestSession(db: Db, req: FastifyRequest, reply: FastifyReply, now = new Date()): Session | null {
  const { token, legacy } = sessionToken(req.cookies);
  const s = liveSession(db, token, now);
  if (legacy) {
    void reply.clearCookie(LEGACY_SESSION_COOKIE, { path: '/' });
    const left = s ? Math.floor((new Date(s.expiresAt).getTime() - now.getTime()) / 1000) : 0;
    if (s && token && left > 0) void reply.setCookie(SESSION_COOKIE, token, cookieOptions(left));
  }
  return s;
}

/** Ends the sessions of both cookies a request may carry (sign-in replaces them, sign-out ends them). */
export function endRequestSessions(db: Db, req: FastifyRequest): void {
  endSession(db, req.cookies?.[SESSION_COOKIE]);
  endSession(db, req.cookies?.[LEGACY_SESSION_COOKIE]);
}

/** Clears both names. */
export function clearSessionCookies(reply: FastifyReply): FastifyReply {
  return reply.clearCookie(SESSION_COOKIE, { path: '/' }).clearCookie(LEGACY_SESSION_COOKIE, { path: '/' });
}
