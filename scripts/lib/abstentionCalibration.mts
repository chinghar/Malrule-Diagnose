// Phase 1 -- calibrate the diagnoser's existing abstentionThreshold
// parameter on a disjoint held-out slice of synthetic data, BEFORE any real
// (FoundationalASSIST) data exists, and freeze the result to a committed
// config so it cannot be revisited once real data is loaded.
//
// diagnose()'s abstention mechanism (noPatternDetected / abstentionThreshold,
// lib/diagnose/diagnose.ts) already exists and is unmodified here -- this
// module only measures how it performs across a threshold grid and selects
// one value, using a pre-registered rule agreed before any sweep was run:
// the smallest grid threshold whose calibration-set top-1 precision among
// non-abstained diagnoses is >= 0.95, ties toward the lower (more
// permissive) threshold.

import { diagnose } from "../../lib/diagnose/diagnose.ts";
import { hashString, mulberry32 } from "../../lib/diagnose/testSupport.ts";
import { simulateObservations } from "../../lib/diagnose/testSupport.ts";
import type { CategoryIndex, MalruleMeta, ProblemInstance } from "../../lib/diagnose/types.ts";
import { CATEGORIES, MODEL_SLIP_RATE } from "./data.mts";

export const THRESHOLD_GRID = [0, 0.5, 1, 1.5, 2, 3, 5, 8, 12, 20];
export const REFERENCE_OBS_COUNT = 5;
export const TRIALS_PER_MALRULE = 100;
export const PRECISION_TARGET = 0.95;
export const SELECTION_RULE =
  "smallest grid threshold whose calibration-set top-1 precision among non-abstained diagnoses is >= 0.95, ties toward the lower (more permissive) threshold";
export const SPLIT_DESCRIPTION = "hashString(instance_id) % 5 !== 0 -> calibration (~80%), === 0 -> held-out (~20%)";

export interface Split {
  calibration: ProblemInstance[];
  heldOut: ProblemInstance[];
}

/** Deterministic, seed-free (hash of instance_id is fixed): re-running always reproduces the identical split. */
export function splitInstances(instances: ProblemInstance[]): Split {
  const calibration: ProblemInstance[] = [];
  const heldOut: ProblemInstance[] = [];
  for (const inst of instances) {
    if (hashString(inst.instance_id) % 5 !== 0) calibration.push(inst);
    else heldOut.push(inst);
  }
  return { calibration, heldOut };
}

export interface ThresholdPoint {
  threshold: number;
  n: number;
  abstained: number;
  nonAbstainedCorrect: number;
  abstentionRate: number;
  precision: number | null; // null when there were zero non-abstained trials
}

/**
 * Sweep the threshold grid for one malrule set, simulating genuine
 * in-library students whose observations are drawn ONLY from
 * `sampleFrom` (the calibration or held-out slice), scored against the
 * FULL category instance/malrule set (diagnose() only ever looks up
 * observed instance ids, so extra instances in scope are harmless).
 */
export function runThresholdSweep(
  cat: CategoryIndex,
  sampleFrom: ProblemInstance[],
  seedPrefix: string
): ThresholdPoint[] {
  return THRESHOLD_GRID.map((threshold) => {
    let n = 0;
    let abstained = 0;
    let nonAbstainedCorrect = 0;

    for (const mr of cat.malrules) {
      const applicablePool = sampleFrom.filter((i) => i.predictions[mr.id] !== undefined);
      if (applicablePool.length < REFERENCE_OBS_COUNT) continue; // not enough of this malrule's applicable instances in this slice
      for (let trial = 0; trial < TRIALS_PER_MALRULE; trial++) {
        const rng = mulberry32(hashString(`${seedPrefix}:${mr.id}:${trial}`));
        const obs = simulateObservations(mr.id, applicablePool, REFERENCE_OBS_COUNT, 0, rng);
        if (obs.length < REFERENCE_OBS_COUNT) continue;
        const result = diagnose(obs, cat.instances, cat.malrules, MODEL_SLIP_RATE, threshold);
        n += 1;
        if (result.noPatternDetected) {
          abstained += 1;
        } else if (result.ranked[0]?.malruleId === mr.id) {
          nonAbstainedCorrect += 1;
        }
      }
    }

    const nonAbstained = n - abstained;
    return {
      threshold,
      n,
      abstained,
      nonAbstainedCorrect,
      abstentionRate: n > 0 ? abstained / n : NaN,
      precision: nonAbstained > 0 ? nonAbstainedCorrect / nonAbstained : null,
    };
  });
}

