// Phase 4 -- extracts structured (operation, operands) from cleaned
// problem text. Malrule inference is impossible without operands: a
// malrule is an executable procedure over specific numbers, not a
// description, so this is the piece that makes any real-data malrule
// diagnosis possible at all.
//
// This is a bounded, pattern-based extractor, NOT general math NLP. It is
// EXPECTED to fail on a large fraction of real problem text -- multi-step
// problems, problems phrased in ways not covered by the pattern set, and
// genuinely ambiguous phrasing all return null rather than a guess. Actual
// coverage against the real 3,395 problems can only be measured once
// FoundationalASSIST is on disk (Phase 5); this module's own tests measure
// coverage only against the small, hand-built fixture set below, which
// exists to verify parser MECHANICS, not to stand in for the real dataset.

import { writeFileSync } from "node:fs";
import { cleanProblemBody } from "./htmlClean.mts";

export type Operation = "addition" | "subtraction" | "multiplication" | "division";

export type OperandKind = "integer" | "decimal" | "fraction";

export interface Operand {
  raw: string;
  kind: OperandKind;
}

export interface ParsedProblem {
  operation: Operation;
  operands: Operand[];
}

// No spaces around the slash: "3/4" is a fraction, "84 / 12" is a division
// expression -- the realistic typographic convention, and the only way to
// tell the two apart from text alone.
const FRACTION_TOKEN = /\b\d+\/\d+\b/g;
const DECIMAL_TOKEN = /-?\d+\.\d+/;
const INTEGER_TOKEN = /-?\d+/;

function classifyOperand(raw: string): OperandKind {
  if (raw.includes("/")) return "fraction";
  if (raw.includes(".")) return "decimal";
  return "integer";
}

// Symbol and phrase operators, checked in order (multi-word phrases before
// single symbols, so "divided by" isn't mistaken for a bare "/" match
// inside adjacent unrelated text).
const OPERATOR_PATTERNS: { pattern: RegExp; operation: Operation }[] = [
  { pattern: /divided\s+by/i, operation: "division" },
  { pattern: /multiplied\s+by/i, operation: "multiplication" },
  { pattern: /\bplus\b/i, operation: "addition" },
  { pattern: /\bminus\b/i, operation: "subtraction" },
  { pattern: /\btimes\b/i, operation: "multiplication" },
  { pattern: /[+]/, operation: "addition" },
  { pattern: /[−-]/, operation: "subtraction" }, // real minus sign or hyphen-minus
  { pattern: /[×*]/, operation: "multiplication" },
  { pattern: /[÷]/, operation: "division" },
  { pattern: /\//, operation: "division" }, // bare slash NOT already consumed as a fraction token (those are placeholdered out before this runs)
];

/**
 * Extracts (operation, operands) from already-cleaned text. Returns null --
 * never a guess -- when zero or more than one DISTINCT operation type is
 * found (a mixed-operation expression isn't a fair single-malrule-category
 * fit), or when fewer than two operands are found around the operator.
 */
export function parseOperationAndOperands(cleanedText: string): ParsedProblem | null {
  // Placeholder out fraction-shaped operands first so their internal "/"
  // is never mistaken for a division operator.
  const fractions: string[] = [];
  const withPlaceholders = cleanedText.replace(FRACTION_TOKEN, (match) => {
    const token = `@FRAC${fractions.length}@`;
    fractions.push(match.replace(/\s+/g, ""));
    return token;
  });

  const foundOperations = new Set<Operation>();
  for (const { pattern, operation } of OPERATOR_PATTERNS) {
    if (pattern.test(withPlaceholders)) foundOperations.add(operation);
  }
  if (foundOperations.size !== 1) return null; // none found, or a mixed expression -- don't guess which operation is "the" one

  const [operation] = foundOperations;

  // Recover operand tokens: placeholders (fractions), decimals, or
  // integers, in order of appearance.
  const operandRegex = new RegExp(`@FRAC(\\d+)@|${DECIMAL_TOKEN.source}|${INTEGER_TOKEN.source}`, "g");
  const rawOperands: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = operandRegex.exec(withPlaceholders)) !== null) {
    if (m[1] !== undefined) rawOperands.push(fractions[Number(m[1])]!);
    else rawOperands.push(m[0]);
  }

  if (rawOperands.length < 2) return null;

  return {
    operation: operation!,
    operands: rawOperands.map((raw) => ({ raw, kind: classifyOperand(raw) })),
  };
}

/** End-to-end: raw HTML problem_body -> cleaned text -> (operation, operands), or null. */
export function parseProblemBody(problemBodyHtml: string): ParsedProblem | null {
  return parseOperationAndOperands(cleanProblemBody(problemBodyHtml));
}

export interface CoverageResult<T> {
  total: number;
  parsed: number;
  coverage: number;
  unparseable: T[];
}

/**
 * Runs the parser over a list of problems and reports honest coverage plus
 * the full unparseable set for inspection -- never pads the parsed count
 * or drops the unparseable set silently.
 */
export function computeParseCoverage<T extends { problemId: string; problemBody: string }>(problems: T[]): CoverageResult<T> {
  const unparseable: T[] = [];
  let parsed = 0;
  for (const p of problems) {
    if (parseProblemBody(p.problemBody) !== null) parsed += 1;
    else unparseable.push(p);
  }
  return { total: problems.length, parsed, coverage: problems.length > 0 ? parsed / problems.length : NaN, unparseable };
}

/** Writes the unparseable set to a JSON file for manual inspection -- every item, never a sample or a truncated preview. */
export function emitUnparseableSet<T extends { problemId: string; problemBody: string }>(unparseable: T[], destPath: string): void {
  writeFileSync(destPath, JSON.stringify(unparseable, null, 2) + "\n");
}
