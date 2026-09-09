// Phase 3 -- a minimal, correct, stdlib-only RFC4180-style CSV parser.
// No dependency added: hand-written rather than a library, per this round's
// "prefer stdlib" instruction -- the FoundationalASSIST files are documented
// as CSV (HuggingFace dataset card), and `problem_body` in particular is
// documented to contain raw HTML, which routinely embeds commas and
// (inside quoted fields) newlines, so a naive `line.split(",")` would
// silently corrupt data. This is a real correctness risk, not a style
// choice, hence hand-rolled and unit-tested against exactly those cases.
//
// Handles: quoted fields, embedded commas/newlines inside quotes, doubled
// "" as an escaped quote, both CRLF and bare LF line endings, and a
// possible trailing newline at end of file (no phantom empty final row).

export type CsvRow = string[];

/** Character-by-character state machine, shared by the whole-string and streaming parsers below so there is exactly one place the parsing logic can be wrong. */
class CsvStateMachine {
  private field = "";
  private row: string[] = [];
  private inQuotes = false;
  private sawAnyCharInFile = false;
  private pendingCr = false;
  // True right after seeing a `"` while inQuotes: the NEXT character (which
  // may arrive in a later push() call, i.e. a different network chunk)
  // decides whether this was an escaped "" or the field's closing quote.
  // Carrying this as instance state (not a single-chunk lookahead) is what
  // makes the parser correct regardless of where chunk boundaries fall.
  private pendingQuoteInQuoted = false;

  constructor(private readonly onRow: (row: CsvRow) => void) {}

  private endField(): void {
    this.row.push(this.field);
    this.field = "";
  }

  private endRow(): void {
    this.endField();
    this.onRow(this.row);
    this.row = [];
  }

  push(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;
      this.sawAnyCharInFile = true;

      if (this.pendingCr) {
        this.pendingCr = false;
        if (ch === "\n") continue; // CRLF: the \n completes the line ending already handled by \r
      }

      if (this.pendingQuoteInQuoted) {
        this.pendingQuoteInQuoted = false;
        if (ch === '"') {
          this.field += '"'; // doubled "" -- an escaped literal quote, stay inside the quoted field
          continue;
        }
        this.inQuotes = false; // that quote was the field's closing quote; fall through and process ch normally
      }

      if (this.inQuotes) {
        if (ch === '"') {
          this.pendingQuoteInQuoted = true;
        } else {
          this.field += ch;
        }
        continue;
      }

      if (ch === '"' && this.field.length === 0) {
        this.inQuotes = true;
        continue;
      }
      if (ch === ",") {
        this.endField();
        continue;
      }
      if (ch === "\r") {
        this.pendingCr = true;
        this.endRow();
        continue;
      }
      if (ch === "\n") {
        this.endRow();
        continue;
      }
      this.field += ch;
    }
  }

  finish(): void {
    // A trailing newline already emitted its row via endRow(); don't emit a
    // phantom empty final row in that case. Otherwise, flush whatever's
    // pending as the last row (a file with no trailing newline).
    if (this.field.length > 0 || this.row.length > 0) {
      this.endRow();
    }
    if (!this.sawAnyCharInFile) {
      // Empty input: no rows at all, not even an empty one.
    }
  }
}

/** Parses an entire CSV document already in memory. Correct for the FoundationalASSIST schema's documented content (HTML-bearing problem_body, quoted fields with embedded commas/newlines). */
export function parseCsvString(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  const machine = new CsvStateMachine((row) => rows.push(row));
  machine.push(text);
  machine.finish();
  return rows;
}

/**
 * Streams a CSV document from a Node Readable, yielding one row at a time,
 * so large files (FoundationalASSIST's interactions file is ~1.7M rows) can
 * be processed without holding the whole document in memory at once. Same
 * underlying state machine as parseCsvString -- one parsing implementation,
 * not two.
 */
export async function* parseCsvStream(readable: NodeJS.ReadableStream): AsyncGenerator<CsvRow> {
  const buffered: CsvRow[] = [];
  const machine = new CsvStateMachine((row) => buffered.push(row));

  for await (const chunk of readable) {
    machine.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
    while (buffered.length > 0) yield buffered.shift()!;
  }
  machine.finish();
  while (buffered.length > 0) yield buffered.shift()!;
}

/** Parses a CSV document's rows into header-keyed records, using the first row as the header. */
export function rowsToRecords(rows: CsvRow[]): { header: string[]; records: Record<string, string>[] } {
  if (rows.length === 0) return { header: [], records: [] };
  const [header, ...dataRows] = rows;
  const records = dataRows.map((row) => {
    const record: Record<string, string> = {};
    header!.forEach((col, i) => {
      record[col] = row[i] ?? "";
    });
    return record;
  });
  return { header: header!, records };
}
