// Phase 3 -- measuring the trade `includeNullHypothesis` offers, in both
// directions. Phase 2 added the "correct student, wrong answers are slips"
// candidate behind this parameter, default OFF. It WILL reduce Experiment
// E's false-positive rate -- that is not, by itself, a result to headline;
// it is one half of a trade that is not complete until the cost (reduced
// sensitivity on genuine malrule students) is measured and reported
// alongside the benefit, at the same rigor.

import { diagnose, DEFAULT_ABSTENTION_THRESHOLD, NULL_HYPOTHESIS_ID } from "../../lib/diagnose/diagnose.ts";
import { hashString, mulberry32, simulateObservations } from "../../lib/diagnose/testSupport.ts";
import { runHeldOutTrial } from "./experimentA.mts";
import { STUDENT_SPECS, generateObservations, type StudentSpec } from "./experimentE.mts";
import { CATEGORIES, MODEL_SLIP_RATE, pct } from "./data.mts";
import { fmtWilsonFromRate, fmtCluster } from "./stats.mts";

const REFERENCE_OBS_COUNT = 5;
const OBS_COUNTS = [3, 5, 10];
const SLIP_RATES = [0, 0.05, 0.1, 0.2];
const E_TRIALS_PER_CATEGORY = 200; // matches Experiment E
const SENS_TRIALS_PER_MALRULE = 30; // matches Experiment A's per-malrule trial count
const A_TRIALS_PER_MALRULE = 30; // matches Experiment A

// The three subtraction malrules Phase 1 found with the highest
// non-triggering exposure (53.8%, 41.1%, 34.4%) -- the same cluster round 2
// identified as driving nearly all of Experiment E's false positives.
export const WORST_SUBTRACTION_MALRULES = [
  "subtraction.stops_borrow_at_zero",
  "subtraction.diff_0_n_equals_n",
  "subtraction.always_borrow_left",
];

// ---------------------------------------------------------------------------
// Benefit: false-positive rate, ON vs OFF, Experiment E's student types.
// "False positive" (both ON and OFF) means: the engine did not abstain, AND
// the leading candidate is a malrule, not the null hypothesis. With the null
// hypothesis ON, a fully-correct student who used to be misdiagnosed with a
// malrule may now instead be confidently diagnosed as "no misconception" --
// tracked here as a separate `nullWinsRate`, never folded into the
// false-positive count in either direction.
// ---------------------------------------------------------------------------

export interface BenefitRow {
  specLabel: string;
  n: number;
  fpRateOff: number;
  fpRateOn: number;
  nullWinsOn: number; // rate at which the null hypothesis is the confident leader, ON only (0 by construction OFF)
}

function classify(result: ReturnType<typeof diagnose>): "abstained" | "malrule" | "null" {
  if (result.noPatternDetected || result.ranked.length === 0) return "abstained";
  return result.ranked[0]!.malruleId === NULL_HYPOTHESIS_ID ? "null" : "malrule";
}

function runBenefitOne(spec: StudentSpec): BenefitRow {
  let n = 0;
  let fpOff = 0;
  let fpOn = 0;
  let nullWinsOn = 0;

  for (const cat of CATEGORIES) {
    for (let trial = 0; trial < E_TRIALS_PER_CATEGORY; trial++) {
      // Same seed convention as Experiment E's own runOne/runByCategory, so
      // the OFF column is byte-identical to the published section 2 figures.
      const rng = mulberry32(hashString(`expE:${spec.label}:${DEFAULT_ABSTENTION_THRESHOLD}:${REFERENCE_OBS_COUNT}:${cat.category}:${trial}`));
      const obs = generateObservations(cat, spec, REFERENCE_OBS_COUNT, rng);
      n += 1;

      const off = diagnose(obs, cat.instances, cat.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD, "logLikelihood", false);
      if (classify(off) === "malrule") fpOff += 1;

      const on = diagnose(obs, cat.instances, cat.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD, "logLikelihood", true);
      const onClass = classify(on);
      if (onClass === "malrule") fpOn += 1;
      if (onClass === "null") nullWinsOn += 1;
    }
  }

  return { specLabel: spec.label, n, fpRateOff: fpOff / n, fpRateOn: fpOn / n, nullWinsOn: nullWinsOn / n };
}

export function runBenefitByStudentType(): BenefitRow[] {
  return STUDENT_SPECS.map(runBenefitOne);
}

