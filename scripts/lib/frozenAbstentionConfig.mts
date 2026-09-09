// Phase 1 -- loader for the frozen, pre-registered abstention threshold
// (config/abstention.json, written by scripts/freezeAbstentionThreshold.mts).
//
// Any future real-data (FoundationalASSIST) harness must read the threshold
// through this loader, not import a hardcoded number: it recomputes the
// config's own content hash and REFUSES to load if it doesn't match the
// committed selfHash, so a threshold cannot be quietly edited after seeing
// real data and still pass as "the frozen, pre-registered value." Content
// hashing is used rather than file mtime, since a git clone/checkout does
// not preserve the original freeze-time mtime.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(ROOT, "..", "..", "config", "abstention.json");

export interface ThresholdPointJson {
  threshold: number;
  n: number;
  abstained: number;
  nonAbstainedCorrect: number;
  abstentionRate: number;
  precision: number | null;
}

export interface FrozenAbstentionConfig {
  abstentionThreshold: number;
  seed: string;
  selectionRule: string;
  precisionTarget: number;
  thresholdGrid: number[];
  referenceObsCount: number;
  trialsPerMalrule: number;
  modelSlipRate: number;
  splitDescription: string;
  calibrationInstanceCount: number;
  heldOutInstanceCount: number;
  calibrationSetHash: string;
  heldOutSetHash: string;
  calibrationCurve: ThresholdPointJson[];
  heldOutCurve: ThresholdPointJson[];
  heldOutAtChosenThreshold: ThresholdPointJson;
  timestampUtc: string;
  selfHash: string;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Loads and integrity-checks the frozen abstention config. Throws --
 * refuses to return a value -- if the file is missing, malformed, or its
 * content hash doesn't match the committed `selfHash`, i.e. if it has been
 * modified since scripts/freezeAbstentionThreshold.mts wrote it.
 */
export function loadFrozenAbstentionConfig(configPath: string = DEFAULT_CONFIG_PATH): FrozenAbstentionConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new Error(`Frozen abstention config not found at ${configPath}. Run scripts/freezeAbstentionThreshold.mts first. (${err})`);
  }

  let parsed: FrozenAbstentionConfig;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Frozen abstention config at ${configPath} is not valid JSON: ${err}`);
  }

  const { selfHash, ...rest } = parsed;
  if (typeof selfHash !== "string" || selfHash.length === 0) {
    throw new Error(`Frozen abstention config at ${configPath} has no selfHash -- cannot verify it hasn't been modified. Refusing to load.`);
  }

  const recomputed = sha256(JSON.stringify(rest));
  if (recomputed !== selfHash) {
    throw new Error(
      `Frozen abstention config at ${configPath} has been modified since it was frozen: ` +
        `content hash ${recomputed} does not match committed selfHash ${selfHash}. ` +
        `The threshold selection is pre-registered and must not be edited after the fact. ` +
        `If a genuine re-calibration is intended, re-run scripts/freezeAbstentionThreshold.mts to produce a new, self-consistent config.`
    );
  }

  return parsed;
}
