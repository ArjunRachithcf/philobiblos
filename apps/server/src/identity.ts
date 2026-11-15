// The HomersLab forwarded identity (ADR 0001, ADR 0009). The headers count only when the request comes straight from
// the configured proxy address; from anywhere else they are ignored.
import type { Config } from './config';

export const PERSON_HEADER = 'x-homerslab-person';
export const NAME_HEADER = 'x-homerslab-name';
export const ROLE_HEADER = 'x-homerslab-role';

export type Role = 'admin' | 'adult' | 'kid';
export interface Identity { externalId: string; name: string | null; role: Role | null; via: 'homerslab' }

type Headers = Record<string, string | string[] | undefined>;

function one(headers: Headers, name: string): string | null {
  const v = headers[name];
  if (Array.isArray(v)) return null; // a repeated header is refused, not merged
  const t = v?.trim();
  return t ? t : null;
}

export function resolveIdentity(cfg: Pick<Config, 'mode' | 'trustedProxy'>, remoteAddress: string | undefined, headers: Headers): Identity | null {
  if (cfg.mode !== 'homerslab' || !cfg.trustedProxy || !remoteAddress) return null;
  if (normaliseIp(remoteAddress) !== normaliseIp(cfg.trustedProxy)) return null;
  const id = one(headers, PERSON_HEADER);
  if (!id || id.length > 200) return null;
  const role = one(headers, ROLE_HEADER);
  const name = one(headers, NAME_HEADER);
  return {
    externalId: id,
    name: name ? name.slice(0, 60) : null,
    role: role === 'admin' || role === 'adult' || role === 'kid' ? role : null,
    via: 'homerslab',
  };
}

function normaliseIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
