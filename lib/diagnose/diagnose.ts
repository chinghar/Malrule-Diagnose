import type {
  DiagnosisResult,
  MalruleMeta,
  MalruleScore,
  Observation,
  ProblemInstance,
} from "./types";

/**
 * Probability a child correctly executing a malrule nonetheless produces a
 * different answer on any single problem (a slip: arithmetic error, copy
 * error, momentary lapse). Not a magic number baked into the scoring math --
 * callers must pass it explicitly; DEFAULT_SLIP_RATE is only a fallback for
 * convenience call sites.
 */
export const DEFAULT_SLIP_RATE = 0.1;

interface RawScore {
  malruleId: string;
  matches: number;
  applicable: number;
  logLikelihood: number;
  /** Sum, over applicable observations, of the chance a uniform guess lands on this malrule's answer. */
  expectedChanceMatches: number;
}

function indexInstances(instances: ProblemInstance[]): Map<string, ProblemInstance> {
  return new Map(instances.map((inst) => [inst.instance_id, inst]));
}

/**
 * Empirical probability that a uniformly random guess -- drawn from the
 * distinct answers actually observed for this instance (the correct answer
 * plus every malrule's predicted answer) -- would coincidentally equal
 * `malruleId`'s predicted answer. Grounded in the index's own data rather
 * than an assumed answer-space size.
 */
function chanceMatchRate(instance: ProblemInstance, malruleId: string): number {
  const predicted = instance.predictions[malruleId];
  if (predicted === undefined) return 0;
  const distinct = new Set<string>([instance.correct_answer, ...Object.values(instance.predictions)]);
  return 1 / distinct.size;
}

function scoreMalrule(
  malrule: MalruleMeta,
  observations: Observation[],
  instanceById: Map<string, ProblemInstance>,
  logStay: number,
  logSlip: number
): RawScore {
  let matches = 0;
  let applicable = 0;
  let logLikelihood = 0;
  let expectedChanceMatches = 0;

  for (const obs of observations) {
    const inst = instanceById.get(obs.instanceId);
    if (!inst) {
      throw new Error(`Unknown instance id: ${obs.instanceId}`);
    }
    const predicted = inst.predictions[malrule.id];
    if (predicted === undefined) continue; // not applicable to this problem shape: abstain, no update

    applicable += 1;
    expectedChanceMatches += chanceMatchRate(inst, malrule.id);

    if (predicted === obs.studentAnswer) {
      matches += 1;
      logLikelihood += logStay;
    } else {
      logLikelihood += logSlip;
    }
  }

  return { malruleId: malrule.id, matches, applicable, logLikelihood, expectedChanceMatches };
}

/**
 * Score every candidate malrule against a set of observed (problem, answer)
 * pairs under an explicit slip-rate noise model, and return a ranked
 * posterior -- never a single verdict.
 *
 * Model: if a child is executing malrule h, each observation independently
 * matches h's predicted answer with probability (1 - slipRate) and departs
 * from it (a slip) with probability slipRate. A malrule that cannot run on a
 * given instance (absent from that instance's `predictions`) is skipped for
 * that observation entirely -- it neither helps nor hurts the malrule's
 * score, matching the index's own "not applicable" semantics.
 */
export function diagnose(
  observations: Observation[],
  instances: ProblemInstance[],
  malrules: MalruleMeta[],
  slipRate: number = DEFAULT_SLIP_RATE
): DiagnosisResult {
  if (!(slipRate > 0 && slipRate < 1)) {
    throw new Error("slipRate must be strictly between 0 and 1");
  }
  if (observations.length === 0) {
    return {
      ranked: [],
      tiedTop: [],
      noPatternDetected: true,
      untested: malrules.map((m) => m.id),
      slipRate,
      observedCount: 0,
    };
  }

  const instanceById = indexInstances(instances);
  const logStay = Math.log(1 - slipRate);
  const logSlip = Math.log(slipRate);

  const raw = malrules.map((mr) => scoreMalrule(mr, observations, instanceById, logStay, logSlip));
  const untested = raw.filter((s) => s.applicable === 0).map((s) => s.malruleId);
  const applicableScores = raw.filter((s) => s.applicable > 0);

  if (applicableScores.length === 0) {
    return { ranked: [], tiedTop: [], noPatternDetected: true, untested, slipRate, observedCount: observations.length };
  }

  const maxLogL = Math.max(...applicableScores.map((s) => s.logLikelihood));
  const denom = applicableScores.reduce((sum, s) => sum + Math.exp(s.logLikelihood - maxLogL), 0);

  const ranked: MalruleScore[] = applicableScores
    .map((s) => ({
      malruleId: s.malruleId,
      matches: s.matches,
      applicable: s.applicable,
      logLikelihood: s.logLikelihood,
      posterior: Math.exp(s.logLikelihood - maxLogL) / denom,
    }))
    .sort((a, b) => b.logLikelihood - a.logLikelihood || a.malruleId.localeCompare(b.malruleId));

  const top = ranked[0];
  if (!top) {
    return { ranked, tiedTop: [], noPatternDetected: true, untested, slipRate, observedCount: observations.length };
  }

  const TIE_EPSILON = 1e-9;
  const tiedTop = ranked.filter((s) => Math.abs(s.logLikelihood - top.logLikelihood) < TIE_EPSILON).map((s) => s.malruleId);

  const topRaw = applicableScores.find((s) => s.malruleId === top.malruleId);
  const noPatternDetected = topRaw ? top.matches <= topRaw.expectedChanceMatches : true;

  return { ranked, tiedTop, noPatternDetected, untested, slipRate, observedCount: observations.length };
}
