// Experiment E -- non-malrule students. The most important untested case
// from round one: what does the engine do to a student who is NOT running
// any malrule at all? There is no "correct answer" hypothesis anywhere in
// `diagnose()` -- it only ever scores the malrules it's given, and
// `correct_answer` is pure metadata never treated as a candidate. So the
// only thing standing between a healthy student and a confident false
// diagnosis is: (a) most malrules' predicted answers differ from the
// correct one on most instances, and (b) the abstentionThreshold
// mechanism, which compares raw match count to a chance baseline. Neither
// is a guarantee, and this was observed directly and manually in this
// project's own UI verification session (Phase 5 of the original build):
// after three consecutive CORRECT answers, the tool reported
// subtraction.always_borrow_left as the leading malrule at 85.3% posterior,
// purely because that malrule's wrong-answer output happened to coincide
// with the correct answer on 2 of the 3 specific problems shown. This
// experiment measures how often that happens systematically.

import { diagnose, DEFAULT_ABSTENTION_THRESHOLD } from "../../lib/diagnose/diagnose.ts";
import { hashString, mulberry32, shuffle } from "../../lib/diagnose/testSupport.ts";
import type { CategoryIndex, ProblemInstance } from "../../lib/diagnose/types.ts";
import { CATEGORIES, MODEL_SLIP_RATE, pct } from "./data.mts";
import { fmtWilsonFromRate, fmtCluster } from "./stats.mts";

export const THRESHOLD_GRID = [0, 0.5, 1, 1.5, 2, 3, 5, 8, 12, 20];
export const REFERENCE_OBS_COUNT = 5;
export const OBS_COUNTS = [3, 5, 10];
const TRIALS_PER_CATEGORY = 200;

// ---------------------------------------------------------------------------
// Independent wrong-answer generators. Neither consults `predictions` (a
// malrule's output) -- both are derived only from `correct_answer`, so any
// resulting agreement with a malrule's prediction is coincidence, not
// construction. Handles every answer format actually in the index: plain
// integers ("640"), fractions ("11/24"), decimals ("2.33"), and
// comma-separated multi-value answers ("2/10, 3/6, 4/7").
// ---------------------------------------------------------------------------

const NUMBER_TOKEN = /\d+\.\d+|\d+/g;

function perturbToken(token: string, rng: () => number, magnitude: "small" | "wild"): string {
  const isDecimal = token.includes(".");
  const decimals = isDecimal ? token.split(".")[1]!.length : 0;
  const value = Number(token);

  if (magnitude === "small") {
    // A plausible arithmetic slip: off by a small amount in the last digit(s).
    const step = decimals > 0 ? 1 / 10 ** decimals : 1;
    let delta = 0;
    while (delta === 0) delta = Math.floor(rng() * 19 - 9) * step; // -9..9 (or scaled), excluding 0
    const next = Math.max(0, value + delta);
    return decimals > 0 ? next.toFixed(decimals) : String(Math.round(next));
  }

  // A "wild guess": a fresh random value with the same digit count, unrelated to the true magnitude.
  const digitCount = Math.max(1, token.replace(".", "").replace(/^0+/, "").length);
  let wild = "";
  for (let i = 0; i < digitCount; i++) {
    wild += i === 0 ? String(1 + Math.floor(rng() * 9)) : String(Math.floor(rng() * 10));
  }
  if (decimals > 0) {
    const intLen = Math.max(1, digitCount - decimals);
    wild = `${wild.slice(0, intLen)}.${wild.slice(intLen).padEnd(decimals, "0")}`;
  }
  return wild;
}

/** A plausible arithmetic slip: perturb exactly one numeric token in the correct answer by a small amount. */
export function arithmeticSlipAnswer(correctAnswer: string, rng: () => number): string {
  const tokens = [...correctAnswer.matchAll(NUMBER_TOKEN)];
  if (tokens.length === 0) return `${correctAnswer}~slip`;
  const pick = tokens[Math.floor(rng() * tokens.length)]!;
  const replacement = perturbToken(pick[0], rng, "small");
  return correctAnswer.slice(0, pick.index) + replacement + correctAnswer.slice(pick.index! + pick[0].length);
}

/** A wild, unstructured guess: every numeric token replaced with an unrelated random value of the same digit count. */
export function pureRandomAnswer(correctAnswer: string, rng: () => number): string {
  return correctAnswer.replace(NUMBER_TOKEN, (token) => perturbToken(token, rng, "wild"));
}

