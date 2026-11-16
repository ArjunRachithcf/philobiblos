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
/** A string as compared: NFKC, without format characters (soft hyphens, zero-width spaces), diacritics folded,
 * lowercase, street/Str./strasse as one word, every other non-letter-or-digit run as one space. */
export const normal = (s: string) => fold(s).toLowerCase().replace(/ß/g, 'ss').replace(/\b(?:street|str|strasse)\b\.?/g, ' strasse ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** The pieces of the household's delivery address worth finding again (lines and comma parts of 5+ letters or digits). */
export function addressParts(address: string | null): string[] {
  if (!address) return [];
  return [...new Set(address.split(/[\n,;]+/).map(normal).filter((p) => p.replace(/ /g, '').length >= 5))];
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
  const s = fold(v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300);
  if (!s) return null;
  const n = normal(s);
  if (address.some((p) => ` ${n} `.includes(` ${p} `) || n.replace(/ /g, '').includes(p.replace(/ /g, '')))) return null;
  if (ISBN13.test(s.replace(/[^\d]/g, '')) && /^[\d\s-]+$/.test(s)) return s;
  for (const run of s.match(/\d(?:[^\p{L}\p{N}\n]{0,3}\d)*/gu) ?? []) if (run.replace(/\D/g, '').length >= 12) return null;
  return s;
}

const isPdf = (b: Uint8Array) => b.length > 5 && Buffer.from(b.subarray(0, 5)).toString('latin1') === '%PDF-';
const opts = { attachmentEncoding: 'arraybuffer' as const, maxNestingDepth: MAIL_LIMITS.depth, maxPartCount: MAIL_LIMITS.parts, maxHeadersSize: MAIL_LIMITS.headers, maxRfc822NestingDepth: 0, forceRfc822Attachments: true };

/**
 * Parses the mail within limits and keeps its few fields. `headerBlock` is the verified header block (verify.ts): the
 * fields the MIME parser read from the whole mail must equal those it reads from that block alone, so nothing the
 * parser took for a header can come from anywhere else.
 */
export async function readMail(raw: Buffer, headerBlock: Buffer, address: string[] = []): Promise<MailContent> {
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
  return {
    subject: safeField(mail.subject, address),
    date: one(mail.date, 64), messageId: one(mail.messageId, 300), inReplyTo: one(mail.inReplyTo, 300),
    pdfs: (mail.attachments ?? []).filter((a) => isPdf(new Uint8Array(a.content as ArrayBuffer))).length,
  };
}
