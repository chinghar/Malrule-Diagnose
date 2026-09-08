// Experiment G -- does the finding belong to the method or to this scorer?
// Re-runs Experiment A's leave-one-out misattribution protocol and
// Experiment E's false-positive-on-correct-students protocol under each of
// the four scoring methods now exposed by lib/diagnose (see ScoringMethod's
// doc comment there), using the IDENTICAL simulated observations for every
// method (same seeds, method never enters the seed) so any movement in the
// numbers is attributable to the scorer alone, not to re-sampled data.

import { diagnose, DEFAULT_ABSTENTION_THRESHOLD, type ScoringMethod } from "../../lib/diagnose/diagnose.ts";
import { hashString, mulberry32, shuffle, simulateObservations } from "../../lib/diagnose/testSupport.ts";
import { CATEGORIES, MODEL_SLIP_RATE, pct } from "./data.mts";
import { fmtWilsonFromRate } from "./stats.mts";

export const SCORING_METHODS: ScoringMethod[] = ["logLikelihood", "naiveExactMatch", "binomialLikelihood", "prevalencePrior"];
const REFERENCE_OBS_COUNT = 5;
const TRIALS_PER_MALRULE = 30; // matches Experiment A's original protocol
const TRIALS_PER_CATEGORY = 200; // matches Experiment E's original protocol

export interface ScorerResult {
  method: ScoringMethod;
  misattributionRate: number;
  misattributionN: number;
  falsePositiveRate: number;
  falsePositiveN: number;
}

function runMisattribution(method: ScoringMethod): { n: number; misattr: number } {
  let n = 0;
  let misattr = 0;
  for (const cat of CATEGORIES) {
    for (const mr of cat.malrules) {
      for (let trial = 0; trial < TRIALS_PER_MALRULE; trial++) {
        const rng = mulberry32(hashString(`expG-A:${mr.id}:${trial}`));
        const obs = simulateObservations(mr.id, cat.instances, REFERENCE_OBS_COUNT, 0, rng);
        if (obs.length < REFERENCE_OBS_COUNT) continue;
        const candidateSet = cat.malrules.filter((x) => x.id !== mr.id);
        const result = diagnose(obs, cat.instances, candidateSet, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD, method);
        n += 1;
        if (!result.noPatternDetected) misattr += 1;
      }
    }
  }
  return { n, misattr };
}

function runFalsePositives(method: ScoringMethod): { n: number; fp: number } {
  let n = 0;
  let fp = 0;
  for (const cat of CATEGORIES) {
    for (let trial = 0; trial < TRIALS_PER_CATEGORY; trial++) {
      const rng = mulberry32(hashString(`expG-E:${cat.category}:${trial}`));
      const chosen = shuffle(cat.instances, rng).slice(0, REFERENCE_OBS_COUNT);
      const obs = chosen.map((inst) => ({ instanceId: inst.instance_id, studentAnswer: inst.correct_answer }));
      const result = diagnose(obs, cat.instances, cat.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD, method);
      n += 1;
      if (!result.noPatternDetected) fp += 1;
    }
  }
  return { n, fp };
}

export function runExperimentG(): ScorerResult[] {
  return SCORING_METHODS.map((method) => {
    const a = runMisattribution(method);
    const e = runFalsePositives(method);
    return {
      method,
      misattributionRate: a.misattr / a.n,
      misattributionN: a.n,
      falsePositiveRate: e.fp / e.n,
      falsePositiveN: e.n,
    };
  });
}

export function renderMarkdown(results: ScorerResult[]): string {
  const table = `| Scoring method | Misattribution rate (Experiment A re-run) | False-positive rate (Experiment E re-run) |\n|---|---|---|\n${results
    .map((r) => `| ${r.method} | ${fmtWilsonFromRate(r.misattributionRate, r.misattributionN)} | ${fmtWilsonFromRate(r.falsePositiveRate, r.falsePositiveN)} |`)
    .join("\n")}`;

  const misattrRates = results.map((r) => r.misattributionRate);
  const fpRates = results.map((r) => r.falsePositiveRate);
  const misattrSpread = Math.max(...misattrRates) - Math.min(...misattrRates);
  const fpSpread = Math.max(...fpRates) - Math.min(...fpRates);

  return `Every method below scores the IDENTICAL simulated observations
(same seeds; the scoring method is never part of the seed) at the
reference condition (threshold=${DEFAULT_ABSTENTION_THRESHOLD}, 5 observations, clean data) --
only the scoring function changes.

${table}

Misattribution rate spans ${pct(misattrSpread)} across all four methods (from ${pct(Math.min(...misattrRates))} to
${pct(Math.max(...misattrRates))}); false-positive rate spans ${pct(fpSpread)} (from ${pct(Math.min(...fpRates))} to
${pct(Math.max(...fpRates))}).`;
}
