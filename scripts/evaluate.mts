// Phase 3 evaluation harness. Runs entirely against the committed index
// (data/index/*.json) through the same diagnose() engine used by the app --
// no separate "evaluation copy" of the scoring logic. Run with:
//
//   npm run evaluate
//
// Writes EVALUATION.md at the project root. Deterministic: every simulated
// trial is seeded from a hash of its own parameters, so re-running produces
// identical numbers.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { diagnose } from "../lib/diagnose/diagnose.ts";
import { hashString, mulberry32, shuffle, simulateObservations } from "../lib/diagnose/testSupport.ts";
import type { CategoryIndex, MalruleMeta, ProblemInstance } from "../lib/diagnose/types.ts";
import { posteriorFromScores, selectNextInstance, uniformPosterior } from "../lib/select/select.ts";

import subtraction from "../data/index/subtraction.json" with { type: "json" };
import fractions from "../data/index/fractions.json" with { type: "json" };
import decimals from "../data/index/decimals.json" with { type: "json" };
import multiplicationDivision from "../data/index/multiplication_division.json" with { type: "json" };

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const CATEGORIES: CategoryIndex[] = [
  subtraction as unknown as CategoryIndex,
  fractions as unknown as CategoryIndex,
  decimals as unknown as CategoryIndex,
  multiplicationDivision as unknown as CategoryIndex,
];

// The diagnosis engine's assumed noise level. Held FIXED across every
// measurement below, deliberately independent of the *true* injected slip
// rate in (b) -- a real deployment doesn't get to know a child's true slip
// rate in advance, so this tests robustness to that mismatch rather than
// reporting an oracle best case.
const MODEL_SLIP_RATE = 0.15;

const OBS_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const INJECTED_SLIP_RATES = [0, 0.05, 0.1, 0.2];
const TRIALS_PER_COMBO = 40;

// ---------------------------------------------------------------------------
// (a) + (b): identification accuracy vs. observation count, vs. slip rate
// ---------------------------------------------------------------------------

interface SweepCell {
  obsCount: number;
  injectedSlipRate: number;
  n: number;
  top1: number;
  top1OrTied: number;
  top3: number;
}

