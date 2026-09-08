import { describe, expect, it } from "vitest";
import { scoreCandidates, selectNextInstance, uniformPosterior } from "./select";
import type { MalruleMeta, ProblemInstance } from "../diagnose/types";

const malrules: MalruleMeta[] = [
  { id: "cat.a", category: "cat", name: "A", description: "" },
  { id: "cat.b", category: "cat", name: "B", description: "" },
  { id: "cat.c", category: "cat", name: "C", description: "" },
  { id: "cat.d", category: "cat", name: "D", description: "" },
];

function inst(id: string, predictions: Record<string, string>): ProblemInstance {
  return {
    instance_id: id,
    native_malrule_id: "cat.a",
    template: "t",
    problem_text: id,
    operation: "op",
    correct_answer: "0",
    predictions,
  };
}

describe("select", () => {
  it("scores an instance where every hypothesis agrees as zero (non-discriminating)", () => {
    const posterior = uniformPosterior(malrules);
    const candidate = inst("useless", { "cat.a": "5", "cat.b": "5", "cat.c": "5", "cat.d": "5" });
    const [score] = scoreCandidates(posterior, [candidate]);
    expect(score!.expectedEntropyReduction).toBeCloseTo(0, 10);
  });

  it("prefers an instance that splits hypotheses evenly over one that splits unevenly", () => {
    const posterior = uniformPosterior(malrules);
    const even = inst("even", { "cat.a": "1", "cat.b": "1", "cat.c": "2", "cat.d": "2" }); // 2/2 split
    const uneven = inst("uneven", { "cat.a": "1", "cat.b": "2", "cat.c": "2", "cat.d": "2" }); // 1/3 split
    const scores = scoreCandidates(posterior, [even, uneven]);
    const evenScore = scores.find((s) => s.instanceId === "even")!.expectedEntropyReduction;
    const unevenScore = scores.find((s) => s.instanceId === "uneven")!.expectedEntropyReduction;
    expect(evenScore).toBeGreaterThan(unevenScore);
  });

  it("scores a fully-discriminating instance (every hypothesis distinct) at log2(n)", () => {
    const posterior = uniformPosterior(malrules);
    const candidate = inst("fully_split", { "cat.a": "1", "cat.b": "2", "cat.c": "3", "cat.d": "4" });
    const [score] = scoreCandidates(posterior, [candidate]);
    expect(score!.expectedEntropyReduction).toBeCloseTo(Math.log2(4), 10);
  });

  it("treats inapplicable malrules as their own group rather than ignoring them", () => {
    const posterior = uniformPosterior(malrules);
    // a and b get an answer; c and d can't run on this instance at all.
    const candidate = inst("partial", { "cat.a": "1", "cat.b": "2" });
    const [score] = scoreCandidates(posterior, [candidate]);
    // Three groups: {a} mass 0.25, {b} mass 0.25, {c,d not-applicable} mass 0.5.
    const masses = [0.25, 0.25, 0.5];
    const manual = masses.reduce((h, m) => h - m * Math.log2(m), 0);
    expect(score!.expectedEntropyReduction).toBeCloseTo(manual, 10);
  });

  it("selectNextInstance picks the highest-scoring candidate deterministically", () => {
    const posterior = uniformPosterior(malrules);
    const useless = inst("useless", { "cat.a": "5", "cat.b": "5", "cat.c": "5", "cat.d": "5" });
    const best = inst("best", { "cat.a": "1", "cat.b": "2", "cat.c": "3", "cat.d": "4" });
    const chosen = selectNextInstance(posterior, [useless, best]);
    expect(chosen?.instanceId).toBe("best");
  });

  it("ignores hypotheses with zero posterior mass when scoring", () => {
    const posterior = new Map([
      ["cat.a", 0.5],
      ["cat.b", 0.5],
      ["cat.c", 0],
      ["cat.d", 0],
    ]);
    // c and d disagree wildly here, but they're already ruled out (mass 0) so it shouldn't matter.
    const candidate = inst("x", { "cat.a": "1", "cat.b": "2", "cat.c": "99", "cat.d": "100" });
    const [score] = scoreCandidates(posterior, [candidate]);
    expect(score!.expectedEntropyReduction).toBeCloseTo(1, 10); // even 50/50 split of remaining mass
  });
});
