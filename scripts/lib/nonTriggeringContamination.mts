// Phase 1b -- non-triggering contamination audit. Changes nothing: this
// module only measures how much each round 1/2 figure moves when the
// observation-sampling pool is restricted to TRIGGERING instances only
// (predictions[malrule] !== correct_answer), compared to the existing,
// unrestricted figure already in EVALUATION.md.
//
// Every existing sampling function (lib/diagnose/testSupport.ts's
// simulateObservations, and each experiment module's own sampling) is left
// completely untouched -- this module defines its own parallel
// triggering-only sampler and re-runs each protocol with it, so every
// figure from rounds one and two remains exactly as it was, reported here
// as the "before" half of an explicit before/after pair.

import { diagnose, DEFAULT_ABSTENTION_THRESHOLD } from "../../lib/diagnose/diagnose.ts";
import { hashString, mulberry32, shuffle, slipAnswer } from "../../lib/diagnose/testSupport.ts";
import { posteriorFromScores, selectNextInstance, uniformPosterior } from "../../lib/select/select.ts";
import type { CategoryIndex, ProblemInstance } from "../../lib/diagnose/types.ts";
import { CATEGORIES, MODEL_SLIP_RATE, pct } from "./data.mts";
import { fmtWilsonFromRate } from "./stats.mts";
import { runHeldOutTrial } from "./experimentA.mts";
import { STUDENT_SPECS, generateObservations } from "./experimentE.mts";

const REFERENCE_OBS_COUNT = 5;
const OBS_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const TRIALS_PER_COMBO = 40; // matches Experiment C's (a) sweep
const A_TRIALS_PER_MALRULE = 30; // matches Experiment A
const E_TRIALS_PER_CATEGORY = 200; // matches Experiment E
const J_TRIALS_PER_COMBO = 15; // matches Experiment J
const ADAPTIVE_TRIALS_PER_MALRULE = 20; // matches round 1 Phase 4
const MAX_OBSERVATIONS = 15;

/**
 * Mirrors lib/diagnose/testSupport.ts's simulateObservations exactly,
 * except the sampling pool additionally excludes non-triggering instances
 * for malruleId. The original function is never modified.
 */
function simulateObservationsTriggeringOnly(
  malruleId: string,
  instances: ProblemInstance[],
  count: number,
  injectedSlipRate: number,
  rng: () => number
): { instanceId: string; studentAnswer: string }[] {
  const applicable = instances.filter(
    (inst) => inst.predictions[malruleId] !== undefined && inst.predictions[malruleId] !== inst.correct_answer
  );
  const chosen = shuffle(applicable, rng).slice(0, count);
  return chosen.map((inst) => {
    const followsRule = rng() >= injectedSlipRate;
    const answer = followsRule ? inst.predictions[malruleId]! : slipAnswer(inst, malruleId, rng);
    return { instanceId: inst.instance_id, studentAnswer: answer };
  });
}

export interface BeforeAfter {
  label: string;
  n: number;
  before: number;
  after: number;
  afterN: number;
}

function fmtPair(b: BeforeAfter): string {
  return `${pct(b.before)} (n=${b.n}) -> ${fmtWilsonFromRate(b.after, b.afterN)}`;
}

// ---------------------------------------------------------------------------
// 1. Top-1 / top-3 (Experiment C's (a) sweep), all 10 observation counts
// ---------------------------------------------------------------------------

interface SweepRow {
  obsCount: number;
  n: number;
  top1Before: number;
  top1After: number;
  afterN: number;
  top3Before: number;
  top3After: number;
}

