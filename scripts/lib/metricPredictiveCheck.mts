// Phase 2, metric 3 -- predictive check. Fit the malrule hypothesis on a
// student's first k errors in a skill, then predict their EXACT wrong
// answer on error k+1 -- not just "was it wrong." Label-free: the
// "prediction" is diagnose() naming a malrule and then EXECUTING it (via
// that malrule's own `predictions` entry for the k+1th problem), exactly
// the mechanism MRA (EVALUATION.md section 8) already relies on; this
// generalizes it from one worked example to k, and reports hit rate by k
// against a chance baseline grounded in the index's own recorded answer
// values for that specific problem (same principle as diagnose.ts's
// internal chanceMatchRate, reimplemented locally since it isn't exported).
//
// Observation order matters here (this is the one metric of the three that
// needs a genuine time-ordered sequence per student, not just a bag of
// observations) -- callers must pass each student's errors in the order
// they actually occurred.

import { diagnose, DEFAULT_ABSTENTION_THRESHOLD, DEFAULT_SLIP_RATE } from "../../lib/diagnose/diagnose.ts";
import type { MalruleMeta, ProblemInstance } from "../../lib/diagnose/types.ts";

export interface StudentErrorSequence {
  studentId: string;
  category: string;
  /** In the order the student actually made them. */
  errors: { instanceId: string; studentAnswer: string }[];
}

export interface PredictiveCheckByK {
  k: number;
  n: number;
  hits: number;
  hitRate: number;
  meanChanceBaseline: number;
}

export interface PredictiveCheckResult {
  byK: PredictiveCheckByK[];
}

function chanceRateForInstance(instance: ProblemInstance, predicted: string | undefined): number {
  if (predicted === undefined) return NaN;
  const distinct = new Set<string>([instance.correct_answer, ...Object.values(instance.predictions)]);
  return 1 / distinct.size;
}

export function runPredictiveCheck(
  sequences: StudentErrorSequence[],
  instances: ProblemInstance[],
  malrulesByCategory: Map<string, MalruleMeta[]>,
  ks: number[],
  slipRate: number = DEFAULT_SLIP_RATE,
  abstentionThreshold: number = DEFAULT_ABSTENTION_THRESHOLD
): PredictiveCheckResult {
  const instanceById = new Map(instances.map((i) => [i.instance_id, i]));

  const byK = ks.map((k) => {
    let n = 0;
    let hits = 0;
    let chanceSum = 0;

    for (const seq of sequences) {
      const malrules = malrulesByCategory.get(seq.category);
      if (!malrules) continue;
      if (seq.errors.length < k + 1) continue; // need k errors to fit on, plus one more to predict

      const fitOn = seq.errors.slice(0, k);
      const target = seq.errors[k]!;
      const targetInstance = instanceById.get(target.instanceId);
      if (!targetInstance) continue;

      const result = diagnose(fitOn, instances, malrules, slipRate, abstentionThreshold);
      if (result.noPatternDetected || result.ranked.length === 0) continue; // no diagnosis fit: nothing to predict with

      const topMalruleId = result.ranked[0]!.malruleId;
      const predictedAnswer = targetInstance.predictions[topMalruleId];
      if (predictedAnswer === undefined) continue; // the fitted malrule's algorithm doesn't run on the target problem: not a fair trial

      n += 1;
      chanceSum += chanceRateForInstance(targetInstance, predictedAnswer);
      if (predictedAnswer === target.studentAnswer) hits += 1;
    }

    return { k, n, hits, hitRate: n > 0 ? hits / n : NaN, meanChanceBaseline: n > 0 ? chanceSum / n : NaN };
  });

  return { byK };
}
