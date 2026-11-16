// Is this mail really from the bookshop? (ADR 0007, contracts/connectors.md "Every mail is hostile input".) Forwarded
// mail is easy to forge, so a mail counts only when:
// - its From is exactly one address at the bookshop's domain (a Sender, if there is one, too), and
// - a DKIM signature of that domain, aligned with the From, verifies here (keys from DNS, nothing else looked up); or,
//   for a forward that broke the signature, the ARC chain verifies, its newest seal is from a provider Shelf trusts
//   (SHELF_MAIL_ARC_SEALERS), and that provider recorded dkim=pass for the bookshop's domain.
// Return-Path is not checked: a forwarding filter rewrites it to the forwarder's address (SRS), so it says nothing.
// And whatever Shelf later reads from the headers must be what was signed: a header that may appear once appears
// once, the passing signature covers the ones Shelf reads (From, To, Subject, Date, Message-ID, the MIME headers, and
// In-Reply-To/References/Cc/Sender/Reply-To when present), covers no fewer instances than the mail has, and covers
// the whole body (no l=). The mail must be addressed to the household (SHELF_MAIL_RECIPIENTS or the mailbox itself),
// so a genuine bookshop mail to someone else cannot be replayed into Shelf.
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

/** The header fields of the message's top block, unfolded, in order: name (lowercase) and value. Bounded. */
export function headers(raw: Buffer): { name: string; value: string }[] {
  const ends = [raw.indexOf('\r\n\r\n'), raw.indexOf('\n\n')].filter((i) => i >= 0);
  const head = raw.subarray(0, Math.min(ends.length ? Math.min(...ends) : raw.length, 256 * 1024)).toString('latin1').replace(/\r?\n[ \t]+/g, ' ');
  return head.split(/\r?\n/).flatMap((l) => {
    const c = l.indexOf(':');
    return c > 0 ? [{ name: l.slice(0, c).trim().toLowerCase(), value: l.slice(c + 1).trim() }] : [];
  });
}

/** The addresses of a header (lowercase): `a@b` or `Name <a@b>`, one per comma-separated mailbox (quoted names and comments never count). */
export function addresses(value: string): string[] {
  const parts = value.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\([^)]*\)/g, '').split(',');
  return parts.map((p) => /<\s*([^<>@\s]+@[^<>\s]+?)\s*>|^\s*([^<>@\s]+@[^<>\s]+)\s*$/.exec(p)).filter(Boolean).map((m) => (m![1] ?? m![2])!.toLowerCase());
}
export const addressDomains = (value: string) => addresses(value).map((a) => a.slice(a.lastIndexOf('@') + 1));

/** Headers a mail has at most once (RFC 5322 section 3.6); a second one is a forgery prepended above the signed mail. */
const SINGLE = ['from', 'sender', 'reply-to', 'to', 'cc', 'subject', 'date', 'message-id', 'in-reply-to', 'references', 'mime-version', 'content-type', 'content-transfer-encoding'];
/** What Shelf reads from the headers: the passing signature must cover each (the optional ones when the mail has them). */
const COVERED = ['from', 'to', 'subject', 'date', 'message-id', 'mime-version', 'content-type'];
const COVERED_IF_PRESENT = ['cc', 'sender', 'reply-to', 'in-reply-to', 'references', 'content-transfer-encoding'];

/** Why a signature (DKIM's or ARC's message signature) does not vouch for everything Shelf reads, or null. */
export function coverageProblem(sig: { signingHeaders?: { keys?: string[] | string }; canonBodyLengthLimited?: boolean } | undefined, hs: { name: string }[]): string | null {
  if (!sig) return 'no signature';
  if (sig.canonBodyLengthLimited) return 'its signature covers only part of the body (l=)';
  const raw = sig.signingHeaders?.keys;
  const keys = (Array.isArray(raw) ? raw : String(raw ?? '').split(':')).map((k) => k.trim().toLowerCase()).filter(Boolean);
  const present = new Set(hs.map((h) => h.name));
  for (const k of [...COVERED, ...COVERED_IF_PRESENT.filter((x) => present.has(x))]) if (!keys.includes(k)) return `its signature does not cover ${k}`;
  // As many instances signed as the mail has: an extra one above the signed ones would be read but never verified.
  for (const k of new Set(keys)) if (hs.filter((h) => h.name === k).length > keys.filter((x) => x === k).length) return `more ${k} headers than were signed`;
  return null;
}

