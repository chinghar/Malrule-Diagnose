// Shared identification-accuracy sweep, used both for measurements (a)/(b)
// (evaluate.mts, with the engine's fixed assumed slip rate) and for
// Experiment D's oracle-calibrated ceiling (experimentD.mts, with the model
// slip rate matched exactly to the true injected rate). Both call sites
// share this one trial generator so their seeds -- and therefore their
// sampled observations -- are identical, making the comparison apples to
// apples rather than two independently-sampled runs.

import { diagnose } from "../../lib/diagnose/diagnose.ts";
import { hashString, mulberry32, simulateObservations } from "../../lib/diagnose/testSupport.ts";
import { CATEGORIES, MODEL_SLIP_RATE } from "./data.mts";

export const OBS_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export const INJECTED_SLIP_RATES = [0, 0.05, 0.1, 0.2];
export const TRIALS_PER_COMBO = 40;

export interface SweepCell {
  obsCount: number;
  injectedSlipRate: number;
  n: number;
  top1: number;
  top1OrTied: number;
  top3: number;
}

/**
 * @param modelSlipRateFor Given the true injected slip rate for a cell,
 *   returns the slip rate the engine should assume when scoring. Defaults
 *   to the engine's fixed, possibly-misspecified assumption (measurements
 *   (a)/(b)'s behavior, unchanged). Experiment D passes an oracle callback
 *   that returns the injected rate itself (clamped away from 0), to measure
 *   the ceiling achievable with zero misspecification.
 */
export function runSweep(modelSlipRateFor: (injectedSlipRate: number) => number = () => MODEL_SLIP_RATE): SweepCell[] {
  const cells: SweepCell[] = [];
  for (const injectedSlipRate of INJECTED_SLIP_RATES) {
    for (const obsCount of OBS_COUNTS) {
      let n = 0;
      let top1 = 0;
      let top1OrTied = 0;
      let top3 = 0;
      const modelSlipRate = modelSlipRateFor(injectedSlipRate);
      for (const cat of CATEGORIES) {
        for (const mr of cat.malrules) {
          for (let trial = 0; trial < TRIALS_PER_COMBO; trial++) {
            const seed = hashString(`${mr.id}:${obsCount}:${injectedSlipRate}:${trial}`);
            const rng = mulberry32(seed);
            const obs = simulateObservations(mr.id, cat.instances, obsCount, injectedSlipRate, rng);
            if (obs.length < obsCount) continue; // not enough applicable instances for this malrule
            const result = diagnose(obs, cat.instances, cat.malrules, modelSlipRate);
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
