// Is this mail really from the bookshop? (ADR 0007, contracts/connectors.md "Every mail is hostile input".) Forwarded
// mail is easy to forge, so a mail counts only when:
// - its From is exactly one address at the bookshop's domain (a Sender, if there is one, too), and
// - a DKIM signature of that domain, aligned with the From, verifies here (keys from DNS, nothing else looked up); or,
//   for a forward that broke the signature, the ARC chain verifies, its newest seal is from a provider Shelf trusts
//   (SHELF_MAIL_ARC_SEALERS), and that provider recorded dkim=pass for the bookshop's domain.
// Return-Path is not checked: a forwarding filter rewrites it to the forwarder's address (SRS), so it says nothing.
// Anything else is kept as "not verified" and changes nothing.
import { authenticate } from 'mailauth';
import { dkimKeyResolver, type TxtResolver } from '../net/dns';

export const BOOKSHOP_DOMAIN = 'orellfuessli.ch';

export interface MailAuth {
  accepted: boolean;
  /** How it passed, or why not (Shelf's own words). */
  via: 'dkim' | 'arc' | null;
  reason: string;
  fromDomain: string | null;
}

const inDomain = (d: string | null | undefined, domain: string) => !!d && (d.toLowerCase() === domain || d.toLowerCase().endsWith(`.${domain}`));

/** The domains of a header's addresses: from `a@b` or `Name <a@b>`, one per comma-separated mailbox (quoted names respected). */
export function addressDomains(value: string): string[] {
  const parts = value.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\([^)]*\)/g, '').split(',');
  return parts.map((p) => /<\s*[^<>@\s]+@([^<>\s]+?)\s*>|^\s*[^<>@\s]+@([^<>\s]+)\s*$/.exec(p)).filter(Boolean).map((m) => (m![1] ?? m![2])!.toLowerCase());
}

/** The values of a header in the message's top header block (raw, unfolded). */
export function headerValues(raw: Buffer, name: string): string[] {
  const ends = [raw.indexOf('\r\n\r\n'), raw.indexOf('\n\n')].filter((i) => i >= 0);
  const head = raw.subarray(0, Math.min(ends.length ? Math.min(...ends) : raw.length, 256 * 1024)).toString('latin1').replace(/\r?\n[ \t]+/g, ' ');
  return head.split(/\r?\n/).filter((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`)).map((l) => l.slice(name.length + 1).trim());
}

export async function verifyBookshopMail(raw: Buffer, o: { arcSealers: string[]; resolver?: TxtResolver; domain?: string }): Promise<MailAuth> {
  const domain = o.domain ?? BOOKSHOP_DOMAIN;
  // Header values are bounded before they are parsed (a 256 KB From would only be an attack).
  const from = headerValues(raw, 'From').filter((v) => v.length <= 1000);
  if (headerValues(raw, 'From').length !== from.length || headerValues(raw, 'Sender').some((v) => v.length > 1000)) return { accepted: false, via: null, reason: 'a header is too long', fromDomain: null };
  const fromDomains = from.length === 1 ? addressDomains(from[0]!) : [];
  const fromDomain = fromDomains.length === 1 ? fromDomains[0]! : null;
  const no = (reason: string): MailAuth => ({ accepted: false, via: null, reason, fromDomain });
  if (!fromDomain) return no('the From is not exactly one address');
  if (!inDomain(fromDomain, domain)) return no('not from the bookshop');
  const sender = headerValues(raw, 'Sender');
  if (sender.length > 1 || (sender.length === 1 && !addressDomains(sender[0]!).every((d) => inDomain(d, domain)))) return no('its Sender is not the bookshop');

  let res;
  try {
    res = await authenticate(raw, {
      resolver: dkimKeyResolver(o.resolver) as unknown as (name: string, rr: string) => Promise<never>,
      disableDmarc: true, disableBimi: true, ip: '192.0.2.1', helo: 'shelf.invalid', sender: '', mta: 'shelf.invalid', minBitLength: 1024,
    });
  } catch {
    return no('its signatures could not be read');
  }
  const dkim = (res.dkim?.results ?? []).find((r) => r.status?.result === 'pass' && inDomain(r.signingDomain, domain) && inDomain(r.status?.aligned || '', domain));
  if (dkim) return { accepted: true, via: 'dkim', reason: `dkim=pass for ${dkim.signingDomain}`, fromDomain };

  const arc = res.arc as { status?: { result?: string }; signature?: { signingDomain?: string }; authenticationResults?: { dkim?: { result?: string; header?: { i?: string; d?: string } }[] } } | undefined;
  if (arc?.status?.result === 'pass') {
    const sealer = arc.signature?.signingDomain?.toLowerCase() ?? '';
    if (!o.arcSealers.some((s) => inDomain(sealer, s))) return no(`the forward was sealed by ${sealer.slice(0, 80)}, not a provider Shelf trusts`);
    const ok = (arc.authenticationResults?.dkim ?? []).some((d) => d.result === 'pass' && inDomain((d.header?.d ?? d.header?.i?.replace(/^.*@/, '')) ?? '', domain));
    if (ok) return { accepted: true, via: 'arc', reason: `arc=pass by ${sealer}, which saw dkim=pass for ${domain}`, fromDomain };
    return no(`the forward's seal by ${sealer} does not show the bookshop's DKIM passing`);
  }
  return no('no valid signature of the bookshop');
}
