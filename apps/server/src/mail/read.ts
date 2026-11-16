// What Shelf keeps of a verified bookshop mail (ADR 0007): never its text. A mail's free text always carries something
// of the household's (the delivery address, a name, a card number typed into a request the bookshop quotes back), in
// more spellings than any filter can find (Zürich and Zurich, Str. and strasse, soft hyphens, split PDF cells, unusual
// separators), so the store holds structured fields only. This slice keeps the headers that tie a mail to an order
// (Message-ID, In-Reply-To, the date), its subject through `safeField`, how many PDFs it has, and where it is in the
// mailbox (UIDVALIDITY and UID). The parsers of M3 (d) read the mail again from the mailbox (which Shelf never
// changes), in memory, and keep only what they extract: order number, date, line items, totals and status, each
// string field through `safeField` as a second line of defence.
//
// The MIME structure is still parsed here, within limits (depth, parts, header size; no nested message parsed), so
// a mail that cannot be read safely is known now; and what the parser took for its headers must be what was signed.
import PostalMime from 'postal-mime';
import { textOf } from '../books/prices';
import type { TxtResolver } from '../net/dns';
import { headerBlock, verifyBookshopMail, type MailAuth } from './verify';

export const MAIL_LIMITS = {
  /** A whole message, bytes. */
  message: 25 * 1024 * 1024,
  depth: 8,
  parts: 64,
  headers: 256 * 1024,
} as const;

export interface MailContent {
  subject: string | null;
  date: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  /** PDFs among the attachments, by their bytes. */
  pdfs: number;
}

export class MailUnreadable extends Error {
  constructor(readonly code: string) { super(`the mail cannot be read: ${code}`); }
}

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC').replace(/\p{Cf}/gu, '');
/** A string as compared: NFKC, without format characters (soft hyphens, zero-width spaces), diacritics folded (and
 * their transliterations: ue, oe, ae), lowercase, street/Str./strasse (also as a word's ending: Bahnhofstr.) as one
 * word, every other non-letter-or-digit run as one space. */
export const normal = (s: string) => fold(s).toLowerCase().replace(/ß/g, 'ss').replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u')
  .replace(/(\p{L}{2})str\b\.?/gu, '$1strasse').replace(/\b(?:street|str|strasse)\b\.?/g, ' strasse ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** Words of an address too common to drop a field for on their own. */
const COMMON = new Set(['strasse', 'street', 'road', 'avenue', 'platz', 'gasse', 'schweiz', 'switzerland', 'suisse', 'svizzera']);

/**
 * The pieces of the household's delivery address worth finding again: its lines and comma parts of 5+ letters or
 * digits, and each word of 5+ letters on its own (a surname alone, or the name reversed), common street words aside.
 */
export function addressParts(address: string | null): string[] {
  if (!address) return [];
  const parts = address.split(/[\n,;]+/).map(normal);
  const words = parts.flatMap((p) => p.split(' ')).filter((w) => /^\p{L}{5,}$/u.test(w) && !COMMON.has(w));
  return [...new Set([...parts.filter((p) => p.replace(/ /g, '').length >= 5), ...words])];
}

const ISBN13 = /^97[89]\d{10}$/;
/**
 * A string field fit to keep, or null: dropped when it holds a piece of the delivery address, or a run of 12 or more
 * digits (whatever separates them: up to three characters that are neither letters nor digits) other than one
 * ISBN/EAN as the whole field. Applied after NFKC and with format characters stripped, so look-alike digits and
 * invisible separators count too. Bounded to 300 characters.
 */
export function safeField(v: unknown, address: string[]): string | null {
  if (typeof v !== 'string') return null;
  // Kept as written (NFKC, format characters gone: Bücher stays Bücher); checked with its diacritics folded.
  const out = v.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300);
  const s = fold(out);
  if (!s) return null;
  const n = normal(s);
  if (address.some((p) => ` ${n} `.includes(` ${p} `) || n.replace(/ /g, '').includes(p.replace(/ /g, '')))) return null;
  if (ISBN13.test(s.replace(/[^\d]/g, '')) && /^[\d\s-]+$/.test(s)) return out;
  for (const run of s.match(/\d(?:[^\p{L}\p{N}\n]{0,3}\d)*/gu) ?? []) if (run.replace(/\D/g, '').length >= 12) return null;
  return out;
}

const isPdf = (b: Uint8Array) => b.length > 5 && Buffer.from(b.subarray(0, 5)).toString('latin1') === '%PDF-';
const opts = { attachmentEncoding: 'arraybuffer' as const, maxNestingDepth: MAIL_LIMITS.depth, maxPartCount: MAIL_LIMITS.parts, maxHeadersSize: MAIL_LIMITS.headers, maxRfc822NestingDepth: 0, forceRfc822Attachments: true };

/** The mail's text as the parsers see it: at most this many characters (more: the parsers refuse the mail). */
export const TEXT_MAX = 1024 * 1024;

