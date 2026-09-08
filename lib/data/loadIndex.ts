// Reads only the committed index under data/index/ via static JSON imports --
// no fs, no network, no runtime fetch. Safe to call from server components,
// the static build, or tests.

import type { CategoryIndex, MalruleMeta, ProblemInstance } from "@/lib/diagnose/types";
import subtraction from "@/data/index/subtraction.json";
import fractions from "@/data/index/fractions.json";
import decimals from "@/data/index/decimals.json";
import multiplicationDivision from "@/data/index/multiplication_division.json";

// TypeScript infers a narrow literal type per JSON module (each instance's
// `predictions` object has only the keys actually present in that instance),
// which doesn't structurally satisfy Record<string, string> directly.
const CATEGORY_INDEXES: CategoryIndex[] = [
  subtraction as unknown as CategoryIndex,
  fractions as unknown as CategoryIndex,
  decimals as unknown as CategoryIndex,
  multiplicationDivision as unknown as CategoryIndex,
];

export function allCategories(): CategoryIndex[] {
  return CATEGORY_INDEXES;
}

export function categoryByName(name: string): CategoryIndex | undefined {
  return CATEGORY_INDEXES.find((c) => c.category === name);
}

export function allMalrules(): MalruleMeta[] {
  return CATEGORY_INDEXES.flatMap((c) => c.malrules);
}

export function allInstances(): ProblemInstance[] {
  return CATEGORY_INDEXES.flatMap((c) => c.instances);
}

export function malrulesForCategory(category: string): MalruleMeta[] {
  return categoryByName(category)?.malrules ?? [];
}

export function instancesForCategory(category: string): ProblemInstance[] {
  return categoryByName(category)?.instances ?? [];
}
