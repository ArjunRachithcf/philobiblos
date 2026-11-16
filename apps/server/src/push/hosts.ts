// The push services a subscription may name (SHELF_PUSH_HOSTS): no imports, so config.ts can read it.
/**
 * The push services subscriptions may name (SHELF_PUSH_HOSTS, config.ts): a host name, or `*.` and a domain for one label
 * under it. No vendor is built in beyond this default, the browsers' services today: Chrome and Android (FCM), Firefox,
 * Safari, Edge (WNS).
 */
export const DEFAULT_PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', '*.notify.windows.com'];

export const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
/** A SHELF_PUSH_HOSTS entry: a host name of two labels or more (the last a name, so never an address), or `*.` and one. */
export const PUSH_HOST_ENTRY = new RegExp(`^(\\*\\.)?(${LABEL}\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`);
const matcher = (entry: string): ((host: string) => boolean) => {
  if (!entry.startsWith('*.')) return (h) => h === entry;
  const suffix = entry.slice(1);
  return (h) => h.endsWith(suffix) && new RegExp(`^${LABEL}$`).test(h.slice(0, -suffix.length));
};
export const hostAllowed = (hosts: readonly string[], host: string) => hosts.some((e) => matcher(e)(host));
