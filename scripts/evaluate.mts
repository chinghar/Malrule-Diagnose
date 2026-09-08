// Evaluation harness. Runs entirely against the committed index
// (data/index/*.json) through the same diagnose() engine used by the app --
// no separate "evaluation copy" of the scoring logic. Run with:
//
//   npm run evaluate
//
// Writes EVALUATION.md and data/indistinguishability.json at the project
// root. Deterministic: every simulated trial is seeded from a hash of its
// own parameters, so re-running produces identical numbers. No MalruleLib
// clone required -- everything here reads only the committed index.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { diagnose } from "../lib/diagnose/diagnose.ts";
import { hashString, mulberry32, shuffle, simulateObservations } from "../lib/diagnose/testSupport.ts";
import type { CategoryIndex, MalruleMeta, ProblemInstance } from "../lib/diagnose/types.ts";
import { posteriorFromScores, selectNextInstance, uniformPosterior } from "../lib/select/select.ts";
import { CATEGORIES, MODEL_SLIP_RATE, pct } from "./lib/data.mts";
import { runSweep, OBS_COUNTS, INJECTED_SLIP_RATES, TRIALS_PER_COMBO, type SweepCell } from "./lib/sweep.mts";
import {
  runSweep as runExperimentASweep,
  runPerMalruleBreakdown as runExperimentABreakdown,
  renderMarkdown as renderExperimentA,
} from "./lib/experimentA.mts";
import { runExperimentB, renderMarkdown as renderExperimentB } from "./lib/experimentB.mts";
import {
  computeChanceBaselines,
  pooledChanceBaseline,
  runCandidateScaling,
  renderMarkdown as renderExperimentC,
} from "./lib/experimentC.mts";
import { runMraCeiling, runSlipRateCeiling, renderMarkdown as renderExperimentD } from "./lib/experimentD.mts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Malrule Reasoning Accuracy (MRA): infer the malrule from ONE worked
// mistake, then predict the student's answer on a new problem. Because this
// engine predicts by *executing* the diagnosed malrule rather than guessing,
// "predict correctly on the new problem" collapses to "the new problem is
// one the malrule can run on, and the malrule was correctly identified" --
// see the ceiling analysis (Experiment D) for what that collapse actually
// means for the headline figure. We measure, for every worked-mistake
// instance A, whether a valid new-problem partner B exists in the same
// template (same-template pair) or a different template (cross-template
// pair), and whether the single-observation diagnosis from A alone lands on
// the true malrule.
// ---------------------------------------------------------------------------

interface MraResult {
  pairing: "same-template" | "cross-template";
  n: number;
  top1: number;
}

function runMra(): MraResult[] {
  const buckets = {
    "same-template": { n: 0, top1: 0 },
    "cross-template": { n: 0, top1: 0 },
  };

  for (const cat of CATEGORIES) {
    for (const mr of cat.malrules) {
      const worked = cat.instances.filter((i) => i.native_malrule_id === mr.id);
      for (const A of worked) {
        const hasSameTemplateB = cat.instances.some(
          (b) => b.instance_id !== A.instance_id && b.template === A.template && b.predictions[mr.id] !== undefined
        );
        const hasCrossTemplateB = cat.instances.some(
          (b) => b.template !== A.template && b.predictions[mr.id] !== undefined
        );
        if (!hasSameTemplateB && !hasCrossTemplateB) continue;

        const answer = A.predictions[mr.id];
        if (answer === undefined) continue; // A is native to mr, so this shouldn't happen; guard anyway
        const result = diagnose([{ instanceId: A.instance_id, studentAnswer: answer }], cat.instances, cat.malrules, MODEL_SLIP_RATE);
        const correct = result.ranked[0]?.malruleId === mr.id ? 1 : 0;

        if (hasSameTemplateB) {
          buckets["same-template"].n += 1;
          buckets["same-template"].top1 += correct;
        }
        if (hasCrossTemplateB) {
          buckets["cross-template"].n += 1;
          buckets["cross-template"].top1 += correct;
        }
      }
    }
  }

  return (Object.keys(buckets) as (keyof typeof buckets)[]).map((pairing) => ({
    pairing,
    n: buckets[pairing].n,
    top1: buckets[pairing].top1 / buckets[pairing].n,
  }));
}

// ---------------------------------------------------------------------------
// Adaptive vs. random problem selection. For a fixed true malrule,
// repeatedly pick a next problem (either the highest expected-entropy-
// reduction candidate, or a uniformly random one), observe the clean
// (0% slip) answer it produces, update the posterior, and stop once the
// diagnosis has uniquely converged on the true malrule (top-1 correct and
// not tied with anything else). Reports how many observations each strategy
// needed, averaged over many (malrule, trial) runs.
// ---------------------------------------------------------------------------

