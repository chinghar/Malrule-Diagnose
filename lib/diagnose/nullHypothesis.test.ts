// Phase 5 -- regression tests for the manually-discovered false-diagnosis
// case (round 2's original UI verification finding: three correct answers
// produced an 85.3%-confident wrong malrule diagnosis) plus two more
// hand-picked adversarial cases, all built from real instances in the
// committed index -- not from any generator in scripts/lib/, which samples
// uniformly at random and would essentially never happen to pick this exact
// combination of simultaneously-landmine instances for a single malrule.
//
// Each case below was found by searching the committed index directly for
// instances that are a "unique landmine" for one target malrule (i.e. that
// malrule's predicted answer equals the correct answer there, and no other
// malrule in the category shares that coincidence on the same instance) --
// the precise mechanism Phase 1's contamination audit identified as the
// root cause of Experiment E's false positives.

import { describe, expect, it } from "vitest";
import { diagnose, DEFAULT_ABSTENTION_THRESHOLD, NULL_HYPOTHESIS_ID } from "./diagnose";
import { allCategories } from "@/lib/data/loadIndex";
import type { Observation } from "./types";

const MODEL_SLIP_RATE = 0.15; // matches the engine's shipped/evaluation noise assumption
const sub = allCategories().find((c) => c.category === "subtraction")!;
const decimals = allCategories().find((c) => c.category === "decimals")!;

function correctAnswerObservations(instanceIds: string[], cat: typeof sub): Observation[] {
  return instanceIds.map((id) => {
    const inst = cat.instances.find((i) => i.instance_id === id)!;
    return { instanceId: id, studentAnswer: inst.correct_answer };
  });
}

describe("regression: the manually-discovered false-diagnosis case (round 2 UI finding)", () => {
  // subtraction.borrow_no_decrement#0011/#0051/#0064: three real subtraction
  // problems, each one a "unique landmine" for subtraction.always_borrow_left
  // (its predicted wrong answer happens to equal the correct answer there,
  // and no other malrule shares that coincidence on these particular
  // instances). A student who answers all three CORRECTLY reproduces the
  // exact shape of the original manual finding.
  const instanceIds = [
    "subtraction.borrow_no_decrement#0011",
    "subtraction.borrow_no_decrement#0051",
    "subtraction.borrow_no_decrement#0064",
  ];
  const obs = correctAnswerObservations(instanceIds, sub);

  it("without the fix (includeNullHypothesis=false, the diagnose() default): still confidently misdiagnoses a fully correct student", () => {
    const result = diagnose(obs, sub.instances, sub.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD, "logLikelihood", false);
    expect(result.noPatternDetected).toBe(false);
    expect(result.ranked[0]?.malruleId).toBe("subtraction.always_borrow_left");
    expect(result.ranked[0]?.posterior).toBeGreaterThan(0.9);
  });

  it("with the fix ON (includeNullHypothesis=true, the shipped UI's actual default): correctly recognizes the correct student instead", () => {
    const result = diagnose(obs, sub.instances, sub.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD, "logLikelihood", true);
    expect(result.ranked[0]?.malruleId).toBe(NULL_HYPOTHESIS_ID);
    // Confidently recognized as correct-with-slips, not merely an abstention:
    // "no pattern detected" and "the null hypothesis leads" are distinct
    // events (see NULL_HYPOTHESIS_ID's doc comment) -- this case is the latter.
    expect(result.noPatternDetected).toBe(false);
  });
});

describe("regression: hand-constructed adversarial case 2 (different malrule, different observation count)", () => {
  // A four-observation reproduction against subtraction.stops_borrow_at_zero
  // -- Phase 1's single highest-exposure malrule (53.8% non-triggering).
  // Confirms the fix isn't specific to always_borrow_left or to exactly 3
  // observations.
  const instanceIds = [
    "subtraction.borrow_no_decrement#0002",
    "subtraction.borrow_no_decrement#0004",
    "subtraction.borrow_no_decrement#0016",
    "subtraction.borrow_no_decrement#0021",
  ];
  const obs = correctAnswerObservations(instanceIds, sub);

  it("without the fix: confidently misdiagnoses this fully correct student with stops_borrow_at_zero", () => {
    const result = diagnose(obs, sub.instances, sub.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD, "logLikelihood", false);
    expect(result.noPatternDetected).toBe(false);
    expect(result.ranked[0]?.malruleId).toBe("subtraction.stops_borrow_at_zero");
    expect(result.ranked[0]?.posterior).toBeGreaterThan(0.95);
  });

  it("with the fix ON: correctly recognizes the correct student here too", () => {
    const result = diagnose(obs, sub.instances, sub.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD, "logLikelihood", true);
    expect(result.ranked[0]?.malruleId).toBe(NULL_HYPOTHESIS_ID);
    expect(result.noPatternDetected).toBe(false);
  });
});

describe("regression: hand-constructed adversarial case 3 (decimals -- the fix does NOT fully close this)", () => {
  // Phase 1's audit also found real, if smaller, non-triggering exposure in
  // decimals (decimals.shorter_is_larger 22.5%, decimals.longer_is_larger
  // 20.0%). This case is a real correct-student false positive against
  // decimals.shorter_is_larger and, unlike the two subtraction cases above,
  // is only PARTIALLY fixed by includeNullHypothesis: posterior drops from
  // ~99% to ~50%, but the malrule still wins outright, because of the
  // documented, undecided-by-design tie-break asymmetry ("null_hypothesis"
  // sorts alphabetically after "decimals", so a tie in this category
  // resolves in the malrule's favor, not the null hypothesis's -- see
  // scripts/lib/nullHypothesis.mts's write-up). This is disclosed, not
  // fixed, this round; the test locks in the actual current behavior so a
  // future change to the tie-break rule is caught and must be a deliberate
  // decision, not a silent regression.
  const instanceIds = [
    "decimals.longer_is_larger#0001",
    "decimals.longer_is_larger#0002",
    "decimals.longer_is_larger#0003",
  ];
  const obs = correctAnswerObservations(instanceIds, decimals);

  it("without the fix: confidently misdiagnoses a fully correct decimals student", () => {
    const result = diagnose(obs, decimals.instances, decimals.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD, "logLikelihood", false);
    expect(result.noPatternDetected).toBe(false);
    expect(result.ranked[0]?.malruleId).toBe("decimals.shorter_is_larger");
    expect(result.ranked[0]?.posterior).toBeGreaterThan(0.95);
  });

  it("with the fix ON: still confidently misdiagnosed (posterior roughly halved, not eliminated) -- a real, disclosed limitation", () => {
    const result = diagnose(obs, decimals.instances, decimals.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD, "logLikelihood", true);
    expect(result.noPatternDetected).toBe(false);
    expect(result.ranked[0]?.malruleId).toBe("decimals.shorter_is_larger"); // NOT the null hypothesis -- the fix does not reach this category's tie
    expect(result.tiedTop.sort()).toEqual([NULL_HYPOTHESIS_ID, "decimals.shorter_is_larger"].sort());
    expect(result.ranked[0]!.posterior).toBeLessThan(0.6); // confidence is meaningfully reduced even though the malrule still wins
  });
});
