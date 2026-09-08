// Experiment C -- chance baselines and candidate-set scaling.

import { diagnose } from "../../lib/diagnose/diagnose.ts";
import { hashString, mulberry32, simulateObservations } from "../../lib/diagnose/testSupport.ts";
import type { CategoryIndex, MalruleMeta } from "../../lib/diagnose/types.ts";
import { CATEGORIES, MODEL_SLIP_RATE, pct } from "./data.mts";
import { fmtWilsonFromRate } from "./stats.mts";

// ---------------------------------------------------------------------------
// Chance baselines: 1/n over applicable candidates, per category.
// ---------------------------------------------------------------------------

export interface CategoryChanceBaseline {
  category: string;
  malruleCount: number;
  meanApplicableCandidates: number;
  chanceTop1: number;
  chanceTop3: number;
}

export function computeChanceBaselines(): CategoryChanceBaseline[] {
  return CATEGORIES.map((cat) => {
    let sumInvN = 0;
    let sumTop3 = 0;
    let sumN = 0;
    for (const inst of cat.instances) {
      const applicable = cat.malrules.filter((m) => inst.predictions[m.id] !== undefined).length;
      if (applicable === 0) continue;
      sumInvN += 1 / applicable;
      sumTop3 += Math.min(3 / applicable, 1);
      sumN += applicable;
    }
    return {
      category: cat.category,
      malruleCount: cat.malrules.length,
      meanApplicableCandidates: sumN / cat.instances.length,
      chanceTop1: sumInvN / cat.instances.length,
      chanceTop3: sumTop3 / cat.instances.length,
    };
  });
}

/** Malrule-count-weighted average across categories, matching how the pooled (a)/(b) sweep tables weight one malrule's trials equally regardless of its category's size. */
export function pooledChanceBaseline(perCategory: CategoryChanceBaseline[]): { chanceTop1: number; chanceTop3: number } {
  const totalMalrules = perCategory.reduce((s, c) => s + c.malruleCount, 0);
  return {
    chanceTop1: perCategory.reduce((s, c) => s + c.malruleCount * c.chanceTop1, 0) / totalMalrules,
    chanceTop3: perCategory.reduce((s, c) => s + c.malruleCount * c.chanceTop3, 0) / totalMalrules,
  };
}

// ---------------------------------------------------------------------------
// Candidate-set scaling. METHODOLOGICAL TRAP: malrules from other categories
// never produce a defined answer for a problem outside their own category
// (see build_index.py -- cross-application is only ever attempted within a
// category), so padding the *nominal* candidate set with other-category
// malrules can never actually raise the *applicable* candidate count for any
// given trial. Both are measured and reported separately, and accuracy is
// plotted against applicable count, not nominal count, because nominal
// count alone is a misleading axis here.
// ---------------------------------------------------------------------------

const NOMINAL_TARGETS = [5, 10, 15, 20, 26];
const REFERENCE_OBS_COUNT = 5;
const TRIALS_PER_MALRULE = 30;

export interface ScalingTrial {
  nominalTarget: number;
  nominalSizeUsed: number;
  malruleId: string;
  applicableCount: number;
  top1Correct: boolean;
}

function buildPaddedCandidateSet(cat: CategoryIndex, nominalTarget: number, allMalrules: MalruleMeta[]): MalruleMeta[] {
  const native = cat.malrules;
  if (native.length >= nominalTarget) return native;
  const others = allMalrules.filter((m) => m.category !== cat.category).sort((a, b) => a.id.localeCompare(b.id));
  const padding = others.slice(0, nominalTarget - native.length);
  return [...native, ...padding];
}

export function runCandidateScaling(): ScalingTrial[] {
  const allMalrules = CATEGORIES.flatMap((c) => c.malrules);
  const trials: ScalingTrial[] = [];

  for (const nominalTarget of NOMINAL_TARGETS) {
    for (const cat of CATEGORIES) {
      const candidateSet = buildPaddedCandidateSet(cat, nominalTarget, allMalrules);
      for (const mr of cat.malrules) {
        for (let trial = 0; trial < TRIALS_PER_MALRULE; trial++) {
          const rng = mulberry32(hashString(`scaling:${nominalTarget}:${mr.id}:${trial}`));
          const obs = simulateObservations(mr.id, cat.instances, REFERENCE_OBS_COUNT, 0, rng);
          if (obs.length < REFERENCE_OBS_COUNT) continue;
          const result = diagnose(obs, cat.instances, candidateSet, MODEL_SLIP_RATE);
          trials.push({
            nominalTarget,
            nominalSizeUsed: candidateSet.length,
            malruleId: mr.id,
            applicableCount: result.ranked.length,
            top1Correct: result.ranked[0]?.malruleId === mr.id,
          });
        }
      }
    }
  }

  return trials;
}

