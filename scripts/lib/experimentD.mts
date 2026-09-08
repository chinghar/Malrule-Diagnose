// Experiment D -- ceiling analysis and error decomposition.
//
// Two ceiling measurements, both against the collision structure exposed by
// Experiment B:
//
// 1. MRA ceiling (directly comparable to the reported 92.8% cross-template
//    figure). In MRA's single-clean-observation setup, the true malrule's
//    own observation always scores logStay while any disagreeing malrule
//    scores logSlip < logStay -- so the true malrule can never be strictly
//    OUTSCORED, only tied by a malrule that happens to predict the exact
//    same answer on that one instance. That gives a hard, provable FLOOR:
//    "not tied" guarantees a correct top-1 regardless of tie-break policy,
//    so no method can do *worse* than that floor by bad luck alone.
//
//    It does NOT give a ceiling in the usual sense, and empirically it
//    doesn't: measured accuracy (92.8%) is HIGHER than the not-tied floor,
//    because diagnose() breaks ties alphabetically by malrule id, and on a
//    meaningful fraction of tied trials that arbitrary rule happens to pick
//    the true malrule anyway. So part of the reported 92.8% is not "the
//    engine correctly identified the malrule" in the confident-evidence
//    sense -- it's a coin flip (well, an alphabetical flip) that landed
//    right. This module reports all three numbers: the floor, the measured
//    figure, and the expected accuracy under UNIFORM RANDOM tie-breaking
//    (an unbiased estimate of what a non-alphabetical policy would show),
//    so the reader can see how much of 92.8% is genuinely load-bearing
//    evidence versus tie-break luck.
//
// 2. Slip-rate ceiling (extends the "at each slip rate" requirement to the
//    (a)/(b) sweep, which is where slip rate actually varies across
//    multiple observations). Re-runs the exact same trials as the (a)/(b)
//    sweep (same seeds, via scripts/lib/sweep.mts) but with the model slip
//    rate matched exactly to the true injected rate -- zero misspecification,
//    i.e. the Bayes-optimal decision under this exact generative model. The
//    gap between that oracle ceiling and the actually-reported figure (fixed
//    assumed slip rate 0.15) isolates how much shortfall is attributable to
//    not knowing the true slip rate in advance, as opposed to collision
//    structure or slip noise itself.

import { diagnose } from "../../lib/diagnose/diagnose.ts";
import { CATEGORIES, MODEL_SLIP_RATE, pct } from "./data.mts";
import { runSweep, INJECTED_SLIP_RATES, type SweepCell } from "./sweep.mts";

const ORACLE_EPSILON = 0.001; // stand-in for "0% slip" -- diagnose() requires slipRate in (0, 1)
const REFERENCE_OBS_COUNT = 5;

// ---------------------------------------------------------------------------
// 1. MRA ceiling / floor
// ---------------------------------------------------------------------------

export interface MraCeilingResult {
  n: number;
  /** Fraction NOT tied -- guaranteed correct under any tie-break policy. A hard floor, not a ceiling. */
  floor: number;
  /** Fraction where top1 === true malrule, using the engine's actual alphabetical tie-break. This is the reported 92.8% figure. */
  measured: number;
  /** Expected accuracy under uniform-random tie-breaking instead of alphabetical: floor + sum(1/k) over tied trials, k = tie size. Unbiased estimate, not dependent on malrule id spelling. */
  expectedUnderFairTiebreak: number;
  tiedTrialCount: number;
}

/**
 * Recomputes the cross-template MRA floor and measured accuracy together,
 * over the identical trial set measurement (c) uses (every worked-mistake
 * instance A with a valid cross-template partner B), so the comparison to
 * 92.8% is apples to apples.
 */
export function runMraCeiling(): MraCeilingResult {
  let n = 0;
  let notTied = 0;
  let top1Correct = 0;
  let tiedTrialCount = 0;
  let fairTiebreakCreditSum = 0;

  for (const cat of CATEGORIES) {
    for (const mr of cat.malrules) {
      const worked = cat.instances.filter((i) => i.native_malrule_id === mr.id);
      for (const A of worked) {
        const hasCrossTemplateB = cat.instances.some(
          (b) => b.template !== A.template && b.predictions[mr.id] !== undefined
        );
        if (!hasCrossTemplateB) continue;

        const answer = A.predictions[mr.id];
        if (answer === undefined) continue;
        const result = diagnose([{ instanceId: A.instance_id, studentAnswer: answer }], cat.instances, cat.malrules, MODEL_SLIP_RATE);

        n += 1;
        if (result.tiedTop.length === 1) {
          notTied += 1;
          fairTiebreakCreditSum += 1; // guaranteed correct regardless of tie-break policy
        } else {
          tiedTrialCount += 1;
          // The true malrule is always among the tied leaders in this setup
          // (it can never be strictly beaten -- see module comment), so its
          // expected credit under a uniform-random tie-break is 1/k.
          fairTiebreakCreditSum += 1 / result.tiedTop.length;
        }
        if (result.ranked[0]?.malruleId === mr.id) top1Correct += 1;
      }
    }
  }

  return {
    n,
    floor: notTied / n,
    measured: top1Correct / n,
    expectedUnderFairTiebreak: fairTiebreakCreditSum / n,
    tiedTrialCount,
  };
}

// ---------------------------------------------------------------------------
// 2. Slip-rate ceiling and error decomposition, at the reference observation
//    count used throughout the rest of the evaluation.
// ---------------------------------------------------------------------------