/** Pool per-category sweeps into one set of grid points, pooled across all 26 malrules -- abstentionThreshold is a single global parameter, not category-specific. */
export function pooledSweep(sampleFromByCategory: Map<string, ProblemInstance[]>, seedPrefix: string): ThresholdPoint[] {
  const perCategory = CATEGORIES.map((cat) => runThresholdSweep(cat, sampleFromByCategory.get(cat.category)!, seedPrefix));
  return THRESHOLD_GRID.map((threshold, i) => {
    let n = 0;
    let abstained = 0;
    let nonAbstainedCorrect = 0;
    for (const sweep of perCategory) {
      const p = sweep[i]!;
      n += p.n;
      abstained += p.abstained;
      nonAbstainedCorrect += p.nonAbstainedCorrect;
    }
    const nonAbstained = n - abstained;
    return {
      threshold,
      n,
      abstained,
      nonAbstainedCorrect,
      abstentionRate: n > 0 ? abstained / n : NaN,
      precision: nonAbstained > 0 ? nonAbstainedCorrect / nonAbstained : null,
    };
  });
}

/** The pre-registered selection rule (SELECTION_RULE above), applied mechanically -- no manual override. */
export function selectThreshold(calibrationCurve: ThresholdPoint[]): number {
  const sorted = [...calibrationCurve].sort((a, b) => a.threshold - b.threshold);
  const qualifying = sorted.find((p) => p.precision !== null && p.precision >= PRECISION_TARGET);
  if (!qualifying) {
    throw new Error(
      `No grid threshold reaches ${PRECISION_TARGET * 100}% calibration-set precision -- the pre-registered rule has no answer on this grid. Not falling back to a manual choice.`
    );
  }
  return qualifying.threshold;
}

export interface CalibrationResult {
  calibrationCurve: ThresholdPoint[];
  heldOutCurve: ThresholdPoint[];
  chosenThreshold: number;
  heldOutAtChosenThreshold: ThresholdPoint;
  calibrationInstanceIds: string[];
  heldOutInstanceIds: string[];
}

export function runCalibration(): CalibrationResult {
  const calibrationByCategory = new Map<string, ProblemInstance[]>();
  const heldOutByCategory = new Map<string, ProblemInstance[]>();
  const calibrationInstanceIds: string[] = [];
  const heldOutInstanceIds: string[] = [];

  for (const cat of CATEGORIES) {
    const { calibration, heldOut } = splitInstances(cat.instances);
    calibrationByCategory.set(cat.category, calibration);
    heldOutByCategory.set(cat.category, heldOut);
    calibrationInstanceIds.push(...calibration.map((i) => i.instance_id));
    heldOutInstanceIds.push(...heldOut.map((i) => i.instance_id));
  }

  const calibrationCurve = pooledSweep(calibrationByCategory, "abstention-calib");
  const chosenThreshold = selectThreshold(calibrationCurve);

  const heldOutCurve = pooledSweep(heldOutByCategory, "abstention-heldout");
  const heldOutAtChosenThreshold = heldOutCurve.find((p) => p.threshold === chosenThreshold)!;

  return {
    calibrationCurve,
    heldOutCurve,
    chosenThreshold,
    heldOutAtChosenThreshold,
    calibrationInstanceIds: calibrationInstanceIds.sort(),
    heldOutInstanceIds: heldOutInstanceIds.sort(),
  };
}