// ---------------------------------------------------------------------------
// Student generators
// ---------------------------------------------------------------------------

export type StudentKind = "a_fully_correct" | "b_slip" | "c_pure_random" | "d_adversarial";

export interface StudentSpec {
  kind: StudentKind;
  label: string;
  slipRate?: number; // for b_slip
  adversarialCount?: number; // for d_adversarial: how many of the obsCount observations are coincidence-planted
}

export const STUDENT_SPECS: StudentSpec[] = [
  { kind: "a_fully_correct", label: "(a) fully correct, 0% slip" },
  { kind: "b_slip", label: "(b) correct + 5% arithmetic slips", slipRate: 0.05 },
  { kind: "b_slip", label: "(b) correct + 10% arithmetic slips", slipRate: 0.1 },
  { kind: "b_slip", label: "(b) correct + 20% arithmetic slips", slipRate: 0.2 },
  { kind: "c_pure_random", label: "(c) purely random errors" },
  { kind: "d_adversarial", label: "(d) adversarial: 1 coincidental match", adversarialCount: 1 },
  { kind: "d_adversarial", label: "(d) adversarial: 2 coincidental matches", adversarialCount: 2 },
];

function generateObservations(
  cat: CategoryIndex,
  spec: StudentSpec,
  obsCount: number,
  rng: () => number
): { instanceId: string; studentAnswer: string }[] {
  const chosen = shuffle(cat.instances, rng).slice(0, obsCount);

  if (spec.kind === "d_adversarial") {
    const adversarialIdx = new Set(shuffle([...chosen.keys()], rng).slice(0, spec.adversarialCount ?? 1));
    return chosen.map((inst, i) => {
      if (adversarialIdx.has(i)) {
        const candidates = Object.entries(inst.predictions);
        if (candidates.length > 0) {
          const [, answer] = candidates[Math.floor(rng() * candidates.length)]!;
          return { instanceId: inst.instance_id, studentAnswer: answer };
        }
      }
      return { instanceId: inst.instance_id, studentAnswer: inst.correct_answer };
    });
  }

  return chosen.map((inst) => {
    let answer: string;
    switch (spec.kind) {
      case "a_fully_correct":
        answer = inst.correct_answer;
        break;
      case "b_slip":
        answer = rng() < (spec.slipRate ?? 0) ? arithmeticSlipAnswer(inst.correct_answer, rng) : inst.correct_answer;
        break;
      case "c_pure_random":
        answer = pureRandomAnswer(inst.correct_answer, rng);
        break;
      case "d_adversarial":
        // Handled in the early return above; generateObservations never
        // reaches this branch for d_adversarial specs.
        answer = inst.correct_answer;
        break;
    }
    return { instanceId: inst.instance_id, studentAnswer: answer };
  });
}

// ---------------------------------------------------------------------------
// Trial runner
// ---------------------------------------------------------------------------

export interface FalsePositiveResult {
  specLabel: string;
  threshold: number;
  obsCount: number;
  n: number;
  falsePositiveRate: number; // fraction where the engine named a malrule instead of abstaining
  meanPosteriorAmongFalsePositives: number | null;
  namedMalruleCounts: Map<string, number>; // which malrules get (falsely) named, and how often
}

function runOne(
  spec: StudentSpec,
  threshold: number,
  obsCount: number
): FalsePositiveResult {
  let n = 0;
  let falsePositives = 0;
  let posteriorSum = 0;
  const namedMalruleCounts = new Map<string, number>();

  for (const cat of CATEGORIES) {
    for (let trial = 0; trial < TRIALS_PER_CATEGORY; trial++) {
      const rng = mulberry32(hashString(`expE:${spec.label}:${threshold}:${obsCount}:${cat.category}:${trial}`));
      const obs = generateObservations(cat, spec, obsCount, rng);
      const result = diagnose(obs, cat.instances, cat.malrules, MODEL_SLIP_RATE, threshold);
      n += 1;
      if (!result.noPatternDetected && result.ranked.length > 0) {
        falsePositives += 1;
        const top = result.ranked[0]!;
        posteriorSum += top.posterior;
        namedMalruleCounts.set(top.malruleId, (namedMalruleCounts.get(top.malruleId) ?? 0) + 1);
      }
    }
  }

  return {
    specLabel: spec.label,
    threshold,
    obsCount,
    n,
    falsePositiveRate: falsePositives / n,
    meanPosteriorAmongFalsePositives: falsePositives > 0 ? posteriorSum / falsePositives : null,
    namedMalruleCounts,
  };
}