export interface BenefitByCategory {
  category: string;
  n: number;
  fpRateOff: number;
  fpRateOn: number;
}

/** Per-category benefit for the headline "(a) fully correct" student type. */
export function runBenefitByCategory(): BenefitByCategory[] {
  const spec = STUDENT_SPECS.find((s) => s.kind === "a_fully_correct")!;
  return CATEGORIES.map((cat) => {
    let n = 0;
    let fpOff = 0;
    let fpOn = 0;
    for (let trial = 0; trial < E_TRIALS_PER_CATEGORY; trial++) {
      // Same seed convention as Experiment E's own runOne/runByCategory, so
      // the OFF column is byte-identical to the published section 2 figures.
      const rng = mulberry32(hashString(`expE:${spec.label}:${DEFAULT_ABSTENTION_THRESHOLD}:${REFERENCE_OBS_COUNT}:${cat.category}:${trial}`));
      const obs = generateObservations(cat, spec, REFERENCE_OBS_COUNT, rng);
      n += 1;
      const off = diagnose(obs, cat.instances, cat.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD, "logLikelihood", false);
      if (classify(off) === "malrule") fpOff += 1;
      const on = diagnose(obs, cat.instances, cat.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD, "logLikelihood", true);
      if (classify(on) === "malrule") fpOn += 1;
    }
    return { category: cat.category, n, fpRateOff: fpOff / n, fpRateOn: fpOn / n };
  });
}

// ---------------------------------------------------------------------------
// Cost (a)/(b): sensitivity loss on GENUINE malrule students, ON vs OFF, per
// category x obsCount, and separately restricted to the 3 worst-exposure
// subtraction malrules. "Sensitivity" = top-1 accuracy (engine names the
// true malrule). A loss can show up two ways: the null hypothesis steals
// the top rank (see cost (d), miss rate, below), or the extra candidate
// changes the tie-break/normalization enough to demote the true malrule
// without the null hypothesis itself winning.
// ---------------------------------------------------------------------------

export interface SensitivityRow {
  category: string;
  obsCount: number;
  n: number;
  top1Off: number;
  top1On: number;
  missRateOn: number; // subset of the on/off gap specifically attributable to the null hypothesis winning
}

function runSensitivitySet(malruleFilter?: (id: string) => boolean): SensitivityRow[] {
  const rows: SensitivityRow[] = [];
  for (const cat of CATEGORIES) {
    const malrules = malruleFilter ? cat.malrules.filter((m) => malruleFilter(m.id)) : cat.malrules;
    if (malrules.length === 0) continue;
    for (const obsCount of OBS_COUNTS) {
      let n = 0;
      let top1Off = 0;
      let top1On = 0;
      let missOn = 0;
      for (const mr of malrules) {
        for (let trial = 0; trial < SENS_TRIALS_PER_MALRULE; trial++) {
          const seed = hashString(`nullSens:${mr.id}:${obsCount}:${trial}`);
          const rng = mulberry32(seed);
          const obs = simulateObservations(mr.id, cat.instances, obsCount, 0, rng);
          if (obs.length < obsCount) continue;
          n += 1;

          const off = diagnose(obs, cat.instances, cat.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD, "logLikelihood", false);
          if (off.ranked[0]?.malruleId === mr.id) top1Off += 1;

          const on = diagnose(obs, cat.instances, cat.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD, "logLikelihood", true);
          if (on.ranked[0]?.malruleId === mr.id) top1On += 1;
          if (on.ranked[0]?.malruleId === NULL_HYPOTHESIS_ID) missOn += 1;
        }
      }
      rows.push({ category: cat.category, obsCount, n, top1Off: top1Off / n, top1On: top1On / n, missRateOn: missOn / n });
    }
  }
  return rows;
}

/** Cost (a): all 26 malrules, per category x obsCount {3,5,10}, clean data. */
export function runSensitivityCost(): SensitivityRow[] {
  return runSensitivitySet();
}

/** Cost (b): restricted to the 3 highest-non-triggering-exposure subtraction malrules. */
export function runSensitivityCostWorstThree(): SensitivityRow[] {
  return runSensitivitySet((id) => WORST_SUBTRACTION_MALRULES.includes(id));
}

// ---------------------------------------------------------------------------
// Cost (c)/(d): sensitivity and miss rate vs injected slip rate, across all
// 26 malrules pooled, at the reference observation count.
// ---------------------------------------------------------------------------

