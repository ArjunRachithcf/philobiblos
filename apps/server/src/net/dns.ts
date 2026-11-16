// DNS for the mail checks (ADR 0007): DKIM and ARC keys only. The resolver answers TXT queries for `<selector>._domainkey.
// <domain>` names and nothing else (no SPF, no DMARC policy fetches, no BIMI, no address lookups), with a time limit
// and a cap on lookups per mail, so a hostile mail cannot use Philobiblos to query whatever it names.
import { Resolver } from 'node:dns/promises';

const KEY_NAME = /^[a-z0-9_-]{1,63}(\.[a-z0-9_-]{1,63})*\._domainkey(\.[a-z0-9-]{1,63}){2,}$/i;

export type TxtResolver = (name: string, rr: string) => Promise<string[][]>;

export class DnsRefused extends Error {
  code = 'ENOTFOUND';
  constructor(message: string) { super(message); }
}

/** A resolver for one mail: DKIM key records only, at most `max` lookups. `base` is the real lookup (tests pass a map). */
export function dkimKeyResolver(base: TxtResolver = systemTxt(), max = 8): TxtResolver {
  let count = 0;
  return async (name, rr) => {
    if (rr !== 'TXT' || !KEY_NAME.test(name)) throw new DnsRefused(`not a DKIM key record: ${rr} ${name.slice(0, 80)}`);
    if (++count > max) throw new DnsRefused('too many DNS lookups for one mail');
    return base(name, rr);
  };
}

function systemTxt(): TxtResolver {
  const r = new Resolver({ timeout: 3000, tries: 2 });
  return (name) => r.resolveTxt(name);
}
