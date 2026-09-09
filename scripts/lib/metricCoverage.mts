// Phase 2, metric 1 -- coverage vs. null. Entirely label-free: never
// references native_malrule_id or any other ground-truth field. Operates on
// generic wrong-answer observations so the same function runs unmodified
// against synthetic fixtures now and FoundationalASSIST later.
//
// "Coverage" = fraction of wrong answers that get a non-abstain diagnosis
// (diagnose() on that single observation alone). The null holds the problem
// fixed and substitutes the observed wrong answer with a wrong answer some
// OTHER observation in the same category/skill gave on a DIFFERENT problem --
// preserving the marginal distribution of wrong answers within that
// category while destroying the problem-answer correspondence. A real gap
// (real coverage > null coverage) is evidence the framework is doing more
// than being generically permissive; a gap near zero is a valid, reportable
// negative result: the malrule framework does not transfer to this
// population.

import { diagnose, DEFAULT_ABSTENTION_THRESHOLD, DEFAULT_SLIP_RATE } from "../../lib/diagnose/diagnose.ts";
import { shuffle } from "../../lib/diagnose/testSupport.ts";
import type { MalruleMeta, ProblemInstance } from "../../lib/diagnose/types.ts";
import { Z_95 } from "./stats.mts";

export interface WrongAnswerObservation {
  /** Unique id for this wrong-answer event (e.g. a student-problem pair). Not used for scoring; only for bookkeeping. */
  id: string;
  instanceId: string;
  /** Skill/category tag. Must match a category present in `instances`/`malrules`' own `category` field for real diagnosis to be possible. */
  category: string;
  /** The wrong answer given. Caller is responsible for having already excluded correct answers (see the FoundationalASSIST adapter's discrete_score handling). */
  studentAnswer: string;
}

export interface CoverageResult {
  n: number;
  excludedNoNullCandidate: number; // observations in a category with no OTHER problem to draw a null substitute from
  realCoverage: number;
  nullCoverage: number;
  gap: number;
  gapCI: { lower: number; upper: number };
}

function isCovered(
  obs: { instanceId: string; studentAnswer: string },
  instances: ProblemInstance[],
  malrules: MalruleMeta[],
  slipRate: number,
  abstentionThreshold: number
): boolean {
  const result = diagnose([{ instanceId: obs.instanceId, studentAnswer: obs.studentAnswer }], instances, malrules, slipRate, abstentionThreshold);
  return !result.noPatternDetected;
}

/**
 * Real coverage, null coverage (shuffled-substitute), the gap between them,
 * and a paired (McNemar-style) 95% CI on that gap -- correct for the fact
 * that real and null are computed on the SAME observations, not independent
 * samples.
 */
export function computeCoverageVsNull(
  observations: WrongAnswerObservation[],
  instances: ProblemInstance[],
  malrulesByCategory: Map<string, MalruleMeta[]>,
  rng: () => number,
  slipRate: number = DEFAULT_SLIP_RATE,
  abstentionThreshold: number = DEFAULT_ABSTENTION_THRESHOLD
): CoverageResult {
  const byCategory = new Map<string, WrongAnswerObservation[]>();
  for (const obs of observations) {
    const list = byCategory.get(obs.category) ?? [];
    list.push(obs);
    byCategory.set(obs.category, list);
  }

  let n = 0;
  let excludedNoNullCandidate = 0;
  let realCovered = 0;
  let nullCovered = 0;
  let b = 0; // real covered, null not
  let c = 0; // null covered, real not

  for (const [category, obsInCategory] of byCategory) {
    const malrules = malrulesByCategory.get(category);
    if (!malrules || malrules.length === 0) continue; // no malrule set for this category: nothing to diagnose against

    // Deterministic shuffle of candidate indices per category, so each
    // observation's null substitute is drawn from a fixed, reproducible
    // permutation of the OTHER observations in the same category.
    const order = shuffle(
      obsInCategory.map((_, i) => i),
      rng
    );

    for (let i = 0; i < obsInCategory.length; i++) {
      const obs = obsInCategory[i]!;
      const otherProblemIndices = order.filter((j) => obsInCategory[j]!.instanceId !== obs.instanceId);
      if (otherProblemIndices.length === 0) {
        excludedNoNullCandidate += 1;
        continue;
      }
      // Deterministic pick: first eligible index in the shuffled order that
      // isn't this observation's own problem.
      const substitute = obsInCategory[otherProblemIndices[0]!]!;

      const real = isCovered({ instanceId: obs.instanceId, studentAnswer: obs.studentAnswer }, instances, malrules, slipRate, abstentionThreshold);
      const nul = isCovered({ instanceId: obs.instanceId, studentAnswer: substitute.studentAnswer }, instances, malrules, slipRate, abstentionThreshold);

      n += 1;
      if (real) realCovered += 1;
      if (nul) nullCovered += 1;
      if (real && !nul) b += 1;
      if (nul && !real) c += 1;
    }
  }

  const realCoverage = n > 0 ? realCovered / n : NaN;
  const nullCoverage = n > 0 ? nullCovered / n : NaN;
  const gap = realCoverage - nullCoverage;
  const se = n > 0 ? Math.sqrt(b + c) / n : NaN;
  const margin = Z_95 * se;

  return {
    n,
    excludedNoNullCandidate,
    realCoverage,
    nullCoverage,
    gap,
    gapCI: { lower: gap - margin, upper: gap + margin },
  };
}