export interface SlipRateRow {
  slipRate: number;
  n: number;
  top1Off: number;
  top1On: number;
  missRateOff: number; // by construction 0 (no null hypothesis without includeNullHypothesis)
  missRateOn: number;
}

export function runSensitivityVsSlipRate(): SlipRateRow[] {
  return SLIP_RATES.map((slipRate) => {
    let n = 0;
    let top1Off = 0;
    let top1On = 0;
    let missOn = 0;

    for (const cat of CATEGORIES) {
      for (const mr of cat.malrules) {
        for (let trial = 0; trial < SENS_TRIALS_PER_MALRULE; trial++) {
          const seed = hashString(`nullSensSlip:${mr.id}:${slipRate}:${trial}`);
          const rng = mulberry32(seed);
          const obs = simulateObservations(mr.id, cat.instances, REFERENCE_OBS_COUNT, slipRate, rng);
          if (obs.length < REFERENCE_OBS_COUNT) continue;
          n += 1;

          const off = diagnose(obs, cat.instances, cat.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD, "logLikelihood", false);
          if (off.ranked[0]?.malruleId === mr.id) top1Off += 1;

          const on = diagnose(obs, cat.instances, cat.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD, "logLikelihood", true);
          if (on.ranked[0]?.malruleId === mr.id) top1On += 1;
          if (on.ranked[0]?.malruleId === NULL_HYPOTHESIS_ID) missOn += 1;
        }
      }
    }

    return { slipRate, n, top1Off: top1Off / n, top1On: top1On / n, missRateOff: 0, missRateOn: missOn / n };
  });
}

// ---------------------------------------------------------------------------
// Interaction: re-run leave-one-out (Experiment A) with the null hypothesis
// ON -- does it absorb held-out (out-of-library) procedures into "no
// misconception" rather than abstaining or misattributing to an in-library
// malrule? Same reference condition as Experiment A (clean data, shipped
// default threshold), swept across the same observation counts.
// ---------------------------------------------------------------------------

export interface InteractionRow {
  obsCount: number;
  n: number;
  abstainedOff: number;
  misattributedOff: number;
  abstainedOn: number;
  misattributedOn: number;
  absorbedByNullOn: number;
}