const ADAPTIVE_TRIALS_PER_MALRULE = 20;
const MAX_OBSERVATIONS = 15;

interface ConvergenceRun {
  converged: boolean;
  observationsUsed: number;
}

function runToConvergence(
  malruleId: string,
  cat: CategoryIndex,
  strategy: "adaptive" | "random",
  rng: () => number
): ConvergenceRun {
  // Both strategies draw only from problems this malrule can actually be
  // evaluated on, so the comparison isn't confounded by one strategy
  // stumbling onto more "answerable" problems than the other.
  const pool = shuffle(
    cat.instances.filter((i) => i.predictions[malruleId] !== undefined),
    rng
  );

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
      const remaining = cat.instances.filter((i) => !used.has(i.instance_id) && i.predictions[malruleId] !== undefined);
      const best = selectNextInstance(posterior, remaining);
      chosen = remaining.find((i) => i.instance_id === best?.instanceId);
    }

    if (!chosen) break; // pool exhausted
    used.add(chosen.instance_id);
    const answer = chosen.predictions[malruleId]!;
    observed.push({ instanceId: chosen.instance_id, studentAnswer: answer });

    const result = diagnose(observed, cat.instances, cat.malrules, MODEL_SLIP_RATE);
    if (result.ranked[0]?.malruleId === malruleId && result.tiedTop.length === 1) {
      return { converged: true, observationsUsed: step + 1 };
    }
  }
  return { converged: false, observationsUsed: MAX_OBSERVATIONS };
}

interface StrategySummary {
  strategy: "adaptive" | "random";
  n: number;
  convergedCount: number;
  meanObservationsAmongConverged: number;
}

function runAdaptiveComparison(): StrategySummary[] {
  const summaries: Record<"adaptive" | "random", { n: number; converged: number; totalObs: number }> = {
    adaptive: { n: 0, converged: 0, totalObs: 0 },
    random: { n: 0, converged: 0, totalObs: 0 },
  };

  for (const strategy of ["adaptive", "random"] as const) {
    for (const cat of CATEGORIES) {
      for (const mr of cat.malrules) {
        for (let trial = 0; trial < ADAPTIVE_TRIALS_PER_MALRULE; trial++) {
          const rng = mulberry32(hashString(`${strategy}:${mr.id}:${trial}`));
          const run = runToConvergence(mr.id, cat, strategy, rng);
          summaries[strategy].n += 1;
          if (run.converged) {
            summaries[strategy].converged += 1;
            summaries[strategy].totalObs += run.observationsUsed;
          }
        }
      }
    }
  }

  return (["adaptive", "random"] as const).map((strategy) => ({
    strategy,
    n: summaries[strategy].n,
    convergedCount: summaries[strategy].converged,
    meanObservationsAmongConverged: summaries[strategy].totalObs / summaries[strategy].converged,
  }));
}

// ---------------------------------------------------------------------------
// Markdown rendering for the sections that remain in this file (the (a)/(b)
// sweep tables and the Phase 4 adaptive-selection section, unchanged).
// ---------------------------------------------------------------------------

function renderSweepTable(cells: SweepCell[], injectedSlipRate: number): string {
  const rows = cells.filter((c) => c.injectedSlipRate === injectedSlipRate);
  const header = "| Observations | n | Top-1 | Top-1-or-tied | Top-3 |\n|---|---|---|---|---|";
  const body = rows
    .map((r) => `| ${r.obsCount} | ${r.n} | ${pct(r.top1)} | ${pct(r.top1OrTied)} | ${pct(r.top3)} |`)
    .join("\n");
  return `${header}\n${body}`;
}

