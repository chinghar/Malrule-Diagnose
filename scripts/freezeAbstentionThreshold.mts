// Phase 1 -- run the abstention-threshold calibration and freeze the result
// to config/abstention.json. This is the pre-registration artifact: seed,
// calibration-set hash, and a UTC timestamp are committed alongside the
// chosen threshold, and lib/diagnose/frozenAbstentionConfig.mts refuses to
// load a config whose content has been altered since freezing (detected via
// selfHash, not file mtime, since checkouts don't preserve original mtimes).
//
// Deterministic and side-effect-free beyond the write: no RNG seed here
// depends on wall-clock time, so re-running reproduces an identical
// abstentionThreshold, seed, and calibrationSetHash -- only timestampUtc and
// selfHash (which incorporates it) change on re-freeze. That is intentional:
// the timestamp records *when this was frozen*, not a tunable input.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  runCalibration,
  THRESHOLD_GRID,
  REFERENCE_OBS_COUNT,
  TRIALS_PER_MALRULE,
  PRECISION_TARGET,
  SELECTION_RULE,
  SPLIT_DESCRIPTION,
} from "./lib/abstentionCalibration.mts";
import { MODEL_SLIP_RATE, pct } from "./lib/data.mts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, "..", "config", "abstention.json");

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function main() {
  console.log("Running abstention-threshold calibration on the held-out synthetic split...");
  const result = runCalibration();

  const calibrationSetHash = sha256(result.calibrationInstanceIds.join(","));
  const heldOutSetHash = sha256(result.heldOutInstanceIds.join(","));

  const configWithoutSelfHash = {
    abstentionThreshold: result.chosenThreshold,
    seed: "abstention-calib / abstention-heldout (see scripts/lib/abstentionCalibration.mts seed prefixes; fully deterministic, no wall-clock dependency)",
    selectionRule: SELECTION_RULE,
    precisionTarget: PRECISION_TARGET,
    thresholdGrid: THRESHOLD_GRID,
    referenceObsCount: REFERENCE_OBS_COUNT,
    trialsPerMalrule: TRIALS_PER_MALRULE,
    modelSlipRate: MODEL_SLIP_RATE,
    splitDescription: SPLIT_DESCRIPTION,
    calibrationInstanceCount: result.calibrationInstanceIds.length,
    heldOutInstanceCount: result.heldOutInstanceIds.length,
    calibrationSetHash,
    heldOutSetHash,
    calibrationCurve: result.calibrationCurve,
    heldOutCurve: result.heldOutCurve,
    heldOutAtChosenThreshold: result.heldOutAtChosenThreshold,
    timestampUtc: new Date().toISOString(),
  };

  const selfHash = sha256(JSON.stringify(configWithoutSelfHash));
  const config = { ...configWithoutSelfHash, selfHash };

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log(`\nWrote ${CONFIG_PATH}`);

  console.log(`\nChosen abstentionThreshold: ${result.chosenThreshold}`);
  console.log("\nCalibration-set curve (threshold | n | abstention rate | precision):");
  for (const p of result.calibrationCurve) {
    console.log(
      `  ${p.threshold} | n=${p.n} | abstain=${pct(p.abstentionRate)} | precision=${p.precision !== null ? pct(p.precision) : "n/a (0 non-abstained)"}`
    );
  }
  console.log("\nHeld-out-set curve (not used for selection, reported for pre-registration):");
  for (const p of result.heldOutCurve) {
    console.log(
      `  ${p.threshold} | n=${p.n} | abstain=${pct(p.abstentionRate)} | precision=${p.precision !== null ? pct(p.precision) : "n/a (0 non-abstained)"}`
    );
  }
  console.log(
    `\nAt the chosen threshold (${result.chosenThreshold}) on held-out data: abstain=${pct(result.heldOutAtChosenThreshold.abstentionRate)}, precision=${
      result.heldOutAtChosenThreshold.precision !== null ? pct(result.heldOutAtChosenThreshold.precision) : "n/a"
    }, n=${result.heldOutAtChosenThreshold.n}`
  );
}

main();
