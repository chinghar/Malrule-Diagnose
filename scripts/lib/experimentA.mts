// Experiment A -- open-world misattribution (leave-one-out).
//
// For each of the 26 malrules m, generate held-out "student answers" by
// reading m's own column in the committed index (exactly what
// simulateObservations already does), then diagnose against m's own
// category with m EXCLUDED from the candidate set. No MalruleLib clone
// required, no index rebuild -- this reads only data/index/*.json.
//
// Because the true malrule is never a candidate, there are exactly two
// possible outcomes per trial: the engine abstains ("no systematic pattern
// detected"), or it confidently names some other, wrong, in-library
// malrule -- a misattribution. There is no "correct" outcome available by
// construction, so abstentionRate + misattributionRate == 1 always; this
// experiment measures how that split moves as the abstention threshold,
// slip rate, and observation count vary.

import { diagnose, DEFAULT_ABSTENTION_THRESHOLD } from "../../lib/diagnose/diagnose.ts";
import { hashString, mulberry32, simulateObservations } from "../../lib/diagnose/testSupport.ts";
import type { CategoryIndex, MalruleMeta } from "../../lib/diagnose/types.ts";
import { CATEGORIES, MODEL_SLIP_RATE, pct } from "./data.mts";

export const THRESHOLD_GRID = [0, 0.5, 1, 1.5, 2, 3, 5, 8, 12, 20];
export const SLIP_RATES = [0, 0.05, 0.1, 0.2];
export const OBS_COUNTS = [3, 5, 10];
const TRIALS_PER_COMBO = 30;

// Reference operating point for the per-malrule breakdown and the headline
// "misattribution rate at the current default" checkpoint number: the
// engine's actual shipped default threshold, at the same obsCount/slip-rate
// convention used for measurement (a) elsewhere in EVALUATION.md.
export const REFERENCE_OBS_COUNT = 5;
export const REFERENCE_SLIP_RATE = 0; // clean, matching (a)'s "clean data" protocol
const BREAKDOWN_TRIALS_PER_MALRULE = 200;

export interface SweepPoint {
  threshold: number;
  slipRate: number;
  obsCount: number;
  n: number;
  heldOutAbstentionRate: number;
  heldOutMisattributionRate: number;
  inLibraryAbstentionRate: number;
  inLibraryConfidentCorrectRate: number;
  inLibraryTop1Rate: number; // unaffected by threshold; included as a reference invariant
}

export interface PerMalruleBreakdown {
  malruleId: string;
  category: string;
  n: number;
  misattributionRate: number;
  abstentionRate: number;
  topMisattributedTo: string | null;
  topMisattributedToRate: number; // fraction of ALL trials (not just misattributed ones) landing on topMisattributedTo
}

function runHeldOutTrial(
  mr: MalruleMeta,
  cat: CategoryIndex,
  obsCount: number,
  injectedSlipRate: number,
  threshold: number,
  rng: () => number
): { abstained: boolean; misattributedTo: string | null } | null {
  const obs = simulateObservations(mr.id, cat.instances, obsCount, injectedSlipRate, rng);
  if (obs.length < obsCount) return null; // not enough applicable instances for a fair trial
  const candidateSet = cat.malrules.filter((x) => x.id !== mr.id);
  const result = diagnose(obs, cat.instances, candidateSet, MODEL_SLIP_RATE, threshold);
  return {
    abstained: result.noPatternDetected,
    misattributedTo: result.noPatternDetected ? null : (result.ranked[0]?.malruleId ?? null),
  };
}

function runInLibraryTrial(
  mr: MalruleMeta,
  cat: CategoryIndex,
  obsCount: number,
  injectedSlipRate: number,
  threshold: number,
  rng: () => number
): { abstained: boolean; top1Correct: boolean } | null {
  const obs = simulateObservations(mr.id, cat.instances, obsCount, injectedSlipRate, rng);
  if (obs.length < obsCount) return null;
  const result = diagnose(obs, cat.instances, cat.malrules, MODEL_SLIP_RATE, threshold);
  return {
    abstained: result.noPatternDetected,
    top1Correct: result.ranked[0]?.malruleId === mr.id,
  };
}