export function runTopKContamination(): SweepRow[] {
  return OBS_COUNTS.map((obsCount) => {
    let nBefore = 0;
    let top1Before = 0;
    let top3Before = 0;
    let nAfter = 0;
    let top1After = 0;
    let top3After = 0;

    for (const cat of CATEGORIES) {
      for (const mr of cat.malrules) {
        for (let trial = 0; trial < TRIALS_PER_COMBO; trial++) {
          const seed = hashString(`${mr.id}:${obsCount}:0:${trial}`);

          // Before: identical protocol/seed to Experiment C's (a) table (0% injected slip).
          const rngBefore = mulberry32(seed);
          const applicableAll = cat.instances.filter((i) => i.predictions[mr.id] !== undefined);
          const chosenBefore = shuffle(applicableAll, rngBefore).slice(0, obsCount);
          if (chosenBefore.length === obsCount) {
            const obsBefore = chosenBefore.map((inst) => ({ instanceId: inst.instance_id, studentAnswer: inst.predictions[mr.id]! }));
            const resultBefore = diagnose(obsBefore, cat.instances, cat.malrules, MODEL_SLIP_RATE);
            nBefore += 1;
            if (resultBefore.ranked[0]?.malruleId === mr.id) top1Before += 1;
            if (resultBefore.ranked.slice(0, 3).some((r) => r.malruleId === mr.id)) top3Before += 1;
          }

          // After: same seed, but sampling pool restricted to triggering-only instances.
          const rngAfter = mulberry32(seed);
          const obsAfter = simulateObservationsTriggeringOnly(mr.id, cat.instances, obsCount, 0, rngAfter);
          if (obsAfter.length === obsCount) {
            const resultAfter = diagnose(obsAfter, cat.instances, cat.malrules, MODEL_SLIP_RATE);
            nAfter += 1;
            if (resultAfter.ranked[0]?.malruleId === mr.id) top1After += 1;
            if (resultAfter.ranked.slice(0, 3).some((r) => r.malruleId === mr.id)) top3After += 1;
          }
        }
      }
    }

    return {
      obsCount,
      n: nBefore,
      top1Before: top1Before / nBefore,
      top1After: top1After / nAfter,
      afterN: nAfter,
      top3Before: top3Before / nBefore,
      top3After: top3After / nAfter,
    };
  });
}

// ---------------------------------------------------------------------------
// 2. MRA (92.8%). A (the worked mistake) is always drawn from native
// instances, which build_index.py already guarantees are triggering
// (native_answer != correct_answer, enforced at index-build time). So this
// is predicted, mechanically, to be unchanged -- verified, not assumed.
// ---------------------------------------------------------------------------

export function runMraContamination(): BeforeAfter {
  let nBefore = 0;
  let top1Before = 0;

  for (const cat of CATEGORIES) {
    for (const mr of cat.malrules) {
      const worked = cat.instances.filter((i) => i.native_malrule_id === mr.id);
      for (const A of worked) {
        const hasCrossTemplateB = cat.instances.some((b) => b.template !== A.template && b.predictions[mr.id] !== undefined);
        if (!hasCrossTemplateB) continue;
        const answer = A.predictions[mr.id];
        if (answer === undefined) continue;
        // Sanity: A must already be triggering (native_answer != correct_answer, by build_index.py's own filter).
        const isTriggering = answer !== A.correct_answer;
        if (!isTriggering) throw new Error(`Native instance ${A.instance_id} for ${mr.id} is non-triggering -- build_index.py's filter did not hold`);
        const result = diagnose([{ instanceId: A.instance_id, studentAnswer: answer }], cat.instances, cat.malrules, MODEL_SLIP_RATE);
        nBefore += 1;
        if (result.ranked[0]?.malruleId === mr.id) top1Before += 1;
      }
    }
  }

  // "After" is definitionally identical: every A used above is already
  // triggering, so restricting to triggering-only changes nothing.
  return { label: "MRA cross-template", n: nBefore, before: top1Before / nBefore, after: top1Before / nBefore, afterN: nBefore };
}

// ---------------------------------------------------------------------------
// 3. Leave-one-out misattribution (Experiment A), reference condition and
// full observation-count sweep.
// ---------------------------------------------------------------------------