export function runInteractionLeaveOneOut(): InteractionRow[] {
  const slipRate = 0;
  const threshold = DEFAULT_ABSTENTION_THRESHOLD;

  return OBS_COUNTS.map((obsCount) => {
    let n = 0;
    let abstainedOff = 0;
    let misattributedOff = 0;
    let abstainedOn = 0;
    let misattributedOn = 0;
    let absorbedOn = 0;

    for (const cat of CATEGORIES) {
      for (const mr of cat.malrules) {
        for (let trial = 0; trial < A_TRIALS_PER_MALRULE; trial++) {
          const rngOff = mulberry32(hashString(`heldout:${mr.id}:${slipRate}:${obsCount}:${threshold}:${trial}`));
          const off = runHeldOutTrial(mr, cat, obsCount, slipRate, threshold, rngOff, false);
          if (off) {
            n += 1;
            if (off.abstained) abstainedOff += 1;
            else misattributedOff += 1;
          }

          const rngOn = mulberry32(hashString(`heldout:${mr.id}:${slipRate}:${obsCount}:${threshold}:${trial}`));
          const on = runHeldOutTrial(mr, cat, obsCount, slipRate, threshold, rngOn, true);
          if (on) {
            if (on.abstained) abstainedOn += 1;
            else if (on.misattributedTo === NULL_HYPOTHESIS_ID) absorbedOn += 1;
            else misattributedOn += 1;
          }
        }
      }
    }

    return {
      obsCount,
      n,
      abstainedOff: abstainedOff / n,
      misattributedOff: misattributedOff / n,
      abstainedOn: abstainedOn / n,
      misattributedOn: misattributedOn / n,
      absorbedByNullOn: absorbedOn / n,
    };
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderMarkdown(): string {
  const benefit = runBenefitByStudentType();
  const benefitByCat = runBenefitByCategory();
  const sensAll = runSensitivityCost();
  const sensWorst3 = runSensitivityCostWorstThree();
  const vsSlip = runSensitivityVsSlipRate();
  const interaction = runInteractionLeaveOneOut();

  const fullyCorrect = benefit.find((b) => b.specLabel === "(a) fully correct, 0% slip")!;

  const benefitTable = `| Student type | n | FP rate OFF | FP rate ON | Null-hypothesis-wins rate (ON) |\n|---|---|---|---|---|\n${benefit
    .map((b) => `| ${b.specLabel} | ${b.n} | ${fmtWilsonFromRate(b.fpRateOff, b.n)} | ${fmtWilsonFromRate(b.fpRateOn, b.n)} | ${pct(b.nullWinsOn)} |`)
    .join("\n")}`;

  const benefitByCatTable = `| Category | n | FP rate OFF | FP rate ON |\n|---|---|---|---|\n${benefitByCat
    .map((c) => `| ${c.category} | ${c.n} | ${fmtWilsonFromRate(c.fpRateOff, c.n)} | ${fmtWilsonFromRate(c.fpRateOn, c.n)} |`)
    .join("\n")}`;
  const catClusterOff = fmtCluster(benefitByCat.map((c) => c.fpRateOff), "category");
  const catClusterOn = fmtCluster(benefitByCat.map((c) => c.fpRateOn), "category");

  const sensTable = (rows: SensitivityRow[]) =>
    `| Category | obsCount | n | Top-1 OFF | Top-1 ON | Miss rate (null wins) ON |\n|---|---|---|---|---|---|\n${rows
      .map((r) => `| ${r.category} | ${r.obsCount} | ${r.n} | ${pct(r.top1Off)} | ${pct(r.top1On)} | ${pct(r.missRateOn)} |`)
      .join("\n")}`;

  const slipTable = `| Injected slip | n | Top-1 OFF | Top-1 ON | Miss rate ON |\n|---|---|---|---|---|\n${vsSlip
    .map((r) => `| ${pct(r.slipRate)} | ${r.n} | ${pct(r.top1Off)} | ${pct(r.top1On)} | ${pct(r.missRateOn)} |`)
    .join("\n")}`;

  const interactionTable = `| obsCount | n | Abstained OFF | Misattributed OFF | Abstained ON | Misattributed ON | Absorbed by null ON |\n|---|---|---|---|---|---|---|\n${interaction
    .map(
      (r) =>
        `| ${r.obsCount} | ${r.n} | ${pct(r.abstainedOff)} | ${pct(r.misattributedOff)} | ${pct(r.abstainedOn)} | ${pct(r.misattributedOn)} | ${pct(r.absorbedByNullOn)} |`
    )
    .join("\n")}`;

  const worstMean = (rows: SensitivityRow[], key: "top1Off" | "top1On") =>
    rows.reduce((s, r) => s + r[key], 0) / rows.length;
  const allMean = (rows: SensitivityRow[], key: "top1Off" | "top1On") =>
    rows.reduce((s, r) => s + r[key], 0) / rows.length;

  const ref5 = sensAll.filter((r) => r.obsCount === REFERENCE_OBS_COUNT);
  const ref5Worst3 = sensWorst3.filter((r) => r.obsCount === REFERENCE_OBS_COUNT);

  return `\`includeNullHypothesis\` (default false; Phase 2) adds a "correct
student, wrong answers are slips" candidate to \`diagnose()\`'s candidate
set, scored by the identical slip-rate noise model as every malrule, with
no special prior, bonus, or tie-break advantage beyond the same rules every
malrule is already subject to (see \`NULL_HYPOTHESIS_ID\`'s doc comment in
\`lib/diagnose/diagnose.ts\`). "Null hypothesis wins" (a confident,
in-the-clear "no misconception" diagnosis) and \`noPatternDetected\`
(abstention: insufficient evidence for anything) are reported below as
**separate, non-overlapping events** -- never merged.

**One caveat on the tie-break, found while verifying this feature, reported
transparently rather than adjusted for:** the existing sort tie-break is
alphabetical by malrule id (unchanged, applied identically to every
candidate). Because \`"null_hypothesis"\` happens to sort after \`decimals\`,
\`fractions\`, and \`multiplication_division\` but before \`subtraction\`, a
tie between the null hypothesis and a subtraction malrule resolves in the
null hypothesis's favor, while a tie against the other three categories
resolves in the malrule's favor. This was not chosen to produce that
result -- renaming the constant would change which categories benefit from
ties -- but it is a real, non-obvious asymmetry, disclosed here rather than
tuned away.

### Benefit: false-positive rate, Experiment E's student types, ON vs OFF

${benefitTable}

**Fully correct students: false-positive rate falls from ${fmtWilsonFromRate(fullyCorrect.fpRateOff, fullyCorrect.n)} to
${fmtWilsonFromRate(fullyCorrect.fpRateOn, fullyCorrect.n)}**, with the null hypothesis winning outright on
${pct(fullyCorrect.nullWinsOn)} of trials. This is the direct fix for round 2's
headline finding and Phase 1's contamination audit (which traced that 18%
figure entirely to non-triggering coincidences). Per category, since round
2 already established the effect is subtraction-specific, not uniform:

${benefitByCatTable}

Between-category interval, OFF: ${catClusterOff}; ON: ${catClusterOn}.

### Cost (a): sensitivity on GENUINE malrule students, all 26 malrules, clean data

${sensTable(ref5)}

Mean top-1 across all category x obsCount cells (obsCount 3/5/10 pooled):
OFF ${pct(allMean(sensAll, "top1Off"))}, ON ${pct(allMean(sensAll, "top1On"))}.

Full obsCount sweep:

${sensTable(sensAll)}

### Cost (b): restricted to the 3 highest-non-triggering-exposure subtraction malrules

(\`${WORST_SUBTRACTION_MALRULES.join("`, `")}\` -- Phase 1's 53.8%/41.1%/34.4% exposure cluster, the same
malrules driving nearly all of Experiment E's false positives.)

${sensTable(ref5Worst3)}

Mean top-1 on this cluster specifically (obsCount 3/5/10 pooled): OFF
${pct(worstMean(sensWorst3, "top1Off"))}, ON ${pct(worstMean(sensWorst3, "top1On"))}. This is where the
cost of turning the null hypothesis on concentrates: these are exactly the
malrules whose own genuine evidence looks most like "probably correct" by
construction (highest non-triggering exposure), so they are also the
malrules most likely to lose ground to the null hypothesis on real students.

Full obsCount sweep:

${sensTable(sensWorst3)}

### Cost (c)/(d): sensitivity and miss rate vs. injected slip rate (all 26 malrules, ${REFERENCE_OBS_COUNT} observations)

${slipTable}

"Miss rate" (cost (d)) is the fraction of genuine-malrule trials where the
engine's confident top-ranked answer is "no misconception" instead of the
student's actual malrule -- a real diagnostic miss, not an abstention. It
rises with slip rate ON (a noisier genuine-malrule student increasingly
resembles a correct-but-slipping one), and is exactly 0 OFF by construction
(the null hypothesis cannot win a candidate set it is never added to).

### Interaction: leave-one-out (Experiment A/H) with the null hypothesis ON

${interactionTable}

**${pct(interaction.find((r) => r.obsCount === REFERENCE_OBS_COUNT)!.absorbedByNullOn)} of held-out (out-of-library) trials at
${REFERENCE_OBS_COUNT} observations are absorbed into "no misconception" rather than
abstaining or being misattributed to some other in-library malrule**, when
the null hypothesis is ON. This is a second-order effect worth naming
plainly: a student running a genuinely novel, undocumented misconception
(one MalruleLib does not encode) can be told they have no misconception at
all, if their wrong answers happen to look more "correct-plus-slips" than
they look like any single in-library malrule. This does not show up as a
misattribution (a specific wrong malrule named) or as the honest "no
pattern detected" abstention -- it is a third, distinct failure mode this
parameter introduces, and it did not exist when \`includeNullHypothesis\`
is OFF.

### Recommended operating point

Turning \`includeNullHypothesis\` ON is a net improvement specifically for
the round-2 headline problem (correct subtraction students being
confidently misdiagnosed) and should be considered ON for that reason, but
it is **not a free fix**: it costs measurable sensitivity concentrated on
the same three subtraction malrules that most needed the null hypothesis's
protection in the first place (cost (b) above), and it introduces a new,
previously-nonexistent way for a genuinely novel out-of-library procedure
to be told "no misconception" instead of flagged as unrecognized (the
interaction result above). One sentence per direction: **the benefit is
that a correct subtraction student is no longer routinely told they have a
wrong-procedure misconception they do not have; the cost is that a real
subtraction-malrule student, and separately a student with a genuinely
novel out-of-library bug, both become somewhat more likely to be told
"no misconception" when they do, in fact, have one.**`;
}
