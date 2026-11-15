// Who is asking (ADR 0001, ADR 0009). In homerslab mode the forwarded header counts only when the request comes
// straight from the configured proxy address; otherwise it is ignored. Standalone sign-in (passkeys) arrives in M1.
import type { Config } from './config';

export const PERSON_HEADER = 'x-homerslab-person';

export interface Identity { externalId: string; via: 'homerslab' }

export function resolveIdentity(cfg: Pick<Config, 'mode' | 'trustedProxy'>, remoteAddress: string | undefined, headers: Record<string, string | string[] | undefined>): Identity | null {
  if (cfg.mode !== 'homerslab' || !cfg.trustedProxy || !remoteAddress) return null;
  if (normaliseIp(remoteAddress) !== normaliseIp(cfg.trustedProxy)) return null;
  const v = headers[PERSON_HEADER];
  const id = Array.isArray(v) ? undefined : v?.trim(); // a repeated header is refused, not merged
  return id ? { externalId: id, via: 'homerslab' } : null;
}

function normaliseIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