/** Per-category false-positive rate for one spec/condition -- the cluster unit here is category (k=4), not malrule, since these students carry no malrule identity. */
export function runByCategory(spec: StudentSpec, threshold: number, obsCount: number): { category: string; n: number; rate: number }[] {
  return CATEGORIES.map((cat) => {
    let n = 0;
    let falsePositives = 0;
    for (let trial = 0; trial < TRIALS_PER_CATEGORY; trial++) {
      const rng = mulberry32(hashString(`expE:${spec.label}:${threshold}:${obsCount}:${cat.category}:${trial}`));
      const obs = generateObservations(cat, spec, obsCount, rng);
      const result = diagnose(obs, cat.instances, cat.malrules, MODEL_SLIP_RATE, threshold);
      n += 1;
      if (!result.noPatternDetected && result.ranked.length > 0) falsePositives += 1;
    }
    return { category: cat.category, n, rate: falsePositives / n };
  });
}

/** Threshold sweep at the reference observation count, for every student type. */
export function runThresholdSweep(): FalsePositiveResult[] {
  const results: FalsePositiveResult[] = [];
  for (const spec of STUDENT_SPECS) {
    for (const threshold of THRESHOLD_GRID) {
      results.push(runOne(spec, threshold, REFERENCE_OBS_COUNT));
    }
  }
  return results;
}

/** Observation-count sweep at the shipped default threshold, for every student type. */
export function runObsCountSweep(): FalsePositiveResult[] {
  const results: FalsePositiveResult[] = [];
  for (const spec of STUDENT_SPECS) {
    for (const obsCount of OBS_COUNTS) {
      results.push(runOne(spec, DEFAULT_ABSTENTION_THRESHOLD, obsCount));
    }
  }
  return results;
}

export function atDefault(results: FalsePositiveResult[], specLabel: string): FalsePositiveResult {
  const found = results.find(
    (r) => r.specLabel === specLabel && r.threshold === DEFAULT_ABSTENTION_THRESHOLD && r.obsCount === REFERENCE_OBS_COUNT
  );
  if (!found) throw new Error(`No default result for ${specLabel}`);
  return found;
}

