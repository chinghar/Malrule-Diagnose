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

/**
 * Multiplier applied to the chance-expected match count when deciding
 * whether the leading malrule's evidence rises above coincidence. Abstain
 * ("no systematic pattern detected") when the leader's raw match count does
 * not exceed `abstentionThreshold * expectedChanceMatches`. 1.0 reproduces
 * the engine's original, unparameterized behavior (matches must strictly
 * exceed the chance baseline). Raising it makes abstention more likely
 * (fewer confident calls, less misattribution risk on out-of-library
 * procedures); lowering it (toward 0) makes the engine call a malrule on
 * almost any evidence at all.
 */
export const DEFAULT_ABSTENTION_THRESHOLD = 1.0;

/**
 * Alternative scoring functions, added for Experiment G ("does the finding
 * belong to the method or to this scorer?") -- behind this parameter only.
 * The existing scorer's math (the "logLikelihood" case) is untouched: every
 * other method is computed as a transform applied AFTER the same unchanged
 * per-observation loop (`scoreMalrule`), never by altering it.
 *
 * - "logLikelihood": the original, default scorer. Unchanged.
 * - "naiveExactMatch": ranks purely by raw match count, with no noise
 *   model at all (no slipRate weighting).
 * - "binomialLikelihood": the same per-observation log-likelihood plus the
 *   log binomial coefficient log(C(applicable, matches)) -- the full
 *   binomial likelihood of the observed match count, rather than the
 *   order-specific product the default scorer computes. The two agree
 *   whenever every candidate has the same `applicable` count; they can
 *   diverge when candidates differ in how many observations they could
 *   even attempt.
 * - "prevalencePrior": the same per-observation log-likelihood plus a
 *   non-uniform log-prior over malrules. MalruleLib does not expose
 *   per-malrule real-world prevalence data (checked: no such field exists
 *   in its base classes, `datagen.py`, or the shipped CSVs). As a stated,
 *   data-derived proxy, the prior weights each malrule by its own number
 *   of distinct problem templates in `instances` -- the only diversity
 *   signal MalruleLib itself provides -- normalized to a distribution over
 *   the candidate set. This is a declared modeling choice, not a claim
 *   that template count reflects true prevalence.
 *
 * `abstentionThreshold` and the abstention decision itself are unaffected
 * by this parameter: abstention compares the leading malrule's raw match
 * count to its chance baseline regardless of which method produced that
 * leader, exactly as before.
 */
export type ScoringMethod = "logLikelihood" | "naiveExactMatch" | "binomialLikelihood" | "prevalencePrior";
export const DEFAULT_SCORING_METHOD: ScoringMethod = "logLikelihood";

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

function logFactorial(n: number): number {
  let sum = 0;
  for (let i = 2; i <= n; i++) sum += Math.log(i);
  return sum;
}

/** log(C(n, k)), the log binomial coefficient. n is small throughout this domain, so a direct loop is fine. */
function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/** See ScoringMethod's "prevalencePrior" doc comment for what this is and why. */
function templateCountPrior(malrules: MalruleMeta[], instances: ProblemInstance[]): Map<string, number> {
  const templatesByMalrule = new Map<string, Set<string>>();
  for (const mr of malrules) templatesByMalrule.set(mr.id, new Set());
  for (const inst of instances) {
    templatesByMalrule.get(inst.native_malrule_id)?.add(inst.template);
  }
  const counts = new Map<string, number>();
  let total = 0;
  for (const mr of malrules) {
    const n = Math.max(1, templatesByMalrule.get(mr.id)?.size ?? 1); // floor at 1: every malrule keeps nonzero prior mass
    counts.set(mr.id, n);
    total += n;
  }
  const normalized = new Map<string, number>();
  for (const [id, n] of counts) normalized.set(id, n / total);
  return normalized;
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
 *
 * `abstentionThreshold` controls only whether `noPatternDetected` fires; it
 * never changes `ranked` or which malrule leads. See its doc comment above.
 */
export function diagnose(
  observations: Observation[],
  instances: ProblemInstance[],
  malrules: MalruleMeta[],
  slipRate: number = DEFAULT_SLIP_RATE,
  abstentionThreshold: number = DEFAULT_ABSTENTION_THRESHOLD,
  scoringMethod: ScoringMethod = DEFAULT_SCORING_METHOD
): DiagnosisResult {
  if (!(slipRate > 0 && slipRate < 1)) {
    throw new Error("slipRate must be strictly between 0 and 1");
  }
  if (!(abstentionThreshold >= 0)) {
    throw new Error("abstentionThreshold must be >= 0");
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

  // Unchanged for every scoring method: the same per-observation loop,
  // producing the same matches/applicable/logLikelihood/expectedChanceMatches.
  const raw = malrules.map((mr) => scoreMalrule(mr, observations, instanceById, logStay, logSlip));
  const untested = raw.filter((s) => s.applicable === 0).map((s) => s.malruleId);
  const applicableScores = raw.filter((s) => s.applicable > 0);

  if (applicableScores.length === 0) {
    return { ranked: [], tiedTop: [], noPatternDetected: true, untested, slipRate, observedCount: observations.length };
  }

  // Method-specific transform of the (untouched) base score. "logLikelihood"
  // is an identity transform: `score` equals `s.logLikelihood` exactly, so
  // every downstream computation below is byte-identical to the original
  // implementation for the default method.
  const prior = scoringMethod === "prevalencePrior" ? templateCountPrior(malrules, instances) : null;
  const scored = applicableScores.map((s) => {
    let score: number;
    switch (scoringMethod) {
      case "logLikelihood":
        score = s.logLikelihood;
        break;
      case "naiveExactMatch":
        score = s.matches;
        break;
      case "binomialLikelihood":
        score = s.logLikelihood + logChoose(s.applicable, s.matches);
        break;
      case "prevalencePrior":
        score = s.logLikelihood + Math.log(prior!.get(s.malruleId) ?? 1e-12);
        break;
    }
    return { ...s, logLikelihood: score };
  });

  const maxLogL = Math.max(...scored.map((s) => s.logLikelihood));
  const denom = scored.reduce((sum, s) => sum + Math.exp(s.logLikelihood - maxLogL), 0);

  const ranked: MalruleScore[] = scored
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

  // Abstention is unaffected by scoringMethod: matches/expectedChanceMatches
  // come from the unchanged base computation regardless of method.
  const topRaw = applicableScores.find((s) => s.malruleId === top.malruleId);
  const noPatternDetected = topRaw ? top.matches <= abstentionThreshold * topRaw.expectedChanceMatches : true;

  return { ranked, tiedTop, noPatternDetected, untested, slipRate, observedCount: observations.length };
}
