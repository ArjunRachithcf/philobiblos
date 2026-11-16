// The order mail (ADR 0007): Shelf never sends mail. Compose is a mailto: link with the request filled in, opened in
// the person's own mail app. The text asks for a quote and never holds a card number: the person gives payment details
// themselves. Pure: no database, no clock.

/** One address, nothing that could add headers or recipients to a mailto: (no ?, &, %, comma, spaces or line breaks). */
export const EMAIL = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;
/** Conservative: some mail apps and Windows cut a mailto: link around 2,000 characters. */
export const MAILTO_MAX = 1800;

export interface OrderLineText { title: string; authors: string[]; isbn13?: string | null }

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

export function orderText(o: { month: string; lines: OrderLineText[]; deliveryAddress: string | null; signedBy: string }) {
  const subject = `Book order, ${monthName(o.month)}`;
  const list = o.lines.map((l, i) => `${i + 1}. ${l.title}${l.authors.length ? `, ${l.authors.join(', ')}` : ''}${l.isbn13 ? ` (ISBN ${l.isbn13})` : ''}`);
  const body = [
    'Hello,', '',
    `I would like to order ${o.lines.length === 1 ? 'this book' : `these ${o.lines.length} books`}:`, '',
    ...list, '',
    ...(o.deliveryAddress ? ['Please send them to:', ...o.deliveryAddress.split(/\r?\n/).map((x) => x.trim()).filter(Boolean), ''] : []),
    'Could you reply with the prices and delivery times before sending anything? I will give the payment details myself.', '',
    'Thank you,', o.signedBy,
  ].join('\n');
  return { subject, body };
}

/**
 * The Compose link. When the whole text would make the link too long, the link carries the greeting and a line asking
 * the person to paste the list, which the screen shows in full with a Copy button (`complete: false`).
 */
export function mailto(to: string, subject: string, body: string): { url: string; complete: boolean } {
  if (!EMAIL.test(to)) throw new Error('not an address');
  const enc = (s: string) => encodeURIComponent(s.replace(/\r?\n/g, '\r\n'));
  const url = (b: string) => `mailto:${to}?subject=${enc(subject)}&body=${enc(b)}`;
  const full = url(body);
  if (full.length <= MAILTO_MAX) return { url: full, complete: true };
  return { url: url('Hello,\n\n(Paste the order from Shelf here: it is too long for this link.)\n'), complete: false };
}
