// Shared committed-index loader for scripts/evaluate.mts and every
// experiment module under scripts/lib/. Single source of truth so the JSON
// is imported once and every module works from the same object identities.

import type { CategoryIndex } from "../../lib/diagnose/types.ts";

import subtraction from "../../data/index/subtraction.json" with { type: "json" };
import fractions from "../../data/index/fractions.json" with { type: "json" };
import decimals from "../../data/index/decimals.json" with { type: "json" };
import multiplicationDivision from "../../data/index/multiplication_division.json" with { type: "json" };

export const CATEGORIES: CategoryIndex[] = [
  subtraction as unknown as CategoryIndex,
  fractions as unknown as CategoryIndex,
  decimals as unknown as CategoryIndex,
  multiplicationDivision as unknown as CategoryIndex,
];

// The diagnosis engine's assumed noise level, held fixed across every
// measurement in the evaluation (see scripts/evaluate.mts for why).
export const MODEL_SLIP_RATE = 0.15;

export function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