/** What a mail's parts hold, in memory only: never stored (ADR 0007). */
export interface MailRead {
  content: MailContent;
  /** The plain text (or the HTML's words, a line per block), '' when longer than TEXT_MAX. */
  text: string;
  tooLong: boolean;
  /** The PDF attachments, by their bytes (for the media worker). */
  pdfs: Uint8Array[];
  /** In-Reply-To as signed, unfiltered (it is compared with the order's thread, never shown or kept). */
  threadRef: string | null;
  /** The Subject as signed, unfiltered: only to tell the kind of mail (a 12-digit order number would drop the kept one). */
  signedSubject: string | null;
}

/**
 * HTML's words, a line per block element (br, and the ends of p, div, tr, li, headings, table), through the linear
 * `textOf` (#10). One pass with indexOf, each search starting where the last one ended: an unclosed tag ends the text
 * there, as in textOf, so `<br ` a million times costs one scan, never one per position.
 */
export function htmlLines(html: string): string {
  const chunks: string[] = [];
  let start = 0, i = 0;
  for (;;) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) break;
    if (/^<(?:br|\/(?:p|div|tr|li|h[1-6]|table))(?![a-z0-9])/i.test(html.slice(lt, lt + 9))) { chunks.push(html.slice(start, lt)); start = gt + 1; }
    i = gt + 1;
  }
  chunks.push(html.slice(start));
  return chunks.map(textOf).join('\n');
}

/**
 * Parses the mail within limits and keeps its few fields. `headerBlock` is the verified header block (verify.ts): the
 * fields the MIME parser read from the whole mail must equal those it reads from that block alone, so nothing the
 * parser took for a header can come from anywhere else. Call it through `openVerified`, which does every check.
 */
export async function readMail(raw: Buffer, headerBlock: Buffer, address: string[] = []): Promise<MailRead> {
  if (raw.length > MAIL_LIMITS.message) throw new MailUnreadable('too_large');
  let mail, signed;
  try {
    mail = await PostalMime.parse(raw, opts);
    signed = await PostalMime.parse(Buffer.concat([headerBlock, Buffer.from('\r\n\r\n')]), opts);
  } catch (e) {
    throw new MailUnreadable(String((e as { code?: string }).code ?? 'malformed').slice(0, 40));
  }
  const same = (k: 'subject' | 'messageId' | 'date' | 'inReplyTo') => (mail[k] ?? null) === (signed[k] ?? null);
  if (!same('subject') || !same('messageId') || !same('date') || !same('inReplyTo') || JSON.stringify(mail.from ?? null) !== JSON.stringify(signed.from ?? null)) {
    throw new MailUnreadable('headers_differ');
  }
  const one = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null);
  const pdfs = (mail.attachments ?? []).map((a) => new Uint8Array(a.content as ArrayBuffer)).filter(isPdf);
  const text = typeof mail.text === 'string' && mail.text.trim() ? mail.text : typeof mail.html === 'string' ? htmlLines(mail.html.slice(0, 4 * TEXT_MAX)) : '';
  return {
    // Every field kept passes safeField, the generated ids too (shelf#13).
    content: {
      subject: safeField(mail.subject, address),
      date: one(mail.date, 64), messageId: safeField(one(mail.messageId, 300), address), inReplyTo: safeField(one(mail.inReplyTo, 300), address),
      pdfs: pdfs.length,
    },
    text: text.length > TEXT_MAX ? '' : text, tooLong: text.length > TEXT_MAX, pdfs, threadRef: one(mail.inReplyTo, 300), signedSubject: one(mail.subject, 300),
  };
}

/** A bookshop mail that passed every check, as only `openVerified` makes it. */
export interface VerifiedMail extends MailRead {
  auth: MailAuth & { accepted: true; from: string };
}
const VERIFIED = new WeakSet<object>();
/** Whether this object came from `openVerified` (effects apply to nothing else). */
export const isVerified = (m: unknown): m is VerifiedMail => typeof m === 'object' && m !== null && VERIFIED.has(m);

export type Opened = { ok: true; mail: VerifiedMail } | { ok: false; auth: MailAuth; unreadable?: string };

/**
 * The one way Shelf reads a mail, the first time and every time again (the parsers re-read it from the mailbox):
 * the strict header block, who sent it (verify.ts: sender, recipients, DKIM or ARC and what they cover), then the
 * MIME parse within limits, whose headers must equal the verified block's. Only a mail through all of them is a
 * `VerifiedMail`.
 */
export async function openVerified(raw: Buffer, o: { arcSealers: string[]; recipients: string[]; resolver?: TxtResolver; address: string[] }): Promise<Opened> {
  const hb = headerBlock(raw);
  if (!('block' in hb)) return { ok: false, auth: { accepted: false, via: null, reason: hb.problem, fromDomain: null } };
  const auth = await verifyBookshopMail(raw, { arcSealers: o.arcSealers, recipients: o.recipients, resolver: o.resolver });
  if (!auth.accepted || !auth.from) return { ok: false, auth };
  let read;
  try { read = await readMail(raw, hb.block, o.address); } catch (e) {
    if (!(e instanceof MailUnreadable)) throw e;
    return { ok: false, auth, unreadable: e.message };
  }
  const mail = Object.freeze({ ...read, auth: auth as VerifiedMail['auth'] });
  VERIFIED.add(mail);
  return { ok: true, mail };
}
