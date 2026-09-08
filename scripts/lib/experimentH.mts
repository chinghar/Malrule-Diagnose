// Experiment H -- is leave-one-out a valid proxy for an unknown procedure?
//
// Held-out MalruleLib malrules might be more similar to in-library malrules
// than a real child's invented bug would be (making Experiment A's 28%
// optimistic), or less similar (making it pessimistic) -- unknown without
// measuring it. This constructs two harder-than-leave-one-out classes of
// out-of-library procedure from what the committed index actually contains
// (no MalruleLib execution, no index rebuild -- everything here is a
// deterministic transform of existing predicted-answer strings):
//
// (b) composed bugs: two DIFFERENT library malrules' answers, alternated
//     per-observation by a fixed per-instance coin flip -- a child
//     inconsistently applying one of two candidate misconceptions, rather
//     than one malrule consistently.
// (c) perturbed bugs: one library malrule's own answer, further perturbed
//     by a small arithmetic slip (the same token-perturbation used for
//     Experiment E's independent-error generator, applied here to the
//     malrule's wrong answer instead of the correct one) -- a child whose
//     bug is *almost* a documented one but not exactly.
//
// For every class, both malrules involved (for composed bugs) or the one
// malrule (for perturbed bugs) are excluded from the candidate set, exactly
// as Experiment A excludes the held-out malrule -- so misattribution rate
// is directly comparable across all three classes. The nearest-in-library-
// neighbor distance (1 - best agreement rate against any remaining
// candidate) is also reported for each, to make the similarity gradient
// visible rather than asserted.

import { diagnose, DEFAULT_ABSTENTION_THRESHOLD } from "../../lib/diagnose/diagnose.ts";
import { hashString, mulberry32, shuffle } from "../../lib/diagnose/testSupport.ts";
import { arithmeticSlipAnswer } from "./experimentE.mts";
import type { CategoryIndex, ProblemInstance } from "../../lib/diagnose/types.ts";
import { CATEGORIES, MODEL_SLIP_RATE, pct } from "./data.mts";
import { fmtWilsonFromRate } from "./stats.mts";

const REFERENCE_OBS_COUNT = 5;
const TRIALS_PER_IDENTITY = 20;

export interface OutOfLibraryResult {
  bugClass: "a_held_out" | "b_composed" | "c_perturbed";
  label: string;
  n: number;
  misattributionRate: number;
  meanNearestNeighborDistance: number; // 1 - best agreement rate against any remaining in-library candidate
}

/** 1 - the highest answer-agreement rate this synthetic identity has with any single remaining candidate, over the instances it was actually tested on. 0 = identical to some in-library malrule everywhere tested; 1 = never agrees with anything. */
function nearestNeighborDistance(
  answersByInstance: Map<string, string>,
  candidates: { id: string }[],
  cat: CategoryIndex
): number {
  let bestAgreement = 0;
  for (const c of candidates) {
    let compared = 0;
    let agree = 0;
    for (const [instanceId, answer] of answersByInstance) {
      const inst = cat.instances.find((i) => i.instance_id === instanceId)!;
      const predicted = inst.predictions[c.id];
      if (predicted === undefined) continue;
      compared += 1;
      if (predicted === answer) agree += 1;
    }
    if (compared > 0) bestAgreement = Math.max(bestAgreement, agree / compared);
  }
  return 1 - bestAgreement;
}

// ---------------------------------------------------------------------------
// (a) held-out single malrule -- re-measured here (not just cited from
// Experiment A) so its nearest-neighbor distance is computed on an
// identical footing to (b) and (c).
// ---------------------------------------------------------------------------

function runHeldOut(): OutOfLibraryResult {
  let n = 0;
  let misattr = 0;
  const distances: number[] = [];

  for (const cat of CATEGORIES) {
    for (const mr of cat.malrules) {
      const candidates = cat.malrules.filter((x) => x.id !== mr.id);
      const applicable = cat.instances.filter((i) => i.predictions[mr.id] !== undefined);
      const answersByInstance = new Map(applicable.map((i) => [i.instance_id, i.predictions[mr.id]!]));
      distances.push(nearestNeighborDistance(answersByInstance, candidates, cat));

      for (let trial = 0; trial < TRIALS_PER_IDENTITY; trial++) {
        const rng = mulberry32(hashString(`expH-a:${mr.id}:${trial}`));
        const chosen = shuffle(applicable, rng).slice(0, REFERENCE_OBS_COUNT);
        if (chosen.length < REFERENCE_OBS_COUNT) continue;
        const obs = chosen.map((inst) => ({ instanceId: inst.instance_id, studentAnswer: inst.predictions[mr.id]! }));
        const result = diagnose(obs, cat.instances, candidates, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD);
        n += 1;
        if (!result.noPatternDetected) misattr += 1;
      }
    }
  }

  return {
    bugClass: "a_held_out",
    label: "(a) held-out library malrule",
    n,
    misattributionRate: misattr / n,
    meanNearestNeighborDistance: distances.reduce((s, d) => s + d, 0) / distances.length,
  };
}

