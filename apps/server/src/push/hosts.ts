// The push services a subscription may name (PHILOBIBLOS_PUSH_HOSTS): no imports, so config.ts can read it.
/**
 * The push services subscriptions may name (PHILOBIBLOS_PUSH_HOSTS, config.ts): a host name, or `*.` and a domain for one label
 * under it. No vendor is built in beyond this default, the browsers' services today: Chrome and Android (FCM), Firefox,
 * Safari, Edge (WNS).
 */
export const DEFAULT_PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', '*.notify.windows.com'];

export const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
/** A PHILOBIBLOS_PUSH_HOSTS entry: a host name of two labels or more (the last a name, so never an address), or `*.` and one. */
export const PUSH_HOST_ENTRY = new RegExp(`^(\\*\\.)?(${LABEL}\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`);
/**
 * A typo check, not the Public Suffix List: a wildcard needs at least three labels after `*.` (`*.notify.windows.com`),
 * so no wildcard sits on a TLD, a registry's second level (`*.co.uk`) or a hosting suffix of two labels (`*.github.io`,
 * `*.herokuapp.com`). A few public suffixes of three labels are refused too (`*.k12.ca.us`, `*.ltd.co.im`); others
 * pass, which is acceptable: every send still goes to public addresses over https only, through the push client.
 */
const THREE_LABEL_SUFFIXES = [/^(k12|lib|cc|state|tec|gen|mus|dst|cog)\.[a-z]{2}\.us$/, /^(ltd|plc)\.co\.im$/];
/** `*.` and fewer than three labels, or a known three-label public suffix. */
export const wildcardTooBroad = (entry: string): boolean => {
  if (!entry.startsWith('*.')) return false;
  const suffix = entry.slice(2);
  return suffix.split('.').length < 3 || THREE_LABEL_SUFFIXES.some((r) => r.test(suffix));
};
const matcher = (entry: string): ((host: string) => boolean) => {
  if (!entry.startsWith('*.')) return (h) => h === entry;
  const suffix = entry.slice(1);
  return (h) => h.endsWith(suffix) && new RegExp(`^${LABEL}$`).test(h.slice(0, -suffix.length));
};
export const hostAllowed = (hosts: readonly string[], host: string) => hosts.some((e) => matcher(e)(host));