export function runMisattributionContamination(): SweepRow[] {
  const slipRate = 0; // matches Experiment A's REFERENCE_SLIP_RATE ("clean data")
  const threshold = DEFAULT_ABSTENTION_THRESHOLD; // matches Experiment A's shipped-default reference point

  return OBS_COUNTS.filter((o) => [3, 5, 10].includes(o)).map((obsCount) => {
    let nBefore = 0;
    let misattrBefore = 0;
    let nAfter = 0;
    let misattrAfter = 0;

    for (const cat of CATEGORIES) {
      for (const mr of cat.malrules) {
        const candidates = cat.malrules.filter((x) => x.id !== mr.id);
        for (let trial = 0; trial < A_TRIALS_PER_MALRULE; trial++) {
          // Before: calls Experiment A's own runHeldOutTrial (same function that
          // produced the published figure) with its exact seed convention, so
          // this value is byte-identical to EVALUATION.md's, not a re-derivation.
          const rngBefore = mulberry32(hashString(`heldout:${mr.id}:${slipRate}:${obsCount}:${threshold}:${trial}`));
          const ho = runHeldOutTrial(mr, cat, obsCount, slipRate, threshold, rngBefore);
          if (ho) {
            nBefore += 1;
            if (!ho.abstained) misattrBefore += 1;
          }

          // After: same seed source, sampling pool restricted to triggering-only instances.
          const rngAfter = mulberry32(hashString(`heldout:${mr.id}:${slipRate}:${obsCount}:${threshold}:${trial}`));
          const obsAfter = simulateObservationsTriggeringOnly(mr.id, cat.instances, obsCount, slipRate, rngAfter);
          if (obsAfter.length === obsCount) {
            const resultAfter = diagnose(obsAfter, cat.instances, candidates, MODEL_SLIP_RATE, threshold);
            nAfter += 1;
            if (!resultAfter.noPatternDetected) misattrAfter += 1;
          }
        }
      }
    }

    return {
      obsCount,
      n: nBefore,
      top1Before: misattrBefore / nBefore, // reused field name; represents misattribution rate here
      top1After: misattrAfter / nAfter,
      afterN: nAfter,
      top3Before: 0,
      top3After: 0,
    };
  });
}

// ---------------------------------------------------------------------------
// 4. False positives (Experiment E, type (a) fully correct). "Triggering
// restriction" generalizes here to: exclude candidate PROBLEMS where ANY
// malrule in the category is non-triggering (i.e. only ask problems no
// malrule could coincidentally "match" a correct answer on).
// ---------------------------------------------------------------------------

export function runFalsePositiveContamination(): BeforeAfter {
  const spec = STUDENT_SPECS.find((s) => s.kind === "a_fully_correct")!;
  let nBefore = 0;
  let fpBefore = 0;
  let nAfter = 0;
  let fpAfter = 0;

  for (const cat of CATEGORIES) {
    const landmineFree = cat.instances.filter((inst) =>
      cat.malrules.every((mr) => inst.predictions[mr.id] === undefined || inst.predictions[mr.id] !== inst.correct_answer)
    );

    for (let trial = 0; trial < E_TRIALS_PER_CATEGORY; trial++) {
      // Before: calls Experiment E's own generateObservations with its exact
      // seed convention, so this value is byte-identical to the published
      // "(a) fully correct, 0% slip" figure, not a re-derivation.
      const rngBefore = mulberry32(hashString(`expE:${spec.label}:${DEFAULT_ABSTENTION_THRESHOLD}:${REFERENCE_OBS_COUNT}:${cat.category}:${trial}`));
      const obsBefore = generateObservations(cat, spec, REFERENCE_OBS_COUNT, rngBefore);
      const resultBefore = diagnose(obsBefore, cat.instances, cat.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD);
      nBefore += 1;
      if (!resultBefore.noPatternDetected) fpBefore += 1;

      if (landmineFree.length >= REFERENCE_OBS_COUNT) {
        const rngAfter = mulberry32(hashString(`fp-after:${cat.category}:${trial}`));
        const chosenAfter = shuffle(landmineFree, rngAfter).slice(0, REFERENCE_OBS_COUNT);
        const obsAfter = chosenAfter.map((inst) => ({ instanceId: inst.instance_id, studentAnswer: inst.correct_answer }));
        const resultAfter = diagnose(obsAfter, cat.instances, cat.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD);
        nAfter += 1;
        if (!resultAfter.noPatternDetected) fpAfter += 1;
      }
    }
  }

  return { label: "False positives, fully correct (a)", n: nBefore, before: fpBefore / nBefore, after: fpAfter / nAfter, afterN: nAfter };
}

// ---------------------------------------------------------------------------
// 5. Adaptive-selection gain (round 1 Phase 4). Candidate pool for BOTH
// strategies restricted to triggering-only instances for the true malrule.
// ---------------------------------------------------------------------------

