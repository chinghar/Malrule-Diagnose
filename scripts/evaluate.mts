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
import { fmtWilsonFromRate } from "./lib/stats.mts";
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
import {
  runThresholdSweep as runExperimentEThresholdSweep,
  runObsCountSweep as runExperimentEObsCountSweep,
  renderMarkdown as renderExperimentE,
} from "./lib/experimentE.mts";
import { auditNonTriggeringPairs, auditPerMalruleExposure, renderMarkdown as renderNonTriggeringAudit } from "./lib/nonTriggeringAudit.mts";
import { runExperimentG, renderMarkdown as renderExperimentG } from "./lib/experimentG.mts";
import { runExperimentH, renderMarkdown as renderExperimentH } from "./lib/experimentH.mts";
import { runExperimentI, renderMarkdown as renderExperimentI } from "./lib/experimentI.mts";
import { runSelectExposureAudit, renderMarkdown as renderSelectExposureAudit } from "./lib/selectExposureAudit.mts";
import { runExperimentJ, renderMarkdown as renderExperimentJ } from "./lib/experimentJ.mts";
import { runExperimentK, renderMarkdown as renderExperimentK } from "./lib/experimentK.mts";
import {
  runTopKContamination,
  runMraContamination,
  runMisattributionContamination,
  runFalsePositiveContamination,
  runAdaptiveContamination,
  runCalibrationContamination,
  renderMarkdown as renderNonTriggeringContamination,
} from "./lib/nonTriggeringContamination.mts";
import { renderMarkdown as renderNullHypothesis } from "./lib/nullHypothesis.mts";

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
  const header = "| Observations | n | Top-1 (95% CI, Wilson) | Top-1-or-tied | Top-3 (95% CI, Wilson) |\n|---|---|---|---|---|";
  const body = rows
    .map((r) => `| ${r.obsCount} | ${r.n} | ${fmtWilsonFromRate(r.top1, r.n)} | ${pct(r.top1OrTied)} | ${fmtWilsonFromRate(r.top3, r.n)} |`)
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

  console.log("Running Experiment E (non-malrule students / false positives)...");
  const expEThresholdSweep = runExperimentEThresholdSweep();
  const expEObsCountSweep = runExperimentEObsCountSweep();

  console.log("Running non-triggering pairs audit...");
  const nonTriggeringStats = auditNonTriggeringPairs();
  const nonTriggeringExposure = auditPerMalruleExposure();

  console.log("Running Experiment G (scorer robustness)...");
  const expG = runExperimentG();

  console.log("Running Experiment H (leave-one-out proxy validity)...");
  const expH = runExperimentH();

  console.log("Running Experiment I (adaptive selection, out-of-library)...");
  const expI = runExperimentI();

  console.log("Running Item 1 lib/select non-triggering exposure audit (round four)...");
  const selectExposure = runSelectExposureAudit();

  console.log("Running Experiment J (posterior calibration)...");
  const expJ = runExperimentJ();

  console.log("Running Experiment K (mixed and transitioning students)...");
  const expK = runExperimentK();

  console.log("Running Phase 1 non-triggering contamination audit...");
  const contamTopK = runTopKContamination();
  const contamMra = runMraContamination();
  const contamMisattr = runMisattributionContamination();
  const contamFalsePositive = runFalsePositiveContamination();
  const contamAdaptive = runAdaptiveContamination();
  const contamCalibration = runCalibrationContamination();

  console.log("Running Phase 2/3 null hypothesis benefit/cost analysis...");
  const nullHypothesisMd = renderNullHypothesis();

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
*different* problem. Section 11 below states plainly why even MRA is not a
like-for-like comparison with the paper's published LLM baselines (40.5%
cross-template answer-only, 46.5% with step traces) -- read it before
treating any number here as a claim of beating that baseline.

