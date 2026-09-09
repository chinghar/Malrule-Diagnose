import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { parseCsvString, parseCsvStream, rowsToRecords } from "./csv.mts";

describe("parseCsvString", () => {
  it("parses simple unquoted rows", () => {
    expect(parseCsvString("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("parses a file with no trailing newline (last row still emitted, no phantom row)", () => {
    expect(parseCsvString("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("does not emit a phantom empty row after a trailing newline", () => {
    expect(parseCsvString("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles quoted fields containing commas -- the exact trap problem_body's HTML creates", () => {
    expect(parseCsvString('id,body\n1,"<p>Compute 3, 4, and 5</p>"\n')).toEqual([
      ["id", "body"],
      ["1", "<p>Compute 3, 4, and 5</p>"],
    ]);
  });

  it("handles quoted fields containing embedded newlines -- HTML problem_body routinely does this", () => {
    expect(parseCsvString('id,body\n1,"line one\nline two"\n2,plain\n')).toEqual([
      ["id", "body"],
      ["1", "line one\nline two"],
      ["2", "plain"],
    ]);
  });

  it('handles doubled "" as an escaped literal quote inside a quoted field', () => {
    expect(parseCsvString('id,text\n1,"she said ""hi"""\n')).toEqual([
      ["id", "text"],
      ["1", 'she said "hi"'],
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsvString("a,b\r\n1,2\r\n3,4\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("handles mixed CRLF and embedded-newline-in-quotes correctly", () => {
    expect(parseCsvString('id,body\r\n1,"a\nb"\r\n2,plain\r\n')).toEqual([
      ["id", "body"],
      ["1", "a\nb"],
      ["2", "plain"],
    ]);
  });

  it("preserves empty fields", () => {
    expect(parseCsvString("a,b,c\n1,,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseCsvString("")).toEqual([]);
  });
});

describe("parseCsvStream", () => {
  it("produces the same rows as parseCsvString when the input arrives in one chunk", async () => {
    const text = 'id,body\n1,"a, b"\n2,"c\nd"\n';
    const rows: string[][] = [];
    for await (const row of parseCsvStream(Readable.from([text]))) rows.push(row);
    expect(rows).toEqual(parseCsvString(text));
  });

  it("produces the same rows when the input is split across multiple small chunks, including mid-quoted-field splits", async () => {
    const text = 'id,body\n1,"a long value with, a comma and\na newline"\n2,plain\n';
    // Deliberately split at arbitrary byte offsets, including inside the quoted field and across the escaped-quote boundary.
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 7) chunks.push(text.slice(i, i + 7));
    const rows: string[][] = [];
    for await (const row of parseCsvStream(Readable.from(chunks))) rows.push(row);
    expect(rows).toEqual(parseCsvString(text));
  });

  it("splits correctly even when a doubled-quote escape straddles a chunk boundary", async () => {
    const text = 'id,text\n1,"she said ""hi"""\n';
    for (let splitAt = 1; splitAt < text.length; splitAt++) {
      const chunks = [text.slice(0, splitAt), text.slice(splitAt)];
      const rows: string[][] = [];
      for await (const row of parseCsvStream(Readable.from(chunks))) rows.push(row);
      expect(rows).toEqual(parseCsvString(text));
    }
  });
});

describe("rowsToRecords", () => {
  it("keys each data row by the header row", () => {
    const rows = parseCsvString("id,name\n1,alice\n2,bob\n");
    const { header, records } = rowsToRecords(rows);
    expect(header).toEqual(["id", "name"]);
    expect(records).toEqual([
      { id: "1", name: "alice" },
      { id: "2", name: "bob" },
    ]);
  });

  it("returns empty header/records for empty input", () => {
    expect(rowsToRecords([])).toEqual({ header: [], records: [] });
  });
});