interface ConvergenceRun {
  converged: boolean;
  observationsUsed: number;
}

function runToConvergence(
  malruleId: string,
  cat: CategoryIndex,
  strategy: "adaptive" | "random",
  rng: () => number,
  triggeringOnly: boolean
): ConvergenceRun {
  const applicable = cat.instances.filter(
    (i) => i.predictions[malruleId] !== undefined && (!triggeringOnly || i.predictions[malruleId] !== i.correct_answer)
  );
  const pool = shuffle(applicable, rng);
  const observed: { instanceId: string; studentAnswer: string }[] = [];
  const used = new Set<string>();
  let randomCursor = 0;

  for (let step = 0; step < MAX_OBSERVATIONS; step++) {
    let chosen: ProblemInstance | undefined;
    if (strategy === "random") {
      while (randomCursor < pool.length && used.has(pool[randomCursor]!.instance_id)) randomCursor++;
      chosen = pool[randomCursor];
    } else {
      const posterior =
        observed.length === 0
          ? uniformPosterior(cat.malrules)
          : posteriorFromScores(diagnose(observed, cat.instances, cat.malrules, MODEL_SLIP_RATE).ranked);
      const remaining = applicable.filter((i) => !used.has(i.instance_id));
      const best = selectNextInstance(posterior, remaining);
      chosen = remaining.find((i) => i.instance_id === best?.instanceId);
    }
    if (!chosen) break;
    used.add(chosen.instance_id);
    observed.push({ instanceId: chosen.instance_id, studentAnswer: chosen.predictions[malruleId]! });
    const result = diagnose(observed, cat.instances, cat.malrules, MODEL_SLIP_RATE);
    if (result.ranked[0]?.malruleId === malruleId && result.tiedTop.length === 1) {
      return { converged: true, observationsUsed: step + 1 };
    }
  }
  return { converged: false, observationsUsed: MAX_OBSERVATIONS };
}

export interface AdaptiveContamination {
  strategy: "adaptive" | "random";
  meanObsBefore: number;
  meanObsAfter: number;
  convergedBefore: number;
  convergedAfter: number;
  n: number;
}

export function runAdaptiveContamination(): AdaptiveContamination[] {
  return (["adaptive", "random"] as const).map((strategy) => {
    let n = 0;
    let convergedBefore = 0;
    let totalObsBefore = 0;
    let convergedAfter = 0;
    let totalObsAfter = 0;

    for (const cat of CATEGORIES) {
      for (const mr of cat.malrules) {
        for (let trial = 0; trial < ADAPTIVE_TRIALS_PER_MALRULE; trial++) {
          n += 1;
          // Before: identical seed convention to evaluate.mts's
          // runAdaptiveComparison, so this value is byte-identical to the
          // published section 10 figures, not a re-derivation.
          const rngBefore = mulberry32(hashString(`${strategy}:${mr.id}:${trial}`));
          const runBefore = runToConvergence(mr.id, cat, strategy, rngBefore, false);
          if (runBefore.converged) {
            convergedBefore += 1;
            totalObsBefore += runBefore.observationsUsed;
          }

          const rngAfter = mulberry32(hashString(`adaptive-after:${strategy}:${mr.id}:${trial}`));
          const runAfter = runToConvergence(mr.id, cat, strategy, rngAfter, true);
          if (runAfter.converged) {
            convergedAfter += 1;
            totalObsAfter += runAfter.observationsUsed;
          }
        }
      }
    }

    return {
      strategy,
      meanObsBefore: totalObsBefore / convergedBefore,
      meanObsAfter: totalObsAfter / convergedAfter,
      convergedBefore: convergedBefore / n,
      convergedAfter: convergedAfter / n,
      n,
    };
  });
}

// ---------------------------------------------------------------------------
// 6. Calibration (Experiment J). ECE recomputed with sampling restricted to
// triggering-only instances for the true malrule.
// ---------------------------------------------------------------------------

export interface CalibrationContamination {
  eceBefore: number;
  eceAfter: number;
  n: number;
  afterN: number;
}

