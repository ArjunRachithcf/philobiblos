// A CSV a person imports (an order or invoice, orders/entries.ts): RFC 4180 read in one pass over the text, so its time
// is linear in its length whatever it holds, and bounded before anything is read (characters, rows, columns, a cell).
// Fields may be quoted ("…", a quote inside written twice) and hold the delimiter or a line break; the delimiter is the
// header line's own (a comma, a semicolon or a tab, the one it holds most of outside quotes). A byte order mark is left
// out, and lines that hold nothing (no text, or only empty cells) are skipped. Anything it cannot read whole (an unclosed quote, text after a closing
// quote) is refused, never guessed at.

export const CSV_LIMITS = { chars: 64 * 1024, rows: 101, columns: 20, cell: 1000 } as const;

export class CsvError extends Error {}

const DELIMITERS = [',', ';', '\t'] as const;

/** The header line's delimiter: the one it holds most of outside quotes (a comma when it holds none). */
function delimiterOf(text: string): string {
  const n = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && n.has(c)) n.set(c, n.get(c)! + 1);
  }
  let best = ',';
  for (const d of DELIMITERS) if (n.get(d)! > n.get(best)!) best = d;
  return best;
}

/** The records of `text`, the header first; refused (CsvError) past a limit or for anything not read whole. */
export function parseCsv(input: string): string[][] {
  if (input.length > CSV_LIMITS.chars) throw new CsvError(`at most ${CSV_LIMITS.chars} characters`);
  const text = input.startsWith('\ufeff') ? input.slice(1) : input;
  const delim = delimiterOf(text);
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false; // inside a quoted field
  let closed = false; // after a quoted field's closing quote
  let line = 1;
  const push = () => {
    if (cell.length > CSV_LIMITS.cell) throw new CsvError(`line ${line}: a cell of more than ${CSV_LIMITS.cell} characters`);
    row.push(cell);
    if (row.length > CSV_LIMITS.columns) throw new CsvError(`line ${line}: more than ${CSV_LIMITS.columns} columns`);
    cell = ''; closed = false;
  };
  const end = () => {
    push();
    // A line of empty cells (`;;;`, as spreadsheets end their exports) holds nothing either.
    if (row.some((c) => c !== '')) {
      out.push(row);
      if (out.length > CSV_LIMITS.rows) throw new CsvError(`more than ${CSV_LIMITS.rows - 1} rows`);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; }
      } else {
        if (c === '\n') line++;
        cell += c;
      }
      if (cell.length > CSV_LIMITS.cell) throw new CsvError(`line ${line}: a cell of more than ${CSV_LIMITS.cell} characters`);
      continue;
    }
    if (c === delim) { push(); continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      end(); line++;
      continue;
    }
    if (closed) throw new CsvError(`line ${line}: text after a closing quote`);
    if (c === '"') {
      if (cell !== '') throw new CsvError(`line ${line}: a quote inside a cell that does not start with one`);
      quoted = true;
      continue;
    }
    cell += c;
    if (cell.length > CSV_LIMITS.cell) throw new CsvError(`line ${line}: a cell of more than ${CSV_LIMITS.cell} characters`);
  }
  if (quoted) throw new CsvError(`line ${line}: a quote that is never closed`);
  if (cell !== '' || row.length || closed) end();
  return out;
}