export async function verifyBookshopMail(raw: Buffer, o: { arcSealers: string[]; recipients: string[]; resolver?: TxtResolver; domain?: string }): Promise<MailAuth> {
  const domain = o.domain ?? BOOKSHOP_DOMAIN;
  const hs = headers(raw);
  const of = (n: string) => hs.filter((h) => h.name === n).map((h) => h.value);
  const no = (reason: string, fromDomain: string | null = null): MailAuth => ({ accepted: false, via: null, reason, fromDomain });
  // Header values are bounded before they are parsed (a 256 KB From would only be an attack).
  if (hs.some((h) => SINGLE.includes(h.name) && h.value.length > 2000)) return no('a header is too long');
  const twice = SINGLE.find((n) => of(n).length > 1);
  if (twice) return no(`more than one ${twice} header`);
  const fromAddrs = of('from').length === 1 ? addresses(of('from')[0]!) : [];
  const fromDomain = fromAddrs.length === 1 ? fromAddrs[0]!.slice(fromAddrs[0]!.lastIndexOf('@') + 1) : null;
  if (!fromDomain) return no('the From is not exactly one address');
  if (!inDomain(fromDomain, domain)) return no('not from the bookshop', fromDomain);
  if (of('sender').length && !addressDomains(of('sender')[0]!).every((d) => inDomain(d, domain))) return no('its Sender is not the bookshop', fromDomain);
  const to = [...of('to'), ...of('cc')].flatMap(addresses);
  const household = o.recipients.map((r) => r.toLowerCase());
  if (!household.length) return no('no household address is set up to receive the bookshop\'s mail (SHELF_MAIL_RECIPIENTS)', fromDomain);
  if (!to.some((a) => household.includes(a))) return no('not addressed to the household', fromDomain);

  let res;
  try {
    res = await authenticate(raw, {
      resolver: dkimKeyResolver(o.resolver) as unknown as (name: string, rr: string) => Promise<never>,
      disableDmarc: true, disableBimi: true, ip: '192.0.2.1', helo: 'shelf.invalid', sender: '', mta: 'shelf.invalid', minBitLength: 1024,
    });
  } catch {
    return no('its signatures could not be read', fromDomain);
  }
  let why = 'no valid signature of the bookshop';
  for (const r of res.dkim?.results ?? []) {
    if (r.status?.result !== 'pass' || !inDomain(r.signingDomain, domain) || !inDomain(r.status?.aligned || '', domain)) continue;
    const problem = coverageProblem(r as Parameters<typeof coverageProblem>[0], hs);
    if (!problem) return { accepted: true, via: 'dkim', reason: `dkim=pass for ${r.signingDomain}`, fromDomain };
    why = problem;
  }

  const arc = res.arc as { status?: { result?: string }; signature?: Parameters<typeof coverageProblem>[0] & { signingDomain?: string }; authenticationResults?: { dkim?: { result?: string; header?: { i?: string; d?: string } }[] } } | undefined;
  if (arc?.status?.result === 'pass') {
    const sealer = arc.signature?.signingDomain?.toLowerCase() ?? '';
    if (!o.arcSealers.some((s) => inDomain(sealer, s))) return no(`the forward was sealed by ${sealer.slice(0, 80)}, not a provider Shelf trusts`, fromDomain);
    const ok = (arc.authenticationResults?.dkim ?? []).some((d) => d.result === 'pass' && inDomain((d.header?.d ?? d.header?.i?.replace(/^.*@/, '')) ?? '', domain));
    if (!ok) return no(`the forward's seal by ${sealer} does not show the bookshop's DKIM passing`, fromDomain);
    const problem = coverageProblem(arc.signature, hs);
    if (problem) return no(`the forward's seal: ${problem}`, fromDomain);
    return { accepted: true, via: 'arc', reason: `arc=pass by ${sealer}, which saw dkim=pass for ${domain}`, fromDomain };
  }
  return no(why, fromDomain);
}