export interface SlipRateDecompositionRow {
  slipRate: number;
  measured: number; // fixed model slip rate 0.15, regardless of true rate -- what's actually reported
  ceiling: number; // oracle: model slip rate == true injected rate exactly
  structuralCeiling: number; // ceiling(0) -- the pure collision-only ceiling, same for every row
  collisionDrivenError: number; // 1 - structuralCeiling
  slipDrivenError: number; // structuralCeiling - ceiling(s)
  otherError: number; // ceiling(s) - measured(s) -- attributable to assuming the wrong slip rate
  totalError: number; // 1 - measured(s)
}

export function runSlipRateCeiling(): SlipRateDecompositionRow[] {
  const measuredSweep = runSweep(); // fixed MODEL_SLIP_RATE, unchanged from (a)/(b)
  const oracleSweep = runSweep((injected) => (injected > 0 ? injected : ORACLE_EPSILON));

  const findCell = (sweep: SweepCell[], s: number): SweepCell => {
    const cell = sweep.find((c) => c.injectedSlipRate === s && c.obsCount === REFERENCE_OBS_COUNT);
    if (!cell) throw new Error(`Missing sweep cell for slipRate=${s}, obsCount=${REFERENCE_OBS_COUNT}`);
    return cell;
  };

  const structuralCeiling = findCell(oracleSweep, 0).top1;

  return INJECTED_SLIP_RATES.map((s) => {
    const measured = findCell(measuredSweep, s).top1;
    const ceiling = findCell(oracleSweep, s).top1;
    return {
      slipRate: s,
      measured,
      ceiling,
      structuralCeiling,
      collisionDrivenError: 1 - structuralCeiling,
      slipDrivenError: structuralCeiling - ceiling,
      otherError: ceiling - measured,
      totalError: 1 - measured,
    };
  });
}

export function renderMarkdown(mra: MraCeilingResult, decomposition: SlipRateDecompositionRow[]): string {
  const decompTable = `| True slip rate | Measured (fixed model, reported figure) | Ceiling (oracle-calibrated) | Structural ceiling (collision-only) | Collision-driven error | Slip-driven error | Other (misspecification) error | Total error |\n|---|---|---|---|---|---|---|---|\n${decomposition
    .map(
      (r) =>
        `| ${pct(r.slipRate)} | ${pct(r.measured)} | ${pct(r.ceiling)} | ${pct(r.structuralCeiling)} | ${pct(r.collisionDrivenError)} | ${pct(r.slipDrivenError)} | ${pct(r.otherError)} | ${pct(r.totalError)} |`
    )
    .join("\n")}`;

  return `### MRA ceiling: what the 92.8% figure is actually made of

In MRA's single-clean-observation setup, the true malrule's own observed
answer always scores strictly higher (\`logStay\`) than any disagreeing
malrule (\`logSlip\`) -- so the true malrule can never be strictly
*outscored*, only *tied* by a malrule that happens to predict the exact
same answer on that one instance. That gives a hard, provable **floor**:
"not tied" guarantees a correct top-1 regardless of tie-break policy.

It is a floor, not a ceiling, and the numbers show why that distinction
matters: measured accuracy is *higher* than the floor, because
\`diagnose()\` breaks ties alphabetically by malrule id, and on a real
fraction of tied trials that arbitrary rule happens to land on the true
malrule anyway.

| | Value |
|---|---|
| Floor (guaranteed correct, any tie-break policy) | **${pct(mra.floor)}** |
| Expected under fair (uniform-random) tie-break | **${pct(mra.expectedUnderFairTiebreak)}** |
| Measured (actual, alphabetical tie-break) -- the reported cross-template MRA figure | **${pct(mra.measured)}** |
| Tied trials | ${mra.tiedTrialCount}/${mra.n} (${pct(mra.tiedTrialCount / mra.n)}) |

**${pct(mra.tiedTrialCount / mra.n)} of MRA cross-template trials are genuinely ambiguous** --
the single piece of evidence given supports two or more malrules equally,
and no method, however clever, can do better than a guess on those specific
trials. Under fair random tie-breaking the expected figure would be
${pct(mra.expectedUnderFairTiebreak)}, not ${pct(mra.measured)}; the gap between those two numbers
(${pct(mra.measured - mra.expectedUnderFairTiebreak)}) is alphabetical-ordering luck, not additional evidence.
**${pct(mra.measured)} should not be read as "the engine is almost always
confident and right" -- a meaningful share of it is a coin flip that
happened to land favorably.**

### Slip-rate ceiling and error decomposition

Extends the ceiling question to the (a)/(b) sweep, where slip rate
actually varies across multiple observations. Re-runs the identical
trials as (a)/(b) (same seeds) with the model's assumed slip rate matched
exactly to the true injected rate -- the Bayes-optimal decision under this
exact generative model, i.e. the best any method could do with zero
misspecification. Reference observation count: 5.

${decompTable}

Collision-driven error is constant (${pct(decomposition[0]!.collisionDrivenError)}) at every slip rate, exactly
matching Experiment B's structural findings. Slip-driven error grows with
the true slip rate, as expected. **Misspecification error -- the cost of
the engine's fixed assumed slip rate (0.15) not matching the true rate --
is negligible at every slip rate tested** (at most ${pct(Math.max(...decomposition.map((r) => Math.abs(r.otherError))))}):
the deliberate design choice to not calibrate to an unknown true slip rate
costs almost nothing in practice, which is a direct empirical test of that
design decision rather than an assumption.`;
}