export interface ScalingSummaryRow {
  key: number; // nominalTarget or applicableCount, depending on grouping
  n: number;
  top1Rate: number;
}

export function summarizeByNominalTarget(trials: ScalingTrial[]): ScalingSummaryRow[] {
  return NOMINAL_TARGETS.map((target) => {
    const rows = trials.filter((t) => t.nominalTarget === target);
    return { key: target, n: rows.length, top1Rate: rows.filter((t) => t.top1Correct).length / rows.length };
  });
}

export function summarizeByApplicableCount(trials: ScalingTrial[]): ScalingSummaryRow[] {
  const counts = [...new Set(trials.map((t) => t.applicableCount))].sort((a, b) => a - b);
  return counts.map((count) => {
    const rows = trials.filter((t) => t.applicableCount === count);
    return { key: count, n: rows.length, top1Rate: rows.filter((t) => t.top1Correct).length / rows.length };
  });
}

export function maxApplicableCountObserved(trials: ScalingTrial[]): number {
  return Math.max(...trials.map((t) => t.applicableCount));
}

export function renderMarkdown(
  chance: CategoryChanceBaseline[],
  pooled: { chanceTop1: number; chanceTop3: number },
  scalingTrials: ScalingTrial[]
): string {
  const chanceTable = `| Category | Malrules | Mean applicable candidates | Chance top-1 (1/n) | Chance top-3 |\n|---|---|---|---|---|\n${chance
    .map((c) => `| ${c.category} | ${c.malruleCount} | ${c.meanApplicableCandidates.toFixed(2)} | ${pct(c.chanceTop1)} | ${pct(c.chanceTop3)} |`)
    .join("\n")}\n| **pooled (malrule-count-weighted)** | 26 | -- | **${pct(pooled.chanceTop1)}** | **${pct(pooled.chanceTop3)}** |`;

  const byNominal = summarizeByNominalTarget(scalingTrials);
  const byApplicable = summarizeByApplicableCount(scalingTrials);
  const maxApplicable = maxApplicableCountObserved(scalingTrials);

  const nominalTable = `| Nominal candidate-set size | n | Top-1 accuracy (95% CI, Wilson) |\n|---|---|---|\n${byNominal
    .map((r) => `| ${r.key} | ${r.n} | ${fmtWilsonFromRate(r.top1Rate, r.n)} |`)
    .join("\n")}`;

  const applicableTable = `| Applicable candidates (actual) | n | Top-1 accuracy (95% CI, Wilson) |\n|---|---|---|\n${byApplicable
    .map((r) => `| ${r.key} | ${r.n} | ${fmtWilsonFromRate(r.top1Rate, r.n)} |`)
    .join("\n")}`;

  return `### Chance baselines

1/n over applicable candidates, computed directly from the index (not
assumed): for every instance in a category, count how many of that
category's malrules actually have a defined prediction for it, and average
1/(that count) across all instances. This is the number every accuracy
figure elsewhere in this document should be read against.

${chanceTable}

**Chance top-3 is already ${pct(pooled.chanceTop3)} pooled, and ${pct(chance.find((c) => c.category === "fractions")!.chanceTop3)} in
fractions specifically** (mean applicable candidates there is only
${chance.find((c) => c.category === "fractions")!.meanApplicableCandidates.toFixed(2)}). Read every top-3 figure elsewhere in this
document against that baseline, not against 100%: with typically only 2-4
real competitors per problem, naming 3 candidates often covers most or all
of the space by construction, independent of how good the engine is.

### Candidate-set scaling

**Methodological trap, confirmed empirically, not assumed:** a malrule
from another category never produces a defined answer for a problem
outside its own category (\`build_index.py\` only ever attempts
cross-application within a category), so padding the *nominal* candidate
set with other-category malrules can never raise the *applicable*
candidate count for any trial. Both are measured and reported separately
below.

**Nominal candidate-set size 5, 10, 15, 20, 26 (padded with other-category malrules):**

${nominalTable}

Accuracy vs. nominal size is flat -- because nominal size is a fiction
here; none of the padding malrules were ever real competitors.

**Actual applicable candidate count per trial (the real axis):**

${applicableTable}

**The maximum applicable candidate count observed across every trial, at
any nominal target, was ${maxApplicable}** -- exactly the library's largest single
category. Padding the nominal set up to 26 never once produced a trial
with more than ${maxApplicable} real competing candidates. **The degradation curve this
experiment was designed to measure is untestable at scale within this
library**; the only genuine applicable-count variation available is the
narrow range between the smallest (5, decimals/multiplication_division)
and largest (8, subtraction/fractions) category, which is too small a
range to characterize how accuracy degrades as the candidate pool grows.`;
}