export function runSweep(): SweepPoint[] {
  const points: SweepPoint[] = [];

  for (const slipRate of SLIP_RATES) {
    for (const obsCount of OBS_COUNTS) {
      for (const threshold of THRESHOLD_GRID) {
        let n = 0;
        let heldOutAbstain = 0;
        let heldOutMisattr = 0;
        let inLibN = 0;
        let inLibAbstain = 0;
        let inLibConfCorrect = 0;
        let inLibTop1 = 0;

        for (const cat of CATEGORIES) {
          for (const mr of cat.malrules) {
            for (let trial = 0; trial < TRIALS_PER_COMBO; trial++) {
              const rngHeld = mulberry32(hashString(`heldout:${mr.id}:${slipRate}:${obsCount}:${threshold}:${trial}`));
              const ho = runHeldOutTrial(mr, cat, obsCount, slipRate, threshold, rngHeld);
              if (ho) {
                n += 1;
                if (ho.abstained) heldOutAbstain += 1;
                else heldOutMisattr += 1;
              }

              const rngIn = mulberry32(hashString(`inlib:${mr.id}:${slipRate}:${obsCount}:${threshold}:${trial}`));
              const il = runInLibraryTrial(mr, cat, obsCount, slipRate, threshold, rngIn);
              if (il) {
                inLibN += 1;
                if (il.abstained) inLibAbstain += 1;
                if (!il.abstained && il.top1Correct) inLibConfCorrect += 1;
                if (il.top1Correct) inLibTop1 += 1;
              }
            }
          }
        }

        points.push({
          threshold,
          slipRate,
          obsCount,
          n,
          heldOutAbstentionRate: heldOutAbstain / n,
          heldOutMisattributionRate: heldOutMisattr / n,
          inLibraryAbstentionRate: inLibAbstain / inLibN,
          inLibraryConfidentCorrectRate: inLibConfCorrect / inLibN,
          inLibraryTop1Rate: inLibTop1 / inLibN,
        });
      }
    }
  }

  return points;
}

/** The single headline number for the Phase 1 checkpoint: misattribution rate at the engine's actual shipped default. */
export function defaultMisattributionRate(sweep: SweepPoint[]): SweepPoint {
  const point = sweep.find(
    (p) =>
      p.threshold === DEFAULT_ABSTENTION_THRESHOLD &&
      p.slipRate === REFERENCE_SLIP_RATE &&
      p.obsCount === REFERENCE_OBS_COUNT
  );
  if (!point) throw new Error("Reference operating point missing from sweep -- grid does not include the default");
  return point;
}

export function runPerMalruleBreakdown(): PerMalruleBreakdown[] {
  const rows: PerMalruleBreakdown[] = [];

  for (const cat of CATEGORIES) {
    for (const mr of cat.malrules) {
      let n = 0;
      let abstained = 0;
      const misattributionCounts = new Map<string, number>();

      for (let trial = 0; trial < BREAKDOWN_TRIALS_PER_MALRULE; trial++) {
        const rng = mulberry32(hashString(`breakdown:${mr.id}:${trial}`));
        const ho = runHeldOutTrial(mr, cat, REFERENCE_OBS_COUNT, REFERENCE_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD, rng);
        if (!ho) continue;
        n += 1;
        if (ho.abstained) {
          abstained += 1;
        } else if (ho.misattributedTo) {
          misattributionCounts.set(ho.misattributedTo, (misattributionCounts.get(ho.misattributedTo) ?? 0) + 1);
        }
      }

      let topTarget: string | null = null;
      let topCount = 0;
      for (const [target, count] of misattributionCounts) {
        if (count > topCount) {
          topTarget = target;
          topCount = count;
        }
      }

      rows.push({
        malruleId: mr.id,
        category: cat.category,
        n,
        misattributionRate: (n - abstained) / n,
        abstentionRate: abstained / n,
        topMisattributedTo: topTarget,
        topMisattributedToRate: topTarget ? topCount / n : 0,
      });
    }
  }

  return rows.sort((a, b) => b.misattributionRate - a.misattributionRate);
}

export interface ThresholdMeans {
  threshold: number;
  meanHeldOutMisattributionRate: number;
  meanInLibraryAbstentionRate: number;
  meanInLibraryConfidentCorrectRate: number;
}