// ---------------------------------------------------------------------------
// (b) composed bugs -- every pair of distinct malrules within a category,
// alternated per-instance by a fixed coin flip on their co-applicable
// instances.
// ---------------------------------------------------------------------------

function runComposed(): OutOfLibraryResult {
  let n = 0;
  let misattr = 0;
  const distances: number[] = [];

  for (const cat of CATEGORIES) {
    for (let i = 0; i < cat.malrules.length; i++) {
      for (let j = i + 1; j < cat.malrules.length; j++) {
        const x = cat.malrules[i]!;
        const y = cat.malrules[j]!;
        const coApplicable = cat.instances.filter(
          (inst) => inst.predictions[x.id] !== undefined && inst.predictions[y.id] !== undefined
        );
        if (coApplicable.length < REFERENCE_OBS_COUNT) continue; // not enough shared ground to test this pair fairly

        const pairSeed = mulberry32(hashString(`expH-b-identity:${x.id}:${y.id}`));
        const composedAnswer = new Map<string, string>();
        for (const inst of coApplicable) {
          const useX = pairSeed() < 0.5;
          composedAnswer.set(inst.instance_id, useX ? inst.predictions[x.id]! : inst.predictions[y.id]!);
        }

        const candidates = cat.malrules.filter((m) => m.id !== x.id && m.id !== y.id);
        distances.push(nearestNeighborDistance(composedAnswer, candidates, cat));

        for (let trial = 0; trial < TRIALS_PER_IDENTITY; trial++) {
          const rng = mulberry32(hashString(`expH-b:${x.id}:${y.id}:${trial}`));
          const chosen = shuffle(coApplicable, rng).slice(0, REFERENCE_OBS_COUNT);
          if (chosen.length < REFERENCE_OBS_COUNT) continue;
          const obs = chosen.map((inst) => ({ instanceId: inst.instance_id, studentAnswer: composedAnswer.get(inst.instance_id)! }));
          const result = diagnose(obs, cat.instances, candidates, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD);
          n += 1;
          if (!result.noPatternDetected) misattr += 1;
        }
      }
    }
  }

  return {
    bugClass: "b_composed",
    label: "(b) composed: two malrules alternated per-instance",
    n,
    misattributionRate: misattr / n,
    meanNearestNeighborDistance: distances.reduce((s, d) => s + d, 0) / distances.length,
  };
}

// ---------------------------------------------------------------------------
// (c) perturbed bugs -- one malrule's own answer, further perturbed by a
// small arithmetic slip.
// ---------------------------------------------------------------------------

function runPerturbed(): OutOfLibraryResult {
  let n = 0;
  let misattr = 0;
  const distances: number[] = [];

  for (const cat of CATEGORIES) {
    for (const mr of cat.malrules) {
      const candidates = cat.malrules.filter((x) => x.id !== mr.id);
      const applicable = cat.instances.filter((i) => i.predictions[mr.id] !== undefined);

      const identitySeed = mulberry32(hashString(`expH-c-identity:${mr.id}`));
      const perturbedAnswer = new Map<string, string>();
      for (const inst of applicable) {
        perturbedAnswer.set(inst.instance_id, arithmeticSlipAnswer(inst.predictions[mr.id]!, identitySeed));
      }
      distances.push(nearestNeighborDistance(perturbedAnswer, candidates, cat));

      for (let trial = 0; trial < TRIALS_PER_IDENTITY; trial++) {
        const rng = mulberry32(hashString(`expH-c:${mr.id}:${trial}`));
        const chosen = shuffle(applicable, rng).slice(0, REFERENCE_OBS_COUNT);
        if (chosen.length < REFERENCE_OBS_COUNT) continue;
        const obs = chosen.map((inst) => ({ instanceId: inst.instance_id, studentAnswer: perturbedAnswer.get(inst.instance_id)! }));
        const result = diagnose(obs, cat.instances, candidates, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD);
        n += 1;
        if (!result.noPatternDetected) misattr += 1;
      }
    }
  }

  return {
    bugClass: "c_perturbed",
    label: "(c) perturbed: one malrule's answer, arithmetically nudged",
    n,
    misattributionRate: misattr / n,
    meanNearestNeighborDistance: distances.reduce((s, d) => s + d, 0) / distances.length,
  };
}

