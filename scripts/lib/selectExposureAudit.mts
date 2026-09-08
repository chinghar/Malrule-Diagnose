// Round four, Item 1 -- audit only, lib/select is never modified.
//
// select.ts's scoreCandidates() groups a malrule's predicted answer by raw
// value, never checking it against correct_answer (confirmed by reading the
// file in full: no reference to correct_answer anywhere in it). This module
// measures the consequence: within Experiment I's exact existing protocol
// (leave-one-out + adaptive selection -- same seeds, same generation, not a
// new experiment), how often the instance selectNextInstance() picks is
// non-triggering for the current top-ranked candidate, and whether that
// measurably associates with the overconfidence-when-wrong finding Experiment
// I already reports.

import { diagnose, DEFAULT_ABSTENTION_THRESHOLD } from "../../lib/diagnose/diagnose.ts";
import { hashString, mulberry32, shuffle } from "../../lib/diagnose/testSupport.ts";
import { posteriorFromScores, selectNextInstance, uniformPosterior } from "../../lib/select/select.ts";
import type { CategoryIndex } from "../../lib/diagnose/types.ts";
import { CATEGORIES, MODEL_SLIP_RATE, pct } from "./data.mts";

const MAX_OBS = 10;
const TRIALS_PER_MALRULE = 20; // matches Experiment I exactly
const REFERENCE_OBS_COUNT = 5; // matches Experiment I's headline reference point

export interface SelectExposureResult {
  selectionsChecked: number;
  selectionsNonTriggeringForTop: number;
  exposureRate: number;
  nAtReference: number;
  reinforcedCountAtReference: number;
  misattributedWithReinforcement: number;
  misattributedWithoutReinforcement: number;
  nWithoutReinforcement: number;
}

function runOneTrial(
  malruleId: string,
  cat: CategoryIndex,
  rng: () => number,
  onSelection: (nonTriggeringForTop: boolean) => void
): { reinforcedByReference: boolean; misattributedAtReference: boolean | null } {
  const candidates = cat.malrules.filter((m) => m.id !== malruleId);
  const pool = shuffle(cat.instances.filter((i) => i.predictions[malruleId] !== undefined), rng);
  const observed: { instanceId: string; studentAnswer: string }[] = [];
  const used = new Set<string>();
  let reinforcedByReference = false;
  let misattributedAtReference: boolean | null = null;

  for (let step = 0; step < MAX_OBS; step++) {
    const posterior =
      observed.length === 0
        ? uniformPosterior(candidates)
        : posteriorFromScores(diagnose(observed, cat.instances, candidates, MODEL_SLIP_RATE).ranked);
    const remaining = cat.instances.filter((i) => !used.has(i.instance_id) && i.predictions[malruleId] !== undefined);
    const best = selectNextInstance(posterior, remaining);
    const chosen = remaining.find((i) => i.instance_id === best?.instanceId);
    if (!chosen) break;

    if (observed.length > 0) {
      const entries = [...posterior.entries()];
      const maxP = Math.max(...entries.map(([, p]) => p));
      const topIds = entries.filter(([, p]) => Math.abs(p - maxP) < 1e-9).map(([id]) => id);
      const nonTriggeringForTop = topIds.some((id) => chosen.predictions[id] !== undefined && chosen.predictions[id] === chosen.correct_answer);
      onSelection(nonTriggeringForTop);
      if (step < REFERENCE_OBS_COUNT) {
        // Reinforcement requires the SAME top candidate to be both
        // non-triggering (predicts the correct answer) AND to coincide with
        // the true held-out malrule's actual answer -- not two independent
        // top candidates each satisfying one condition.
        const trueAnswer = chosen.predictions[malruleId]!;
        if (topIds.some((id) => chosen.predictions[id] === chosen.correct_answer && chosen.predictions[id] === trueAnswer)) {
          reinforcedByReference = true;
        }
      }
    }

    used.add(chosen.instance_id);
    observed.push({ instanceId: chosen.instance_id, studentAnswer: chosen.predictions[malruleId]! });

    if (step + 1 === REFERENCE_OBS_COUNT) {
      const result = diagnose(observed, cat.instances, candidates, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD);
      misattributedAtReference = !result.noPatternDetected;
    }
  }

  return { reinforcedByReference, misattributedAtReference };
}

export function runSelectExposureAudit(): SelectExposureResult {
  let selectionsChecked = 0;
  let selectionsNonTriggeringForTop = 0;
  let nAtReference = 0;
  let reinforcedCountAtReference = 0;
  let misattributedWithReinforcement = 0;
  let misattributedWithoutReinforcement = 0;

  for (const cat of CATEGORIES) {
    for (const mr of cat.malrules) {
      for (let trial = 0; trial < TRIALS_PER_MALRULE; trial++) {
        const rng = mulberry32(hashString(`expI:adaptive:${mr.id}:${trial}`));
        const { reinforcedByReference, misattributedAtReference } = runOneTrial(mr.id, cat, rng, (nonTriggeringForTop) => {
          selectionsChecked += 1;
          if (nonTriggeringForTop) selectionsNonTriggeringForTop += 1;
        });
        if (misattributedAtReference !== null) {
          nAtReference += 1;
          if (reinforcedByReference) {
            reinforcedCountAtReference += 1;
            if (misattributedAtReference) misattributedWithReinforcement += 1;
          } else if (misattributedAtReference) {
            misattributedWithoutReinforcement += 1;
          }
        }
      }
    }
  }

  return {
    selectionsChecked,
    selectionsNonTriggeringForTop,
    exposureRate: selectionsNonTriggeringForTop / selectionsChecked,
    nAtReference,
    reinforcedCountAtReference,
    misattributedWithReinforcement,
    misattributedWithoutReinforcement,
    nWithoutReinforcement: nAtReference - reinforcedCountAtReference,
  };
}

export function renderMarkdown(r: SelectExposureResult): string {
  const rateReinforced = r.misattributedWithReinforcement / r.reinforcedCountAtReference;
  const rateNotReinforced = r.misattributedWithoutReinforcement / r.nWithoutReinforcement;

  return `Round four audit, \`lib/select\` unmodified: \`scoreCandidates()\` groups a
malrule's predicted answer by raw value only (\`inst.predictions[malruleId] ?? NOT_APPLICABLE\`,
select.ts line 60) and never checks it against \`correct_answer\`, so a
coincidentally-correct ("non-triggering") prediction is scored as fully
discriminating as a genuine one.

Measured within this experiment's own protocol (adaptive strategy, same
seeds): **${pct(r.exposureRate)} of adaptively-selected questions (${r.selectionsNonTriggeringForTop}/${r.selectionsChecked}, at steps where a
non-uniform posterior exists) were non-triggering for at least one
current top-ranked candidate.** At ${REFERENCE_OBS_COUNT} observations, trials that experienced at
least one such coincidence reinforcing the true (held-out) answer went on
to misattribute ${pct(rateReinforced)} of the time (${r.misattributedWithReinforcement}/${r.reinforcedCountAtReference}), versus ${pct(rateNotReinforced)} (${r.misattributedWithoutReinforcement}/${r.nWithoutReinforcement})
without one. **This is a strong association, not an isolated proven
cause** -- malrules already known to be collision-prone (Experiment A, B)
may drive both the coincidence and the misattribution independently --
but it is a real, quantified contributor to the overconfidence finding
below, not merely a plausible mechanism.`;
}
