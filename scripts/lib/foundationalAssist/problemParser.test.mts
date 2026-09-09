import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseOperationAndOperands, parseProblemBody, computeParseCoverage, emitUnparseableSet } from "./problemParser.mts";

describe("parseOperationAndOperands", () => {
  it("parses a simple subtraction expression", () => {
    expect(parseOperationAndOperands("45 - 17")).toEqual({
      operation: "subtraction",
      operands: [
        { raw: "45", kind: "integer" },
        { raw: "17", kind: "integer" },
      ],
    });
  });

  it("parses addition with the + symbol", () => {
    expect(parseOperationAndOperands("Compute 12 + 8")).toEqual({
      operation: "addition",
      operands: [
        { raw: "12", kind: "integer" },
        { raw: "8", kind: "integer" },
      ],
    });
  });

  it("parses multiplication with ×", () => {
    expect(parseOperationAndOperands("6 × 7")).toEqual({
      operation: "multiplication",
      operands: [
        { raw: "6", kind: "integer" },
        { raw: "7", kind: "integer" },
      ],
    });
  });

  it("parses division with ÷", () => {
    expect(parseOperationAndOperands("84 ÷ 12")).toEqual({
      operation: "division",
      operands: [
        { raw: "84", kind: "integer" },
        { raw: "12", kind: "integer" },
      ],
    });
  });

  it("parses fraction operands without mistaking the internal / for a division operator", () => {
    const result = parseOperationAndOperands("3/4 + 1/2");
    expect(result?.operation).toBe("addition");
    expect(result?.operands).toEqual([
      { raw: "3/4", kind: "fraction" },
      { raw: "1/2", kind: "fraction" },
    ]);
  });

  it("parses decimal operands", () => {
    const result = parseOperationAndOperands("2.5 × 3.1");
    expect(result?.operation).toBe("multiplication");
    expect(result?.operands.map((o) => o.kind)).toEqual(["decimal", "decimal"]);
  });

  it("parses word-phrase operators", () => {
    expect(parseOperationAndOperands("What is 20 divided by 4?")?.operation).toBe("division");
    expect(parseOperationAndOperands("Find 6 multiplied by 7")?.operation).toBe("multiplication");
    expect(parseOperationAndOperands("9 plus 5")?.operation).toBe("addition");
    expect(parseOperationAndOperands("9 minus 5")?.operation).toBe("subtraction");
  });

  it("a bare division slash is recognized once fraction-shaped tokens are placeholdered out", () => {
    // Not a fraction (spaces around the slash) -- should read as a division operator.
    const result = parseOperationAndOperands("84 / 12");
    expect(result?.operation).toBe("division");
  });

  it("returns null (never a guess) for text with no recognizable operator", () => {
    expect(parseOperationAndOperands("How many apples does Sam have?")).toBeNull();
  });

  it("returns null for a mixed-operation expression rather than guessing which operator is 'the' one", () => {
    expect(parseOperationAndOperands("Calculate (71 - 53) + 14")).toBeNull();
  });

  it("returns null when only one operand is found", () => {
    expect(parseOperationAndOperands("Just the number 45")).toBeNull();
  });
});

describe("parseProblemBody (end to end, HTML through to structured output)", () => {
  it("cleans HTML and parses the resulting expression", () => {
    const result = parseProblemBody("<p>Calculate: 957 &minus; 317</p>");
    expect(result).toEqual({
      operation: "subtraction",
      operands: [
        { raw: "957", kind: "integer" },
        { raw: "317", kind: "integer" },
      ],
    });
  });

  it("parses a MathML fraction addition problem", () => {
    const result = parseProblemBody("<p><mfrac><mn>3</mn><mn>4</mn></mfrac> plus <mfrac><mn>1</mn><mn>2</mn></mfrac></p>");
    expect(result?.operation).toBe("addition");
    expect(result?.operands.map((o) => o.raw)).toEqual(["3/4", "1/2"]);
  });

  it("returns null for a genuinely unparseable multi-step word problem, rather than guessing", () => {
    expect(parseProblemBody("<p>A store had 502 items in stock. After selling 211 items, how many remain?</p>")).toBeNull();
  });
});

describe("computeParseCoverage / emitUnparseableSet", () => {
  const fixtureProblems = [
    { problemId: "p1", problemBody: "<p>45 - 17</p>" },
    { problemId: "p2", problemBody: "<p>6 &times; 7</p>" },
    { problemId: "p3", problemBody: "<p>A store had 502 items. After selling 211, how many remain?</p>" }, // unparseable by design
    { problemId: "p4", problemBody: "<p>How many sides does a hexagon have?</p>" }, // unparseable by design
  ];

  it("reports honest coverage, not padded", () => {
    const result = computeParseCoverage(fixtureProblems);
    expect(result.total).toBe(4);
    expect(result.parsed).toBe(2);
    expect(result.coverage).toBeCloseTo(0.5, 10);
    expect(result.unparseable.map((p) => p.problemId)).toEqual(["p3", "p4"]);
  });

  it("emits the full unparseable set to a file for inspection", () => {
    const result = computeParseCoverage(fixtureProblems);
    const dir = mkdtempSync(path.join(tmpdir(), "fa-unparseable-"));
    const dest = path.join(dir, "unparseable.json");
    emitUnparseableSet(result.unparseable, dest);

    const written = JSON.parse(readFileSync(dest, "utf-8"));
    expect(written).toHaveLength(2);
    expect(written.map((p: { problemId: string }) => p.problemId)).toEqual(["p3", "p4"]);
    expect(written[0].problemBody).toContain("502 items");
  });

  it("handles an empty problem list without dividing by zero", () => {
    const result = computeParseCoverage([]);
    expect(result.total).toBe(0);
    expect(result.parsed).toBe(0);
    expect(Number.isNaN(result.coverage)).toBe(true);
    expect(result.unparseable).toEqual([]);
  });
});
