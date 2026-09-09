import { describe, expect, it } from "vitest";
import { computeCoverageVsNull, type WrongAnswerObservation } from "./metricCoverage.mts";
import { hashString, mulberry32, simulateObservations } from "../../lib/diagnose/testSupport.ts";
import { pureRandomAnswer } from "./experimentE.mts";
import { CATEGORIES } from "./data.mts";
import type { MalruleMeta } from "../../lib/diagnose/types.ts";

const malrulesByCategory = new Map<string, MalruleMeta[]>(CATEGORIES.map((c) => [c.category, c.malrules]));
const sub = CATEGORIES.find((c) => c.category === "subtraction")!;

describe("computeCoverageVsNull", () => {
  it("positive control: genuine malrule-driven wrong answers show a real coverage gap over the null", () => {
    const rng = mulberry32(hashString("coverage-positive-control"));
    const observations: WrongAnswerObservation[] = [];
    let counter = 0;
    for (const mr of sub.malrules) {
      const obs = simulateObservations(mr.id, sub.instances, 15, 0, rng);
      for (const o of obs) {
        observations.push({ id: `pos-${counter++}`, instanceId: o.instanceId, category: sub.category, studentAnswer: o.studentAnswer });
      }
    }

    const result = computeCoverageVsNull(observations, sub.instances, malrulesByCategory, mulberry32(hashString("coverage-positive-null")));
    expect(result.n).toBeGreaterThan(50);
    expect(result.realCoverage).toBeGreaterThan(0.7); // genuine malrule answers should mostly be diagnosable
    expect(result.gap).toBeGreaterThan(0.2); // a real, substantial gap over the null
    expect(result.gapCI.lower).toBeGreaterThan(0); // the gap clears its own 95% CI
  });

  it("negative control: purely random wrong answers show a gap near zero", () => {
    const rng = mulberry32(hashString("coverage-negative-control"));
    const observations: WrongAnswerObservation[] = [];
    let counter = 0;
    for (const inst of sub.instances.slice(0, 200)) {
      const answer = pureRandomAnswer(inst.correct_answer, rng);
      observations.push({ id: `neg-${counter++}`, instanceId: inst.instance_id, category: sub.category, studentAnswer: answer });
    }

    const result = computeCoverageVsNull(observations, sub.instances, malrulesByCategory, mulberry32(hashString("coverage-negative-null")));
    expect(result.n).toBeGreaterThan(50);
    // Random noise should rarely coincide with any malrule's predicted output, in either the real or null condition.
    expect(result.realCoverage).toBeLessThan(0.1);
    expect(Math.abs(result.gap)).toBeLessThan(0.1);
  });

  it("excludes observations from categories with only one problem represented (no valid null substitute)", () => {
    const onlyOneProblem: WrongAnswerObservation[] = [
      { id: "a", instanceId: sub.instances[0]!.instance_id, category: sub.category, studentAnswer: "42" },
    ];
    const result = computeCoverageVsNull(onlyOneProblem, sub.instances, malrulesByCategory, mulberry32(1));
    expect(result.n).toBe(0);
    expect(result.excludedNoNullCandidate).toBe(1);
  });

  it("skips observations whose category has no known malrule set", () => {
    const unknownCategory: WrongAnswerObservation[] = [
      { id: "a", instanceId: sub.instances[0]!.instance_id, category: "not_a_real_category", studentAnswer: "42" },
      { id: "b", instanceId: sub.instances[1]!.instance_id, category: "not_a_real_category", studentAnswer: "43" },
    ];
    const result = computeCoverageVsNull(unknownCategory, sub.instances, malrulesByCategory, mulberry32(1));
    expect(result.n).toBe(0);
  });

  it("is deterministic: identical inputs and seed reproduce identical output", () => {
    const rng1 = mulberry32(hashString("coverage-determinism"));
    const observations: WrongAnswerObservation[] = [];
    let counter = 0;
    for (const mr of sub.malrules.slice(0, 2)) {
      const obs = simulateObservations(mr.id, sub.instances, 10, 0.1, rng1);
      for (const o of obs) observations.push({ id: `d-${counter++}`, instanceId: o.instanceId, category: sub.category, studentAnswer: o.studentAnswer });
    }

    const r1 = computeCoverageVsNull(observations, sub.instances, malrulesByCategory, mulberry32(42));
    const r2 = computeCoverageVsNull(observations, sub.instances, malrulesByCategory, mulberry32(42));
    expect(r1).toEqual(r2);
  });
});
