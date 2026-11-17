// A CSV file as the page reads it (philobiblos#27 slice 4), before anything is sent: UTF-8 or nothing. `File.text()` would
// decode another encoding (Excel's "CSV (semicolon)" on Windows writes Windows-1252) into U+FFFD characters, whose words
// match no book and would add broken ones; the server refuses U+FFFD too. Its length is the server's limit, in characters.

/** The server's limit (orders/csv.ts CSV_LIMITS.chars). */
export const CSV_MAX = 64 * 1024;
/** Refused whole, never cut: a CSV cut short would still read, wrongly. */
export const TOO_LONG = 'That CSV is longer than 64 KB, which Philobiblos reads at most: split it, or leave out the columns it does not need.';
export const NOT_UTF8 = 'That file is not UTF-8, so its accented letters cannot be read: save it again as “CSV UTF-8” and choose it again.';

/** The file's text, or why it is refused. */
export function decodeCsv(bytes: Uint8Array): { text: string } | { error: string } {
  // A UTF-8 character is at most 4 bytes: past that, it is too long whatever it holds.
  if (bytes.length > CSV_MAX * 4) return { error: TOO_LONG };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return { error: NOT_UTF8 }; }
  return text.length > CSV_MAX ? { error: TOO_LONG } : { text };
}