function runSweep(): SweepCell[] {
  const cells: SweepCell[] = [];
  for (const injectedSlipRate of INJECTED_SLIP_RATES) {
    for (const obsCount of OBS_COUNTS) {
      let n = 0;
      let top1 = 0;
      let top1OrTied = 0;
      let top3 = 0;
      for (const cat of CATEGORIES) {
        for (const mr of cat.malrules) {
          for (let trial = 0; trial < TRIALS_PER_COMBO; trial++) {
            const seed = hashString(`${mr.id}:${obsCount}:${injectedSlipRate}:${trial}`);
            const rng = mulberry32(seed);
            const obs = simulateObservations(mr.id, cat.instances, obsCount, injectedSlipRate, rng);
            if (obs.length < obsCount) continue; // not enough applicable instances for this malrule
            const result = diagnose(obs, cat.instances, cat.malrules, MODEL_SLIP_RATE);
            n += 1;
            const top = result.ranked[0];
            if (top?.malruleId === mr.id) top1 += 1;
            if (result.tiedTop.includes(mr.id)) top1OrTied += 1;
            if (result.ranked.slice(0, 3).some((r) => r.malruleId === mr.id)) top3 += 1;
          }
        }
      }
      cells.push({
        obsCount,
        injectedSlipRate,
        n,
        top1: top1 / n,
        top1OrTied: top1OrTied / n,
        top3: top3 / n,
      });
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// (c) Malrule Reasoning Accuracy (MRA): infer the malrule from ONE worked
// mistake, then predict the student's answer on a new problem. Because this
// engine predicts by *executing* the diagnosed malrule rather than guessing,
// "predict correctly on the new problem" collapses to "the new problem is
// one the malrule can run on, and the malrule was correctly identified" --
// see the caveat printed in EVALUATION.md. We therefore measure, for every
// worked-mistake instance A, whether a valid new-problem partner B exists in
// the same template (same-template pair) or a different template
// (cross-template pair), and whether the single-observation diagnosis from A
// alone lands on the true malrule.
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
// (d) Ambiguity analysis: malrule pairs whose predicted answers agree on
// EVERY instance of a given template (>=3 instances where both applied),
// i.e. no amount of observation on that template alone can tell them apart.
// ---------------------------------------------------------------------------

interface AmbiguousPair {
  category: string;
  template: string;
  malruleA: string;
  malruleB: string;
  nCompared: number;
}

const MIN_INSTANCES_TO_JUDGE = 3;

function runAmbiguityAnalysis(): AmbiguousPair[] {
  const pairs: AmbiguousPair[] = [];

  for (const cat of CATEGORIES) {
    const byTemplate = new Map<string, ProblemInstance[]>();
    for (const inst of cat.instances) {
      const list = byTemplate.get(inst.template) ?? [];
      list.push(inst);
      byTemplate.set(inst.template, list);
    }

    const ids = cat.malrules.map((m) => m.id);
    for (const [template, insts] of byTemplate) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i]!;
          const b = ids[j]!;
          let compared = 0;
          let agree = 0;
          for (const inst of insts) {
            const pa = inst.predictions[a];
            const pb = inst.predictions[b];
            if (pa === undefined || pb === undefined) continue;
            compared += 1;
            if (pa === pb) agree += 1;
          }
          if (compared >= MIN_INSTANCES_TO_JUDGE && agree === compared) {
            pairs.push({ category: cat.category, template, malruleA: a, malruleB: b, nCompared: compared });
          }
        }
      }
    }
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Phase 4: adaptive vs. random problem selection. For a fixed true malrule,
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
// Markdown rendering
// ---------------------------------------------------------------------------

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function renderSweepTable(cells: SweepCell[], injectedSlipRate: number): string {
  const rows = cells.filter((c) => c.injectedSlipRate === injectedSlipRate);
  const header = "| Observations | n | Top-1 | Top-1-or-tied | Top-3 |\n|---|---|---|---|---|";
  const body = rows
    .map((r) => `| ${r.obsCount} | ${r.n} | ${pct(r.top1)} | ${pct(r.top1OrTied)} | ${pct(r.top3)} |`)
    .join("\n");
  return `${header}\n${body}`;
}

function renderAmbiguityByCategory(pairs: AmbiguousPair[]): string {
  const byCategory = new Map<string, AmbiguousPair[]>();
  for (const p of pairs) {
    const list = byCategory.get(p.category) ?? [];
    list.push(p);
    byCategory.set(p.category, list);
  }
  const sections: string[] = [];
  for (const [category, list] of byCategory) {
    const header = `**${category}** (${list.length} indistinguishable template-level pairs)\n\n| Template | Malrule A | Malrule B | Instances compared |\n|---|---|---|---|`;
    const body = list
      .sort((a, b) => a.template.localeCompare(b.template) || a.malruleA.localeCompare(b.malruleA))
      .map((p) => `| ${p.template} | ${p.malruleA} | ${p.malruleB} | ${p.nCompared} |`)
      .join("\n");
    sections.push(`${header}\n${body}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : "_No fully indistinguishable pairs found at the current sample threshold._";
}

function main() {
  console.log("Running (a)+(b) identification sweep...");
  const sweep = runSweep();

  console.log("Running (c) MRA task...");
  const mra = runMra();

  console.log("Running (d) ambiguity analysis...");
  const ambiguous = runAmbiguityAnalysis();

  console.log("Running Phase 4 adaptive vs. random selection comparison...");
  const adaptiveComparison = runAdaptiveComparison();

  const totalMalrules = CATEGORIES.reduce((s, c) => s + c.malrules.length, 0);
  const totalInstances = CATEGORIES.reduce((s, c) => s + c.instances.length, 0);

  const sameTemplate = mra.find((m) => m.pairing === "same-template")!;
  const crossTemplate = mra.find((m) => m.pairing === "cross-template")!;

  const md = `# Evaluation

All numbers below are computed against MalruleLib-generated synthetic data
only (\`data/index/\`), covering the v1 scope: ${totalMalrules} malrules across
subtraction, fractions, decimals, and multiplication/division
(${totalInstances} problem instances). **This is an upper bound.** Real
children's work is noisier than any slip-rate model here can fully capture --
see the README for the classroom-validity caveat.

The diagnosis engine's assumed noise parameter (\`slipRate\`) was held fixed at
**${MODEL_SLIP_RATE}** for every measurement below, including when the *true*
injected slip rate in (b) differs from it. This deliberately tests robustness
to not knowing a real child's slip rate in advance, rather than reporting an
oracle best case.

**Malrule identification accuracy and Malrule Reasoning Accuracy (MRA) are
different metrics.** Identification accuracy (a, b) asks only "did the
correct malrule rank first (or in the top 3)?" MRA (c) is the paper's task:
infer the malrule from one example, then predict the student's answer on a
*different* problem. Only (c) is a like-for-like comparison with the paper's
published LLM baselines (40.5% cross-template answer-only, 46.5% with step
traces).

## (a) Identification accuracy vs. number of observations (clean data)

0% injected slip, ${TRIALS_PER_COMBO} trials per malrule per observation count,
model slip rate ${MODEL_SLIP_RATE}.

${renderSweepTable(sweep, 0)}

## (b) Identification accuracy vs. number of observations, by injected slip rate

Each table uses the same trial protocol as (a) but with random slips injected
into the simulated student's answers at the stated rate (the model still
assumes slip rate ${MODEL_SLIP_RATE} throughout, regardless of the true rate).

### Injected slip rate: 5%

${renderSweepTable(sweep, 0.05)}

### Injected slip rate: 10%

${renderSweepTable(sweep, 0.1)}

### Injected slip rate: 20%

${renderSweepTable(sweep, 0.2)}

## (c) Malrule Reasoning Accuracy (MRA) -- comparable to the paper

Task: given one worked mistake on problem A (no injected noise -- a clean
example of the malrule), infer the malrule, then predict the student's answer
on a different problem B. Because this engine predicts by directly executing
the diagnosed malrule rather than guessing, a correct diagnosis on an
applicable B guarantees a correct answer prediction by construction -- so
this number is really measuring single-example identification accuracy,
restricted to worked-mistake instances that have a valid new-problem partner
of the stated kind. That collapse (identification-correct implies
answer-correct) is the central mechanical difference from the LLM setting,
where naming a misconception correctly does not guarantee simulating it
correctly on a new problem -- and is a large part of why a deterministic
engine can be expected to outperform a model doing both steps by inference.

| Pairing | n | MRA accuracy | Paper baseline (answer-only / with steps) |
|---|---|---|---|
| Same-template | ${sameTemplate.n} | ${pct(sameTemplate.top1)} | n/a (paper reports cross-template only) |
| Cross-template | ${crossTemplate.n} | ${pct(crossTemplate.top1)} | 40.5% / 46.5% |

## (d) Ambiguity analysis

Malrule pairs whose predicted answers agree on **every** instance of a given
template (minimum ${MIN_INSTANCES_TO_JUDGE} instances compared) -- meaning no
amount of observation restricted to that single template can ever tell them
apart. This is a structural property of MalruleLib's problem generators, not
a limitation of the scoring engine: on these templates, only a
differently-shaped problem (the adaptive selector's job -- see Phase 4) can
break the tie.

${renderAmbiguityByCategory(ambiguous)}

## Phase 4: adaptive vs. random problem selection

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
`;

  const outPath = path.join(ROOT, "EVALUATION.md");
  writeFileSync(outPath, md);
  console.log(`\nWrote ${outPath}`);
  console.log(`(a) clean top-1 @5 obs: ${pct(sweep.find((c) => c.injectedSlipRate === 0 && c.obsCount === 5)!.top1)}`);
  console.log(`(c) MRA cross-template: ${pct(crossTemplate.top1)} (n=${crossTemplate.n}); paper baseline 40.5%/46.5%`);
  console.log(`(d) indistinguishable pairs found: ${ambiguous.length}`);
  for (const s of adaptiveComparison) {
    console.log(
      `(Phase 4) ${s.strategy}: converged ${s.convergedCount}/${s.n}, mean obs ${s.meanObservationsAmongConverged.toFixed(2)}`
    );
  }
}

main();
