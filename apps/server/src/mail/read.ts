// A mail's content as Shelf keeps it (ADR 0007): hostile input, read as text within limits. MIME is parsed with
// limits on depth, parts and header size; HTML is never rendered or kept (a plain-text part, or the HTML's text with
// every tag dropped); links are never followed or kept as links; images and other attachments are not read. Only PDFs
// (by their bytes, at most 10 MB) are handed to the media worker for their text; the server never opens one.
//
// What is kept leaves out what the household wrote to the bookshop: quoted lines (`>`) and everything below a reply
// header are dropped (the person's request, with the delivery address and the card number they typed, is quoted in
// the bookshop's replies); any line or PDF cell that holds a piece of the delivery address (sealed, PR #7: unsealed
// only here, to find it) is replaced; and any run of 12 or more digits that is not an ISBN/EAN is masked as well.
import PostalMime from 'postal-mime';
import { textOf } from '../books/prices';
import type { MediaOutcome } from '../media/client';

export const MAIL_LIMITS = {
  /** A whole message, bytes (its text and its PDFs). */
  message: 25 * 1024 * 1024,
  /** The text kept, characters. */
  text: 1_000_000,
  pdf: 10 * 1024 * 1024,
  pdfs: 5,
  depth: 8,
  parts: 64,
  headers: 256 * 1024,
} as const;

export interface MailContent {
  subject: string;
  date: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  text: string;
  pdfs: { name: string; pages: number; rows: string[][]; truncated: boolean }[];
  /** PDFs that were too large, unreadable, or refused by the media worker. */
  skipped: number;
}

export class MailUnreadable extends Error {
  constructor(readonly code: string) { super(`the mail cannot be read: ${code}`); }
}

// Where the household's own words begin in a reply: German, English, French and Italian clients, Outlook's line.
const REPLY_HEADER = /^(?:_{10,}$|-{2,}\s*(?:Original(?:nachricht| Message)|Ursprüngliche Nachricht|Message d'origine|Messaggio originale)\s*-{2,}|(?:From|Von|De|Da|Sent|Gesendet|Envoyé|Inviato)\s?:\s|On .{3,200} wrote:|Am .{3,200} schrieb .{1,200}:|Le .{3,200} a écrit\s?:|Il .{3,200} ha scritto\s?:)/i;
const SPACES = /[\u00a0\u2007\u202f\u2009\u200a\u2002-\u2006\u3000]/g;
const ISBN = /\b97[89](?:[ -]?\d){10}\b/g;
const DIGITS = /\d(?:[\s\-./]{0,2}\d){11,}/g;

/** Masks every run of 12 or more digits (with up to two separators of space, -, . or / between them) but ISBNs. */
export function maskNumbers(text: string): string {
  const isbns: string[] = [];
  const held = text.replace(SPACES, ' ').replace(ISBN, (m) => `\ue000${isbns.push(m) - 1}\ue000`);
  return held.replace(DIGITS, '[number removed]').replace(/\ue000(\d+)\ue000/g, (_m, n: string) => isbns[Number(n)]!);
}

/** The pieces of the household's delivery address worth finding again (lines and comma parts of 5+ letters), normalised. */
export function addressParts(address: string | null): string[] {
  if (!address) return [];
  return [...new Set(address.split(/[\n,;]+/).map(normal).filter((p) => p.replace(/[^a-z0-9]/g, '').length >= 5))];
}
const normal = (s: string) => s.replace(SPACES, ' ').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const mentions = (line: string, parts: string[]) => { const l = normal(line); return parts.some((p) => l.includes(p)); };

/**
 * The bookshop's own words: no quoted lines, nothing below a reply header, no line that holds a piece of the
 * household's delivery address, long digit runs masked unless ISBN/EAN.
 */
export function keepText(text: string, address: string[] = []): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (REPLY_HEADER.test(line.replace(SPACES, ' ').trim())) break;
    if (/^\s*>/.test(line)) continue;
    if (mentions(line, address)) { out.push('[address removed]'); continue; }
    out.push(maskNumbers(line));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAIL_LIMITS.text);
}

/** A PDF's rows with the same care: a cell that holds a piece of the address, or a long number, is masked. */
export function keepRows(rows: string[][], address: string[]): string[][] {
  return rows.map((r) => r.map((c) => (mentions(c, address) ? '[address removed]' : maskNumbers(c))));
}

/** HTML as text, line by line: no tag, script, style, link or image survives (only the words between them). Linear. */
export const htmlText = (html: string) => textOf(html.slice(0, 4 * 1024 * 1024), { lines: true });

const isPdf = (b: Uint8Array) => b.length > 5 && Buffer.from(b.subarray(0, 5)).toString('latin1') === '%PDF-';

export async function readMail(raw: Buffer, media: (kind: 'pdf.text', input: Uint8Array) => Promise<MediaOutcome>, address: string[] = []): Promise<MailContent> {
  if (raw.length > MAIL_LIMITS.message) throw new MailUnreadable('too_large');
  let mail;
  try {
    mail = await PostalMime.parse(raw, {
      attachmentEncoding: 'arraybuffer', maxNestingDepth: MAIL_LIMITS.depth, maxPartCount: MAIL_LIMITS.parts,
      maxHeadersSize: MAIL_LIMITS.headers, maxRfc822NestingDepth: 0, forceRfc822Attachments: true,
    });
  } catch (e) {
    throw new MailUnreadable(String((e as { code?: string }).code ?? 'malformed').slice(0, 40));
  }
  const text = keepText(mail.text ?? htmlText(mail.html ?? ''), address);
  const pdfs: MailContent['pdfs'] = [];
  let skipped = 0;
  for (const a of mail.attachments ?? []) {
    const bytes = new Uint8Array(a.content as ArrayBuffer);
    // Only PDFs, by their bytes (the name and the declared type count for nothing); every other attachment is unread.
    if (!isPdf(bytes)) continue;
    if (bytes.length > MAIL_LIMITS.pdf || pdfs.length >= MAIL_LIMITS.pdfs) { skipped++; continue; }
    const r = await media('pdf.text', bytes);
    if (r.ok && r.kind === 'pdf.text') pdfs.push({ name: String(a.filename ?? 'attachment.pdf').replace(/[^\w .-]/g, '_').slice(0, 100), pages: r.pages, rows: keepRows(r.rows, address), truncated: r.truncated });
    else skipped++;
  }
  const one = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null);
  return {
    subject: (mail.subject ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 300),
    date: one(mail.date, 64), messageId: one(mail.messageId, 300), inReplyTo: one(mail.inReplyTo, 300),
    text, pdfs, skipped,
  };
}