function main() {
  console.log("Running identification accuracy sweep...");
  const sweep = runSweep();

  console.log("Running MRA measurement...");
  const mra = runMra();
  const sameTemplate = mra.find((m) => m.pairing === "same-template")!;
  const crossTemplate = mra.find((m) => m.pairing === "cross-template")!;

  console.log("Running adaptive vs. random selection comparison...");
  const adaptiveComparison = runAdaptiveComparison();

  console.log("Running Experiment A (open-world misattribution, leave-one-out)...");
  const expASweep = runExperimentASweep();
  const expABreakdown = runExperimentABreakdown();
  const totalMalruleCount = CATEGORIES.reduce((s, c) => s + c.malrules.length, 0);

  console.log("Running Experiment B (indistinguishability, properly characterized)...");
  const expB = runExperimentB();

  console.log("Running Experiment C (chance baselines and candidate-set scaling)...");
  const chanceBaselines = computeChanceBaselines();
  const pooledChance = pooledChanceBaseline(chanceBaselines);
  const scalingTrials = runCandidateScaling();

  console.log("Running Experiment D (ceiling analysis and error decomposition)...");
  const mraCeiling = runMraCeiling();
  const slipDecomposition = runSlipRateCeiling();

  const totalMalrules = CATEGORIES.reduce((s, c) => s + c.malrules.length, 0);
  const totalInstances = CATEGORIES.reduce((s, c) => s + c.instances.length, 0);

  const md = `# Evaluation

## 1. What was measured, and on what data

**Every number below is computed against MalruleLib-generated synthetic
data only** (\`data/index/\`) -- nothing here has been run against a real
child. That is stated first, not last, because it bounds how every other
claim in this document should be read: these are upper bounds on a system
tested against data generated by the same executable procedures it is
trying to identify. Real children's work is noisier, messier, and includes
procedures that were never in this or any library. See the README for the
classroom-validity caveat.

Scope: ${totalMalrules} malrules across subtraction, fractions, decimals, and
multiplication/division (${totalInstances} problem instances). The diagnosis
engine's assumed noise parameter (\`slipRate\`) is held fixed at
**${MODEL_SLIP_RATE}** for every measurement below unless stated otherwise --
including when the *true* injected slip rate differs from it, and including
in Experiment D's oracle comparison, which exists specifically to quantify
what that fixed assumption costs.

**Malrule identification accuracy and Malrule Reasoning Accuracy (MRA) are
different metrics.** Identification accuracy asks only "did the correct
malrule rank first (or in the top 3)?" MRA is the paper's task: infer the
malrule from one example, then predict the student's answer on a
*different* problem. Section 7 below states plainly why even MRA is not a
like-for-like comparison with the paper's published LLM baselines (40.5%
cross-template answer-only, 46.5% with step traces) -- read it before
treating any number here as a claim of beating that baseline.

This document is organized around what the four experiments below actually
found, not around the order they were built in. The headline finding is
Experiment B, not the MRA percentage.

## 2. Indistinguishability (Experiment B) -- the headline finding

${renderExperimentB(expB)}

## 3. Open-world misattribution (Experiment A)

${renderExperimentA(expASweep, expABreakdown, totalMalruleCount)}

## 4. Ceiling analysis and error decomposition (Experiment D)

Before the ceiling analysis, here is what MRA itself measures: given one
worked mistake, infer the malrule, then predict the student's answer on a
different problem. Because this engine predicts by directly executing the
diagnosed malrule rather than guessing, a correct diagnosis on an
applicable new problem guarantees a correct answer prediction by
construction -- so this number is really measuring single-example
identification accuracy, restricted to worked-mistake instances that have a
valid new-problem partner of the stated kind.

| Pairing | n | MRA accuracy |
|---|---|---|
| Same-template | ${sameTemplate.n} | ${pct(sameTemplate.top1)} |
| Cross-template | ${crossTemplate.n} | ${pct(crossTemplate.top1)} |

(Chance baseline for comparison: pooled 1-of-n guessing over applicable
candidates is ${pct(pooledChance.chanceTop1)} -- see Experiment C, section 5, for the
full per-category breakdown.)

${renderExperimentD(mraCeiling, slipDecomposition)}

## 5. Chance baselines and candidate-set scaling (Experiment C)

${renderExperimentC(chanceBaselines, pooledChance, scalingTrials)}

### (a) Identification accuracy vs. number of observations (clean data)

Read every figure below against the chance baselines above, not against
100%. 0% injected slip, ${TRIALS_PER_COMBO} trials per malrule per observation count,
model slip rate ${MODEL_SLIP_RATE}.

${renderSweepTable(sweep, 0)}

### (b) Identification accuracy vs. number of observations, by injected slip rate

Each table uses the same trial protocol as (a) but with random slips
injected into the simulated student's answers at the stated rate (the
model still assumes slip rate ${MODEL_SLIP_RATE} throughout, regardless of the
true rate -- see Experiment D for what that assumption costs).

**Injected slip rate: 5%**

${renderSweepTable(sweep, 0.05)}

**Injected slip rate: 10%**

${renderSweepTable(sweep, 0.1)}

**Injected slip rate: 20%**

${renderSweepTable(sweep, 0.2)}

## 6. Adaptive vs. random problem selection

Re-runs measurement (a)'s protocol, but instead of asking a fixed number of
random observations, each strategy is run to **convergence**: keep asking
(clean, 0% slip) questions until the diagnosis uniquely and correctly
identifies the true malrule (top-1 correct and not tied with any other
malrule), or ${MAX_OBSERVATIONS} observations are used without converging.
"Adaptive" picks, at each step, the not-yet-asked problem with the highest
expected posterior-entropy reduction (\`lib/select\`); "random" picks
uniformly among not-yet-asked problems. Both strategies draw only from
problems the true malrule can actually be evaluated on, and every
(malrule, trial) pair uses the same trial index for both strategies so the
comparison isn't confounded by which problems happen to be available.
${ADAPTIVE_TRIALS_PER_MALRULE} trials per malrule per strategy (${adaptiveComparison[0]!.n} runs each).

| Strategy | Converged | Mean observations to converge |
|---|---|---|
${adaptiveComparison
  .map(
    (s) =>
      `| ${s.strategy} | ${s.convergedCount}/${s.n} (${pct(s.convergedCount / s.n)}) | ${s.meanObservationsAmongConverged.toFixed(2)} |`
  )
  .join("\n")}

${(() => {
  const adaptive = adaptiveComparison.find((s) => s.strategy === "adaptive")!;
  const random = adaptiveComparison.find((s) => s.strategy === "random")!;
  const delta = random.meanObservationsAmongConverged - adaptive.meanObservationsAmongConverged;
  const relative = (delta / random.meanObservationsAmongConverged) * 100;
  return `Adaptive selection needed **${delta.toFixed(2)} fewer observations on average** (${relative.toFixed(1)}% reduction) to reach a unique, correct diagnosis, and converged in ${pct(adaptive.convergedCount / adaptive.n)} of runs vs. ${pct(random.convergedCount / random.n)} for random selection within the ${MAX_OBSERVATIONS}-observation cap.`;
})()}

## 7. On comparison to the paper's LLM baseline

**The numbers in this document are not comparable to the paper's reported
LLM accuracy, and the MRA figures above should not be read as this engine
outperforming that baseline.**

The paper's task is open-world: given one worked example, an LLM must
infer an *unseen* procedure -- one it was never told the identity or even
the existence of -- in natural language, and then re-execute that inferred
procedure correctly on a new problem, with no guarantee the true procedure
is describable at all, let alone a member of any enumerated list.

This engine does neither of those things. It selects from a pre-enumerated
candidate set of ${totalMalruleCount} malrules that is known in advance, over
category-scoped candidate pools of only 5-8 members (Experiment C).
Critically, in every measurement above except Experiment A, **the true
malrule is a member of the candidate set by construction** -- the
diagnosis problem is "which of these known options produced this data,"
not "what is this data" in any open sense. Experiment A is the one place
in this document where the true procedure is *not* available as an
option, and it is the closest analogue to the paper's actual difficulty --
its answer (misattribution rate of ${pct(
    expASweep.find((p) => p.threshold === 1 && p.slipRate === 0 && p.obsCount === 5)!.heldOutMisattributionRate
  )} at the shipped default) is a far more honest measure of how this
system behaves outside the assumption that the true procedure is in the
library than the 92.8% MRA figure is.

Read the 92.8%/93.3% MRA figures as: "given that the true procedure is
known to be one of a handful of pre-enumerated options, how often does
directly executing candidates and comparing outputs pick the right one." That is a real, useful, different question from the one the paper's LLM
baseline answers, not a harder version of the same question solved better.
`;

  const outPath = path.join(ROOT, "EVALUATION.md");
  writeFileSync(outPath, md);
  console.log(`\nWrote ${outPath}`);

  const indistinguishabilityPath = path.join(ROOT, "data", "indistinguishability.json");
  writeFileSync(indistinguishabilityPath, JSON.stringify(expB, null, 2));
  console.log(`Wrote ${indistinguishabilityPath}`);

  console.log(`\n(a) clean top-1 @5 obs: ${pct(sweep.find((c) => c.injectedSlipRate === 0 && c.obsCount === 5)!.top1)}`);
  console.log(`(c) MRA cross-template: ${pct(crossTemplate.top1)} (n=${crossTemplate.n})`);
  console.log(
    `(Experiment A) default misattribution rate: ${pct(
      expASweep.find((p) => p.threshold === 1 && p.slipRate === 0 && p.obsCount === 5)!.heldOutMisattributionRate
    )}`
  );
  console.log(
    `(Experiment B) fully indistinguishable pairs: ${expB.pairs.filter((p) => p.fullyIndistinguishable).length}, ` +
      `some-templates pairs: ${expB.pairs.filter((p) => p.indistinguishableOnSomeTemplates).length}`
  );
  console.log(
    `(Experiment D) MRA floor=${pct(mraCeiling.floor)} fairExpected=${pct(mraCeiling.expectedUnderFairTiebreak)} measured=${pct(mraCeiling.measured)}`
  );
  for (const s of adaptiveComparison) {
    console.log(
      `(adaptive selection) ${s.strategy}: converged ${s.convergedCount}/${s.n}, mean obs ${s.meanObservationsAmongConverged.toFixed(2)}`
    );
  }
}

main();
