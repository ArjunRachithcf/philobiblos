// The order mail (ADR 0007): Philobiblos never sends mail. Compose is a mailto: link with the request filled in, opened in
// the person's own mail app. The text asks for a quote and never holds a card number: the person gives payment details
// themselves. Its words are data (locales/, household/locale.ts letterFor): the shop connector's language, else the
// household's, else English. Pure: no database, no clock.
import { LETTERS, fill, type Letter } from '../household/locale';

/** One address, nothing that could add headers or recipients to a mailto: (no ?, &, %, comma, spaces or line breaks). */
export const EMAIL = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;
/** Conservative: some mail apps and Windows cut a mailto: link around 2,000 characters. */
export const MAILTO_MAX = 1800;

export interface OrderLineText { title: string; authors: string[]; isbn13?: string | null }

/** English month names: the app's own screens write dates in English (inbox.ts). */
export const MONTHS = LETTERS.en!.months;
export const monthName = (month: string, letter: Letter = LETTERS.en!) => `${letter.months[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/** The letter's subject for a month, in its language: what a reply's subject is matched with (mail/effects.ts). */
export const orderSubject = (month: string, letter: Letter = LETTERS.en!) =>
  fill(letter.subject, { month: letter.months[Number(month.slice(5, 7)) - 1]!, year: month.slice(0, 4) });

export function orderText(o: { month: string; lines: OrderLineText[]; deliveryAddress: string | null; signedBy: string }, letter: Letter = LETTERS.en!) {
  const subject = orderSubject(o.month, letter);
  const list = o.lines.map((l, i) => `${i + 1}. ${l.title}${l.authors.length ? `, ${l.authors.join(', ')}` : ''}${l.isbn13 ? ` (${fill(letter.isbn, { isbn: l.isbn13 })})` : ''}`);
  const body = [
    letter.greeting, '',
    o.lines.length === 1 ? letter.one : fill(letter.many, { count: o.lines.length }), '',
    ...list, '',
    ...(o.deliveryAddress ? [letter.sendTo, ...o.deliveryAddress.split(/\r?\n/).map((x) => x.trim()).filter(Boolean), ''] : []),
    letter.quote, '',
    letter.thanks, ...(o.signedBy ? [o.signedBy] : []),
  ].join('\n');
  return { subject, body };
}

/**
 * The Compose link. When the whole text would make the link too long, the link carries the greeting and a line asking
 * the person to paste the list, which the screen shows in full with a Copy button (`complete: false`). `to: null` is the
 * plain list's (no-shop mode): a link to no one, the person picks the recipient in their own mail app.
 */
export function mailto(to: string | null, subject: string, body: string, letter: Letter = LETTERS.en!): { url: string; complete: boolean } {
  if (to !== null && !EMAIL.test(to)) throw new Error('not an address');
  const enc = (s: string) => encodeURIComponent(s.replace(/\r?\n/g, '\r\n'));
  const url = (b: string) => `mailto:${to ?? ''}?subject=${enc(subject)}&body=${enc(b)}`;
  const full = url(body);
  if (full.length <= MAILTO_MAX) return { url: full, complete: true };
  return { url: url(`${letter.greeting}\n\n${letter.tooLong}\n`), complete: false };
}