**On confidence intervals:** every rate below is a proportion out of a
known number of trials or instances, and is reported with a 95% Wilson
score interval (chosen over the normal/Wald approximation for its better
coverage at small n or extreme proportions, and over Clopper-Pearson
because it needs no incomplete-beta-function dependency). Where trials
share a malrule or category rather than being independent draws -- which
understates uncertainty if ignored -- a second, more conservative
between-cluster interval is given alongside the headline number, treating
each cluster's own rate as one data point. Both methods are implemented in
\`scripts/lib/stats.mts\`. For the large per-condition sweep grids in
sections 3 and 9, adding a full interval to every one of 100+ rows would
make the tables unreadable; those cells follow the identical Wilson
formula from their own stated n, and the headline/summary numbers drawn
from the same data carry explicit intervals so the method is never opaque.

This document is organized in **severity order**, not the order
experiments were run or the order of the prior evaluation round. This
round's central finding -- that the engine produces confident false
diagnoses on students who are not running any malrule at all, and that
this is far worse in one category than the pooled number suggests --
supersedes the previous round's headline (Experiment B's indistinguishability
finding, still important, now section 5) as the most important thing to
know before using this tool.

## 2. False positives on students who are not running any malrule (Experiments E, I; non-triggering audit)

This is the most important untested case from the first evaluation round,
and the reason this section leads the document: **\`diagnose()\` has no
"correct answer" hypothesis anywhere.** It only ever scores the malrules
it's given; \`correct_answer\` is metadata on each instance, never a
candidate. The only thing standing between a healthy student and a
confident false diagnosis is (1) most malrules' predictions differing from
correct on most instances, and (2) the abstention threshold. Neither is a
guarantee, and this was first observed directly and manually, before any
of this section's systematic measurement existed: during this project's
own UI verification, three consecutive CORRECT answers to real subtraction
problems produced a confident "subtraction.always_borrow_left, 85.3%
posterior" diagnosis, purely because that malrule's output happened to
coincide with the correct answer on 2 of the 3 problems shown.

${renderExperimentE(expEThresholdSweep, expEObsCountSweep)}

### Why this happens: non-triggering pairs

${renderNonTriggeringAudit(nonTriggeringStats, nonTriggeringExposure)}

### Contamination audit: how much of every figure in this document is this artifact? (Phase 1)

${renderNonTriggeringContamination(contamTopK, contamMra, contamMisattr, contamFalsePositive, contamAdaptive, contamCalibration)}

### A direct fix: the null hypothesis candidate, and its cost (Phase 2/3/4)

${nullHypothesisMd}

**Phase 4 -- the shipped default.** The contradiction from the prior round
(the tool described as not usable at its default, yet shipping that
default) is resolved here, not by raising \`abstentionThreshold\` --
Experiment A's own tradeoff curve already shows no threshold value fixes
misattribution without heavy in-library coverage loss -- but by turning
\`includeNullHypothesis\` ON in the shipped product specifically. **The
actual UI (\`app/DiagnosisApp.tsx\`) now calls \`diagnose()\` with
\`includeNullHypothesis: true\`**, while \`diagnose()\`'s own function
default stays \`false\` so every existing figure in this document, and
every existing call site in \`scripts/lib/\`, remains byte-for-byte
reproducible without passing this argument. \`abstentionThreshold\` is left
at its shipped default (1.0), unchanged this round.

### Does adaptive selection make this worse? (Experiment I)

${renderExperimentI(expI)}

### Does \`lib/select\` contribute to this? (round four audit)

${renderSelectExposureAudit(selectExposure)}

## 3. Open-world misattribution on genuinely novel procedures (Experiment A; Experiment H)

The false positives in section 2 come from students with no systematic
procedure at all. This section asks the adjacent question: what happens
when a student *is* running a systematic procedure, just not one already
in the library?

${renderExperimentA(expASweep, expABreakdown, totalMalruleCount)}

### Is leave-one-out even a fair test of this? (Experiment H)

Held-out MalruleLib malrules might be more similar to in-library malrules
than a real child's invented bug would be (making the number above
optimistic), or less similar (making it pessimistic) -- unknown without
measuring it directly, which is what this subsection does.

${renderExperimentH(expH)}

## 4. Does any of this depend on the scoring function? (Experiment G)

Sections 2 and 3 both depend on \`lib/diagnose\`'s scoring math. This
re-runs both protocols under three alternative scorers -- behind a new
parameter, default unchanged -- to check whether the findings above belong
to the general method (matching an enumerated hypothesis space) or are an
artifact of this particular implementation.

${renderExperimentG(expG)}

## 5. Indistinguishability (Experiment B)

The previous evaluation round's headline finding. Still critically
important for interpreting every other section -- it's the structural
reason certain malrules (the same ones driving sections 2 and 3's worst
cases) are hard to tell apart -- but no longer the single most urgent
thing to know about this tool.

${renderExperimentB(expB)}

## 6. Posterior calibration (Experiment J)

Sections 2-5 are about whether the *top-ranked malrule* is right. This
section asks a different question: when the UI shows "62% confident,"
does that number mean what it says?

${renderExperimentJ(expJ)}

## 7. Mixed and transitioning students (Experiment K)

Real children often half-transition between strategies rather than
cleanly switching. This checks what the engine reports when the true
generative process genuinely is a blend of two known malrules.

${renderExperimentK(expK)}

## 8. Ceiling analysis and error decomposition (Experiment D)

Before the ceiling analysis, here is what MRA itself measures: given one
worked mistake, infer the malrule, then predict the student's answer on a
different problem. Because this engine predicts by directly executing the
diagnosed malrule rather than guessing, a correct diagnosis on an
applicable new problem guarantees a correct answer prediction by
construction -- so this number is really measuring single-example
identification accuracy, restricted to worked-mistake instances that have a
valid new-problem partner of the stated kind.

| Pairing | n | MRA accuracy (95% CI, Wilson) |
|---|---|---|
| Same-template | ${sameTemplate.n} | ${fmtWilsonFromRate(sameTemplate.top1, sameTemplate.n)} |
| Cross-template | ${crossTemplate.n} | ${fmtWilsonFromRate(crossTemplate.top1, crossTemplate.n)} |

(Chance baseline for comparison: pooled 1-of-n guessing over applicable
candidates is ${pct(pooledChance.chanceTop1)} -- see Experiment C, section 9, for the
full per-category breakdown.)

${renderExperimentD(mraCeiling, slipDecomposition)}

## 9. Chance baselines, candidate-set scaling, and the identification-accuracy sweep (Experiment C)

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

## 10. Adaptive vs. random problem selection

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

*(The paragraph and table above are preserved verbatim from the prior
evaluation round, per that round's explicit requirement. This note is
additive, not a change to that text: convergence-rate intervals are
${fmtWilsonFromRate(adaptiveComparison.find((s) => s.strategy === "adaptive")!.convergedCount / adaptiveComparison.find((s) => s.strategy === "adaptive")!.n, adaptiveComparison.find((s) => s.strategy === "adaptive")!.n)} (adaptive) and
${fmtWilsonFromRate(adaptiveComparison.find((s) => s.strategy === "random")!.convergedCount / adaptiveComparison.find((s) => s.strategy === "random")!.n, adaptiveComparison.find((s) => s.strategy === "random")!.n)} (random) -- both comfortably high and overlapping, consistent with
the "not a large effect" framing above.)*

## 11. On comparison to the paper's LLM baseline

**The numbers in this document are not comparable to the paper's reported
LLM accuracy, and the MRA figures above should not be read as this engine
outperforming that baseline.**

The paper's task is open-world: given one worked example, an LLM must
infer an *unseen* procedure -- one it was never told the identity or even
the existence of -- in natural language, and then re-execute that inferred
procedure correctly on a new problem, with no guarantee the true procedure
is describable at all, let alone a member of any enumerated list, or even
that the student is running a systematic procedure at all.

This engine does none of those things. It selects from a pre-enumerated
candidate set of ${totalMalruleCount} malrules that is known in advance, over
category-scoped candidate pools of only 5-8 members (Experiment C).
Critically, in every measurement above except Experiments A, E, G, and H,
**the true malrule is a member of the candidate set by construction** --
the diagnosis problem is "which of these known options produced this
data," not "what is this data" in any open sense. Sections 2 and 3 are the
closest analogue to the paper's actual difficulty, and are far more honest
measures of how this system behaves outside the assumption that the true
procedure is known in advance than the 92.8% MRA figure is: a
${pct(
    expASweep.find((p) => p.threshold === 1 && p.slipRate === 0 && p.obsCount === 5)!.heldOutMisattributionRate
  )} misattribution rate on genuinely novel procedures (Experiment A, direction of
bias unresolved -- Experiment H), and a false-positive rate on students
running no procedure at all that is much worse than its pooled figure
suggests in at least one category (Experiment E: ~50% in subtraction).

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
  console.log(
    `(Experiment E) fully-correct false-positive rate: ${pct(
      expEThresholdSweep.find((r) => r.specLabel === "(a) fully correct, 0% slip" && r.threshold === 1 && r.obsCount === 5)!.falsePositiveRate
    )}`
  );
  console.log(
    `(Experiment G) misattribution/FP rate range across scorers: ${pct(Math.min(...expG.map((r) => r.misattributionRate)))}-${pct(Math.max(...expG.map((r) => r.misattributionRate)))} / ${pct(Math.min(...expG.map((r) => r.falsePositiveRate)))}-${pct(Math.max(...expG.map((r) => r.falsePositiveRate)))}`
  );
  console.log(
    `(Experiment H) held-out=${pct(expH.find((r) => r.bugClass === "a_held_out")!.misattributionRate)} composed=${pct(expH.find((r) => r.bugClass === "b_composed")!.misattributionRate)} perturbed=${pct(expH.find((r) => r.bugClass === "c_perturbed")!.misattributionRate)}`
  );
  console.log(`(Experiment J) ECE all=${pct(expJ.all.ece)} close-top-two=${pct(expJ.closeTopTwo.ece)}`);
  for (const s of adaptiveComparison) {
    console.log(
      `(adaptive selection) ${s.strategy}: converged ${s.convergedCount}/${s.n}, mean obs ${s.meanObservationsAmongConverged.toFixed(2)}`
    );
  }
}

main();
