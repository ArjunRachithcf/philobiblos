// A CSV file as the page reads it (philobiblos#27 slice 4): UTF-8 or nothing. A file saved in another encoding (Excel's
// "CSV (semicolon)" on Windows writes Windows-1252) is refused with a message, never decoded into U+FFFD characters.
import { describe, expect, it } from 'vitest';
import { CSV_MAX, NOT_UTF8, TOO_LONG, decodeCsv } from '../src/csvfile';

describe('decodeCsv', () => {
  it('UTF-8 is read as it is, a byte order mark kept for the server to drop', () => {
    expect(decodeCsv(new TextEncoder().encode('﻿title\nDie Brücke\n'))).toEqual({ text: '﻿title\nDie Brücke\n' });
  });
  it('Windows-1252 (ü as the one byte 0xFC) is refused, with how to save it', () => {
    const bytes = Uint8Array.from([...new TextEncoder().encode('title\nDie Br'), 0xfc, ...new TextEncoder().encode('cke\n')]);
    expect(decodeCsv(bytes)).toEqual({ error: NOT_UTF8 });
    expect(NOT_UTF8).toMatch(/UTF-8/);
  });
  it('longer than the server reads, in characters, is refused whole', () => {
    expect(decodeCsv(new TextEncoder().encode('a'.repeat(CSV_MAX + 1)))).toEqual({ error: TOO_LONG });
    // 2 bytes a character: over CSV_MAX bytes, within CSV_MAX characters
    expect(decodeCsv(new TextEncoder().encode('ü'.repeat(CSV_MAX - 1)))).toHaveProperty('text');
  });
});