/** Averages each grid cell across every (obsCount, slipRate) condition -- the headline tradeoff curve. */
export function meansByThreshold(sweep: SweepPoint[]): ThresholdMeans[] {
  return THRESHOLD_GRID.map((threshold) => {
    const rows = sweep.filter((p) => p.threshold === threshold);
    return {
      threshold,
      meanHeldOutMisattributionRate: rows.reduce((s, p) => s + p.heldOutMisattributionRate, 0) / rows.length,
      meanInLibraryAbstentionRate: rows.reduce((s, p) => s + p.inLibraryAbstentionRate, 0) / rows.length,
      meanInLibraryConfidentCorrectRate: rows.reduce((s, p) => s + p.inLibraryConfidentCorrectRate, 0) / rows.length,
    };
  });
}

/**
 * Smallest grid threshold whose mean in-library abstention cost stays under
 * `maxMeanInLibraryAbstentionRate` -- i.e. the last point before the knee
 * where coverage collapses. Not tuned to a specific desired headline
 * number; the cap is a coverage-cost ceiling chosen before looking at the
 * misattribution side of the curve.
 */
export function recommendOperatingPoint(sweep: SweepPoint[], maxMeanInLibraryAbstentionRate = 0.15): ThresholdMeans {
  const means = meansByThreshold(sweep);
  const viable = means.filter((m) => m.meanInLibraryAbstentionRate <= maxMeanInLibraryAbstentionRate);
  const best = viable.reduce((best, m) => (m.threshold > best.threshold ? m : best), viable[0]!);
  return best ?? means[0]!;
}

function renderConditionTable(sweep: SweepPoint[], obsCount: number, slipRate: number): string {
  const rows = sweep.filter((p) => p.obsCount === obsCount && p.slipRate === slipRate);
  const header =
    "| Threshold | Held-out misattribution | Held-out abstention | In-library abstention (cost) | In-library confident-correct |\n|---|---|---|---|---|";
  const body = rows
    .map(
      (p) =>
        `| ${p.threshold} | ${pct(p.heldOutMisattributionRate)} | ${pct(p.heldOutAbstentionRate)} | ${pct(p.inLibraryAbstentionRate)} | ${pct(p.inLibraryConfidentCorrectRate)} |`
    )
    .join("\n");
  return `${header}\n${body}`;
}

