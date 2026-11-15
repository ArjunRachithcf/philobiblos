// Standalone sessions (ADR 0010): the cookie holds 256 random bits, the database their SHA-256. A session ends 30 days
// after sign-in, after 7 days without use, at sign-out (or "sign out everywhere"), when the passkey that signed it in
// is removed, or when the person is removed or becomes a kid.
import { eq, lt, or } from 'drizzle-orm';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import { hashToken, looksLikeToken, newToken } from './tokens';

export const SESSION_COOKIE = 'shelf_session';
export const SESSION_DAYS = 30;
export const IDLE_DAYS = 7;
const DAY = 86_400_000;

/** A sign-in younger than this may make invites (a stolen, older session cannot add a passkey). */
export const FRESH_MINUTES = 10;

export function createSession(db: Db, personId: string, passkeyId: string | null = null, now = new Date()): { token: string; expiresAt: Date } {
  const token = newToken();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * DAY);
  db.insert(t.session).values({ id: hashToken(token), personId, passkeyId, createdAt: now.toISOString(), lastSeenAt: now.toISOString(), expiresAt: expiresAt.toISOString() }).run();
  return { token, expiresAt };
}

export type Session = typeof t.session.$inferSelect;

export const isFresh = (s: Pick<Session, 'createdAt'>, now = new Date()) => now.getTime() - new Date(s.createdAt).getTime() <= FRESH_MINUTES * 60_000;

/** The person a cookie belongs to, if the session is still alive; refreshes its last use at most once a minute. */
export function sessionPerson(db: Db, token: string | undefined, now = new Date()): string | null {
  return liveSession(db, token, now)?.personId ?? null;
}

export function liveSession(db: Db, token: string | undefined, now = new Date()): Session | null {
  if (!looksLikeToken(token)) return null;
  const id = hashToken(token);
  const s = db.select().from(t.session).where(eq(t.session.id, id)).get();
  if (!s) return null;
  if (new Date(s.expiresAt) <= now || now.getTime() - new Date(s.lastSeenAt).getTime() > IDLE_DAYS * DAY) {
    db.delete(t.session).where(eq(t.session.id, id)).run();
    return null;
  }
  if (now.getTime() - new Date(s.lastSeenAt).getTime() > 60_000) {
    db.update(t.session).set({ lastSeenAt: now.toISOString() }).where(eq(t.session.id, id)).run();
  }
  return s;
}

export function endAllSessions(db: Db, personId: string): void {
  db.delete(t.session).where(eq(t.session.personId, personId)).run();
}

export function endSession(db: Db, token: string | undefined): void {
  if (looksLikeToken(token)) db.delete(t.session).where(eq(t.session.id, hashToken(token))).run();
}

export function pruneSessions(db: Db, now = new Date()): void {
  const idle = new Date(now.getTime() - IDLE_DAYS * DAY).toISOString();
  db.delete(t.session).where(or(lt(t.session.expiresAt, now.toISOString()), lt(t.session.lastSeenAt, idle))).run();
}

export const cookieOptions = (maxAgeSeconds: number) => ({
  httpOnly: true, secure: true, sameSite: 'strict' as const, path: '/', maxAge: maxAgeSeconds,
});