export function runExperimentH(): OutOfLibraryResult[] {
  return [runHeldOut(), runComposed(), runPerturbed()];
}

export function renderMarkdown(results: OutOfLibraryResult[]): string {
  const table = `| Out-of-library class | n | Misattribution rate (95% CI, Wilson) | Mean nearest-neighbor distance |\n|---|---|---|---|\n${results
    .map((r) => `| ${r.label} | ${r.n} | ${fmtWilsonFromRate(r.misattributionRate, r.n)} | ${r.meanNearestNeighborDistance.toFixed(3)} |`)
    .join("\n")}`;

  const heldOut = results.find((r) => r.bugClass === "a_held_out")!;
  const composed = results.find((r) => r.bugClass === "b_composed")!;
  const perturbed = results.find((r) => r.bugClass === "c_perturbed")!;
  const harder = [composed, perturbed].every((r) => r.meanNearestNeighborDistance > heldOut.meanNearestNeighborDistance);
  const misattrDirection =
    composed.misattributionRate < heldOut.misattributionRate && perturbed.misattributionRate < heldOut.misattributionRate
      ? "lower"
      : composed.misattributionRate > heldOut.misattributionRate && perturbed.misattributionRate > heldOut.misattributionRate
        ? "higher"
        : "mixed";

  return `${table}

Nearest-neighbor distance measures how close each synthetic identity's
answers come to matching some single remaining in-library malrule (0 =
identical everywhere tested, e.g. \`decimals.ignore_decimal_point\` vs.
its near-twin; 1 = never matches anything). Composed and perturbed bugs
are ${harder ? "farther from any in-library neighbor than held-out malrules are" : "not consistently farther from an in-library neighbor than held-out malrules"}
(mean distance: held-out ${heldOut.meanNearestNeighborDistance.toFixed(3)}, composed
${composed.meanNearestNeighborDistance.toFixed(3)}, perturbed ${perturbed.meanNearestNeighborDistance.toFixed(3)}) --
some held-out malrules have an exact or near-exact in-library twin (Experiment
B), which composed/perturbed identities by construction cannot.

**Direction of bias:** held-out ${pct(heldOut.misattributionRate)}, composed
${pct(composed.misattributionRate)}, perturbed ${pct(perturbed.misattributionRate)}. ${
    misattrDirection === "lower"
      ? "Both harder classes misattribute LESS than held-out malrules do. Leave-one-out (Experiment A's 28% at this protocol) is therefore PESSIMISTIC as a proxy for a genuinely novel procedure -- real invented bugs, being farther from any documented malrule, are misattributed less often than held-out library malrules are."
      : misattrDirection === "higher"
        ? "Both harder classes misattribute MORE than held-out malrules do. Leave-one-out is therefore OPTIMISTIC as a proxy for a genuinely novel procedure -- held-out library malrules, despite being excluded from the candidate set, are still closer to their in-library kin than a truly novel bug would be, so real-world misattribution is likely higher than Experiment A's number suggests."
        : `The two harder classes move in OPPOSITE directions from held-out: composed bugs misattribute ${composed.misattributionRate > heldOut.misattributionRate ? "more" : "less"} often (a child inconsistently blending two candidate misconceptions is ${composed.misattributionRate > heldOut.misattributionRate ? "harder" : "easier"} for the engine to correctly flag as unrecognized than a single held-out malrule), while perturbed bugs misattribute ${perturbed.misattributionRate > heldOut.misattributionRate ? "more" : "less"} often (a numeric perturbation on top of a known malrule's answer almost never exactly coincides with any other single malrule's output, so abstention works essentially as designed). There is no single directional correction to Experiment A's 28% supported by this evidence -- whether leave-one-out is optimistic or pessimistic for a real child depends on what kind of novel bug that child actually has: blended/transitioning strategies push the true rate higher than 28%; a known bug with an extra unrelated slip pushes it far lower.`
  }`;
}