export function renderMarkdown(
  sweep: SweepPoint[],
  breakdown: PerMalruleBreakdown[],
  n: number
): string {
  const defaultPoint = defaultMisattributionRate(sweep);
  const means = meansByThreshold(sweep);
  const recommended = recommendOperatingPoint(sweep);
  const recommendedAtDefaultConditions = sweep.find(
    (p) => p.threshold === recommended.threshold && p.obsCount === REFERENCE_OBS_COUNT && p.slipRate === REFERENCE_SLIP_RATE
  )!;

  const meansTable = `| Threshold | Mean held-out misattribution | Mean in-library abstention (cost) | Mean in-library confident-correct |\n|---|---|---|---|\n${means
    .map(
      (m) =>
        `| ${m.threshold} | ${pct(m.meanHeldOutMisattributionRate)} | ${pct(m.meanInLibraryAbstentionRate)} | ${pct(m.meanInLibraryConfidentCorrectRate)} |`
    )
    .join("\n")}`;

  const conditionSections = OBS_COUNTS.map((obsCount) =>
    SLIP_RATES.map(
      (slipRate) =>
        `**Observations: ${obsCount}, injected slip: ${pct(slipRate)}**\n\n${renderConditionTable(sweep, obsCount, slipRate)}`
    ).join("\n\n")
  ).join("\n\n");

  const breakdownTable = `| Malrule (held out) | Category | Misattribution rate | Abstention rate | Usually misattributed to |\n|---|---|---|---|---|\n${breakdown
    .map(
      (r) =>
        `| ${r.malruleId} | ${r.category} | ${pct(r.misattributionRate)} | ${pct(r.abstentionRate)} | ${r.topMisattributedTo ? `${r.topMisattributedTo} (${pct(r.topMisattributedToRate)} of trials)` : "n/a"} |`
    )
    .join("\n")}`;

  return `Leave-one-out: for each of the ${n} malrules, its own predicted answers are
used to generate held-out "student" observations (read directly from that
malrule's column in the committed index), the malrule is then **removed
from the candidate set**, and diagnosis runs on the remaining malrules in
its category. There is no "correct" outcome available by construction --
the engine either abstains ("no systematic pattern detected") or
confidently names some other, wrong, in-library malrule (a
misattribution). Held-out abstention rate and held-out misattribution rate
therefore always sum to 100%; this experiment measures how that split
moves, not a third "correct" outcome.

Swept across abstention threshold (the parameter exposed in this phase) x
injected slip rate {0%, 5%, 10%, 20%} x observation count {3, 5, 10}, 30
trials per (malrule, condition) combination.

**At the engine's shipped default (threshold=${DEFAULT_ABSTENTION_THRESHOLD}, clean data, 5 observations):
misattribution rate = ${pct(defaultPoint.heldOutMisattributionRate)}** (n=${defaultPoint.n}). More than
one in ${Math.round(1 / defaultPoint.heldOutMisattributionRate)} times a held-out procedure is confidently
misdiagnosed as some other, wrong, in-library malrule rather than flagged
as unrecognized.

### Tradeoff curve (mean across all 12 tested observation-count x slip-rate conditions)

${meansTable}

Raising the threshold from the default (1.0) to 2.0 roughly halves mean
held-out misattribution (${pct(means.find((m) => m.threshold === 1)!.meanHeldOutMisattributionRate)} ->
${pct(means.find((m) => m.threshold === 2)!.meanHeldOutMisattributionRate)}) while mean in-library abstention
cost rises from ${pct(means.find((m) => m.threshold === 1)!.meanInLibraryAbstentionRate)} to
${pct(means.find((m) => m.threshold === 2)!.meanInLibraryAbstentionRate)}. Beyond threshold=3, in-library
coverage collapses (mean abstention ${pct(means.find((m) => m.threshold === 3)!.meanInLibraryAbstentionRate)}+), so
higher thresholds are not viable at any observation count tested.

### Full sweep, by observation count and injected slip rate

${conditionSections}

### Per-malrule breakdown (at the default threshold, clean data, 5 observations; near-twins named)

${breakdownTable}

Several pairs above are near-twins in this library, each other's most
common misattribution target in both directions: \`decimals.ignore_decimal_point\`
<-> \`decimals.whole_number_thinking\`, \`fractions.natural_number_bias_numerator_only\`
<-> \`fractions.denominator_comparison_error\`. A cluster of five subtraction
malrules (\`diff_0_n_equals_n\`, \`smaller_from_larger\`, \`stops_borrow_at_zero\`,
\`borrow_from_bottom\`, \`borrow_no_decrement\`) also confuse each other
substantially, though less totally than the pairs above. Several
malrules in multiplication/division and two in fractions are never
misattributed to at this operating point -- they are structurally
distinctive within their category.

### Recommended operating point

**abstentionThreshold = ${recommended.threshold}** (selected as the largest grid value whose mean
in-library abstention cost stays at or under 15%, chosen before looking at
the misattribution side of the curve). At this threshold, mean held-out
misattribution is ${pct(recommended.meanHeldOutMisattributionRate)} (vs. ${pct(means.find((m) => m.threshold === 1)!.meanHeldOutMisattributionRate)} at
the shipped default) and mean in-library abstention cost is
${pct(recommended.meanInLibraryAbstentionRate)} (vs. ${pct(means.find((m) => m.threshold === 1)!.meanInLibraryAbstentionRate)} at the
default). At the reference condition alone (clean data, 5 observations):
held-out misattribution ${pct(recommendedAtDefaultConditions.heldOutMisattributionRate)}, in-library abstention
cost ${pct(recommendedAtDefaultConditions.inLibraryAbstentionRate)}. **This is a real cost, not a free
improvement** -- it is stated explicitly, not hidden: raising the
threshold trades some in-library coverage for meaningfully less confident
misdiagnosis of out-of-library procedures. The engine ships with
${DEFAULT_ABSTENTION_THRESHOLD} as its default; this recommendation is for deployments where an
occasional "no pattern detected" on a real in-library case is a more
acceptable failure mode than a confident wrong diagnosis of an
out-of-library one.`;
}