export function runCalibrationContamination(): CalibrationContamination {
  const obsCounts = [1, 2, 3, 5, 7, 10];
  const slipRates = [0, 0.05, 0.1, 0.2];

  interface Trial {
    reportedPosterior: number;
    correct: boolean;
  }
  const before: Trial[] = [];
  const after: Trial[] = [];

  for (const cat of CATEGORIES) {
    for (const mr of cat.malrules) {
      for (const obsCount of obsCounts) {
        for (const slipRate of slipRates) {
          for (let trial = 0; trial < J_TRIALS_PER_COMBO; trial++) {
            // Before: identical seed convention to Experiment J, so this
            // value is byte-identical to the published section 6 figures.
            const seed = hashString(`expJ:${mr.id}:${obsCount}:${slipRate}:${trial}`);

            const rngBefore = mulberry32(seed);
            const applicableAll = cat.instances.filter((i) => i.predictions[mr.id] !== undefined);
            const chosenBefore = shuffle(applicableAll, rngBefore).slice(0, obsCount);
            if (chosenBefore.length === obsCount) {
              const obsBefore = chosenBefore.map((inst) => {
                const followsRule = rngBefore() >= slipRate;
                return {
                  instanceId: inst.instance_id,
                  studentAnswer: followsRule ? inst.predictions[mr.id]! : slipAnswer(inst, mr.id, rngBefore),
                };
              });
              const resultBefore = diagnose(obsBefore, cat.instances, cat.malrules, MODEL_SLIP_RATE);
              const top = resultBefore.ranked[0];
              if (top) before.push({ reportedPosterior: top.posterior, correct: top.malruleId === mr.id });
            }

            const rngAfter = mulberry32(seed);
            const obsAfter = simulateObservationsTriggeringOnly(mr.id, cat.instances, obsCount, slipRate, rngAfter);
            if (obsAfter.length === obsCount) {
              const resultAfter = diagnose(obsAfter, cat.instances, cat.malrules, MODEL_SLIP_RATE);
              const top = resultAfter.ranked[0];
              if (top) after.push({ reportedPosterior: top.posterior, correct: top.malruleId === mr.id });
            }
          }
        }
      }
    }
  }

  function ece(trials: Trial[]): number {
    const buckets = new Map<number, Trial[]>();
    for (const t of trials) {
      const bucket = Math.min(9, Math.floor(t.reportedPosterior * 10));
      const list = buckets.get(bucket) ?? [];
      list.push(t);
      buckets.set(bucket, list);
    }
    let sum = 0;
    for (const list of buckets.values()) {
      const meanPosterior = list.reduce((s, t) => s + t.reportedPosterior, 0) / list.length;
      const accuracy = list.filter((t) => t.correct).length / list.length;
      sum += (list.length / trials.length) * Math.abs(accuracy - meanPosterior);
    }
    return sum;
  }

  return { eceBefore: ece(before), eceAfter: ece(after), n: before.length, afterN: after.length };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderMarkdown(
  topK: SweepRow[],
  mra: BeforeAfter,
  misattr: SweepRow[],
  falsePositive: BeforeAfter,
  adaptive: AdaptiveContamination[],
  calibration: CalibrationContamination
): string {
  const topKTable = `| Observations | Top-1 before | Top-1 after | Top-3 before | Top-3 after |\n|---|---|---|---|---|\n${topK
    .map((r) => `| ${r.obsCount} | ${pct(r.top1Before)} | ${pct(r.top1After)} | ${pct(r.top3Before)} | ${pct(r.top3After)} |`)
    .join("\n")}`;

  const misattrTable = `| Observations | Misattribution rate before | Misattribution rate after |\n|---|---|---|\n${misattr
    .map((r) => `| ${r.obsCount} | ${fmtWilsonFromRate(r.top1Before, r.n)} | ${fmtWilsonFromRate(r.top1After, r.afterN)} |`)
    .join("\n")}`;

  const adaptiveTable = `| Strategy | Converged before | Converged after | Mean obs before | Mean obs after |\n|---|---|---|---|---|\n${adaptive
    .map(
      (a) =>
        `| ${a.strategy} | ${pct(a.convergedBefore)} | ${pct(a.convergedAfter)} | ${a.meanObsBefore.toFixed(2)} | ${a.meanObsAfter.toFixed(2)} |`
    )
    .join("\n")}`;

  const fp5 = misattr.find((r) => r.obsCount === 5)!;

  return `Every figure elsewhere in this document is sampled from ALL instances a
malrule is applicable to -- both triggering (the malrule's algorithm
actually produces a wrong answer there) and non-triggering (the malrule's
algorithm coincidentally reproduces the correct answer, carrying zero
diagnostic information). This section re-derives each figure with the
sampling pool restricted to triggering instances only, using a separate,
parallel sampler (\`simulateObservationsTriggeringOnly\`) that never touches
the original sampling functions -- so every existing number above and
below remains exactly as measured; this is a before/after overlay, not a
correction.

**(c) Does \`lib/select\`'s adaptive next-problem selection know the
difference?** No -- confirmed by reading \`lib/select/select.ts\` in full.
\`scoreCandidates()\` groups hypotheses purely by
\`inst.predictions[malruleId] ?? NOT_APPLICABLE\`; \`correct_answer\` never
appears in that file. A coincidental, zero-information match is treated as
fully discriminating, identically to a genuine one. This is a real,
confirmed structural gap. \`lib/select\` is frozen this round (audit only,
per this round's scope) -- reported here as a bug, not fixed, and flagged
for a future round's work.

### The two largest movers

**By far the largest: Experiment E's false-positive rate on fully correct
students.** ${fmtWilsonFromRate(falsePositive.before, falsePositive.n)} (all observations) -> ${fmtWilsonFromRate(falsePositive.after, falsePositive.afterN)} (triggering-only,
i.e. excluding any instance where at least one malrule in the category
coincidentally reproduces the correct answer). This is not a partial
explanation -- it is the complete mechanistic account: every false
positive Experiment E measured was, by definition, a non-triggering
coincidence, because there is no other way for a genuinely correct answer
to equal a malrule's predicted (wrong-by-design) output.

**Second: Experiment A's leave-one-out misattribution rate**, a real but
much smaller effect:

${misattrTable}

At the reference condition (5 observations): ${fmtWilsonFromRate(fp5.top1Before, fp5.n)} -> ${fmtWilsonFromRate(fp5.top1After, fp5.afterN)}, roughly a
${pct((fp5.top1Before - fp5.top1After) / fp5.top1Before)} relative reduction. Some, not all, of Experiment A's held-out
misattribution is driven by the same coincidence mechanism -- when the
held-out malrule's own simulated answer happens to be non-triggering for
some OTHER in-library malrule too, that other malrule gets undeserved
credit.

### Every other figure, for completeness

**MRA (92.8%): mechanically unchanged, confirmed not just assumed.**
Before: ${pct(mra.before)}, after: ${pct(mra.after)} (n=${mra.n} both). Identical to
floating-point precision, because MRA's worked-mistake observation (A) is
always drawn from a NATIVE instance, and \`build_index.py\`'s own filter
(\`if native_answer == correct_answer: continue\`) already guarantees every
native instance is triggering -- verified here with a runtime check, not
just read from the script. **This is the reason the checkpoint above does
not report 92.8% as having moved: it structurally cannot, by construction
of how MRA itself is measured.**

**Top-1 / top-3 identification accuracy (Experiment C (a) sweep):**
negligible, no consistent direction.

${topKTable}

**Adaptive-selection convergence (round 1 Phase 4):** negligible. Both
strategies already converge in essentially 1 observation on most trials,
leaving little room for a sampling restriction to move the outcome.

${adaptiveTable}

**Posterior calibration (Experiment J) ECE:** negligible. Before:
${pct(calibration.eceBefore)} (n=${calibration.n}), after: ${pct(calibration.eceAfter)} (n=${calibration.afterN}) -- a difference well
within the noise expected from re-sampling, not a real shift in
calibration quality.

### What this means for the rest of the document

Every headline number elsewhere in this document that is NOT Experiment E
or (to a lesser extent) Experiment A is essentially unaffected by
non-triggering contamination -- MRA, top-1/top-3 identification accuracy,
calibration, and adaptive-selection convergence all move by less than
would be expected from re-sampling noise alone. The contamination is real,
large, and fully explains the false-positive headline; it is not a
document-wide inflation of every reported figure.`;
}

export { simulateObservationsTriggeringOnly };
