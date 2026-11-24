// Domain names, shared by the mail checks (mail/verify.ts) and the connector loader (connectors/load.ts), so the loader
// needs nothing of the mail verifier's.
import { getAlignment } from 'mailauth/lib/tools.js';

/**
 * Relaxed alignment (RFC 7489 section 3.1.1): the two domains have the same organizational domain (the public suffix
 * list's, as mailauth reads it). A signing domain counts for a From only so: a connector may list `mail.shop.example`
 * as a signer of `shop.example`, never another organization's domain (a shared sending service's would let any of
 * its customers sign as the shop). The DKIM check and the ARC check use it alike, and connectors/load.ts refuses a
 * signing domain that is aligned with none of its connector's mail domains.
 */
export const relaxedAligned = (a: string, b: string) => Boolean(a && b && getAlignment(a.toLowerCase(), [b.toLowerCase()]));
