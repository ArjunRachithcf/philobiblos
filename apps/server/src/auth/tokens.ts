import { createHash, randomBytes } from 'node:crypto';

/** 256 random bits, URL-safe. */
export const newToken = () => randomBytes(32).toString('base64url');
/** What the database keeps of a token (share tokens, sessions, invites). */
export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
/** A token as it may arrive: base64url, 43 characters for ours; anything else is refused before it is hashed. */
export const looksLikeToken = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