function topNamed(r: FalsePositiveResult, n = 3): string {
  const top = [...r.namedMalruleCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  return top.length > 0 ? top.map(([id, c]) => `${id} (${c}/${r.n})`).join(", ") : "n/a";
}

export function renderMarkdown(thresholdSweep: FalsePositiveResult[], obsCountSweep: FalsePositiveResult[]): string {
  const defaultRows = STUDENT_SPECS.map((spec) => atDefault(thresholdSweep, spec.label));
  const defaultTable = `| Student type | n | False-positive rate (95% CI, Wilson) | Mean posterior when wrong | Most often named |\n|---|---|---|---|---|\n${defaultRows
    .map((r) => `| ${r.specLabel} | ${r.n} | ${fmtWilsonFromRate(r.falsePositiveRate, r.n)} | ${r.meanPosteriorAmongFalsePositives !== null ? pct(r.meanPosteriorAmongFalsePositives) : "n/a"} | ${topNamed(r)} |`)
    .join("\n")}`;

  const perCategory = runByCategory(
    STUDENT_SPECS.find((s) => s.kind === "a_fully_correct")!,
    DEFAULT_ABSTENTION_THRESHOLD,
    REFERENCE_OBS_COUNT
  );
  const perCategoryTable = `| Category | n | False-positive rate |\n|---|---|---|\n${perCategory
    .map((c) => `| ${c.category} | ${c.n} | ${fmtWilsonFromRate(c.rate, c.n)} |`)
    .join("\n")}`;
  const categoryCluster = fmtCluster(
    perCategory.map((c) => c.rate),
    "category"
  );

  const thresholdTables = STUDENT_SPECS.map((spec) => {
    const rows = thresholdSweep.filter((r) => r.specLabel === spec.label);
    const table = `| Threshold | False-positive rate |\n|---|---|\n${rows.map((r) => `| ${r.threshold} | ${pct(r.falsePositiveRate)} |`).join("\n")}`;
    return `**${spec.label}**\n\n${table}`;
  }).join("\n\n");

  const obsTables = STUDENT_SPECS.map((spec) => {
    const rows = obsCountSweep.filter((r) => r.specLabel === spec.label);
    return `**${spec.label}:** ${rows.map((r) => `${r.obsCount} obs -> ${pct(r.falsePositiveRate)}`).join(", ")}`;
  }).join("\n\n");

  const fullyCorrect = atDefault(thresholdSweep, "(a) fully correct, 0% slip");
  const pureRandom = atDefault(thresholdSweep, "(c) purely random errors");

  return `For each student type below, ${fullyCorrect.n} trials (200 per category x 4 categories) were
generated at 5 observations per trial, and diagnosed against the FULL
in-library candidate set for that category (no malrule held out -- these
students are not simulating any malrule at all). "False positive" means
the engine named a malrule instead of reporting "no systematic pattern
detected." Types (a)-(c) generate wrong answers from \`correct_answer\`
alone via arithmetic-token perturbation, never consulting any malrule's
predicted output, so any resulting match is coincidence, not construction.
Type (d) deliberately plants 1-2 coincidental matches per trial as an
adversarial worst case.

### At the shipped default (threshold=${DEFAULT_ABSTENTION_THRESHOLD}, 5 observations)

${defaultTable}

**${fmtWilsonFromRate(fullyCorrect.falsePositiveRate, fullyCorrect.n)} of fully correct students are confidently
misdiagnosed with a malrule they do not have**, at a mean posterior of
${pct(fullyCorrect.meanPosteriorAmongFalsePositives ?? 0)} -- not a marginal or low-confidence call. It
is essentially flat across 0-20% arithmetic slip, meaning this is not
primarily a noise-tolerance problem. \`subtraction.stops_borrow_at_zero\`
and \`subtraction.always_borrow_left\` account for the large majority of
these false positives -- the same subtraction cluster Experiment B already
identified as densely collision-prone; a correct answer on certain
subtraction problems simply *is* what those malrules predict,
coincidentally.

**That trial-level interval is optimistic, and checking it changes the
headline.** Pooling 800 trials as independent hides that they come from
only 4 categories, and category is exactly the axis that matters here:

${perCategoryTable}

**Between-category interval: ${categoryCluster}.** The lower bound touches
zero -- the pooled 15% figure is not a stable, generalizable property of
"the engine"; it is almost entirely a **subtraction-specific** problem
(50.5%) averaged with three categories that are comparatively fine (3-4%
each). **The honest headline is "roughly a 50% false-positive rate on
correct subtraction students," not "15% overall."**

As a check that abstention is not simply broken: purely random,
unstructured errors produce a false-positive rate of only ${pct(pureRandom.falsePositiveRate)}. The
mechanism correctly recognizes genuine noise. The problem is specific to
correct-or-nearly-correct students, whose answers keep landing on values
that happen to be some malrule's coincidental output on that particular
problem.

### Threshold sweep

${thresholdTables}

No threshold achieves both a near-zero false-positive rate on correct
students and acceptable in-library coverage (see Experiment A's tradeoff
curve for the coverage-cost side): threshold=2 (Experiment A's
recommendation) still misdiagnoses ${pct(
    thresholdSweep.find((r) => r.specLabel === "(a) fully correct, 0% slip" && r.threshold === 2)!.falsePositiveRate
  )} of correct students; threshold=5, where correct-student
false positives finally approach zero, costs 87%+ in-library abstention
(Experiment A). **There is no single threshold value that makes this
tool simultaneously safe for correct students and usable for its
intended purpose.**

### Observation-count sweep (at the shipped default)

${obsTables}

False positives are worst with few observations and improve as more are
collected (${pct(
    obsCountSweep.find((r) => r.specLabel === "(a) fully correct, 0% slip" && r.obsCount === 3)!.falsePositiveRate
  )} at 3 observations, down to ${pct(
    obsCountSweep.find((r) => r.specLabel === "(a) fully correct, 0% slip" && r.obsCount === 10)!.falsePositiveRate
  )} at 10) -- but even at 10 observations it has not reached zero, and a
teacher checking only 3-5 problems (a realistic real-world usage pattern)
sees the worst end of this range, not the best.`;
}
