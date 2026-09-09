import { describe, expect, it } from "vitest";
import { runPredictiveCheck, type StudentErrorSequence } from "./metricPredictiveCheck.mts";
import { hashString, mulberry32, shuffle } from "../../lib/diagnose/testSupport.ts";
import { pureRandomAnswer } from "./experimentE.mts";
import { CATEGORIES } from "./data.mts";
import type { MalruleMeta } from "../../lib/diagnose/types.ts";

const malrulesByCategory = new Map<string, MalruleMeta[]>(CATEGORIES.map((c) => [c.category, c.malrules]));
const sub = CATEGORIES.find((c) => c.category === "subtraction")!;

describe("runPredictiveCheck", () => {
  it("positive control: a student consistently running one malrule predicts their next exact wrong answer far above chance", () => {
    const rng = mulberry32(hashString("predictive-positive"));
    const sequences: StudentErrorSequence[] = [];

    for (let s = 0; s < 60; s++) {
      const mr = sub.malrules[s % sub.malrules.length]!;
      const applicable = sub.instances.filter((i) => i.predictions[mr.id] !== undefined);
      const chosen = shuffle(applicable, rng).slice(0, 6);
      sequences.push({
        studentId: `student-${s}`,
        category: sub.category,
        errors: chosen.map((inst) => ({ instanceId: inst.instance_id, studentAnswer: inst.predictions[mr.id]! })),
      });
    }

    const result = runPredictiveCheck(sequences, sub.instances, malrulesByCategory, [1, 2, 3]);
    for (const point of result.byK) {
      expect(point.n).toBeGreaterThan(20);
      expect(point.hitRate).toBeGreaterThan(point.meanChanceBaseline * 3); // far above chance
      expect(point.hitRate).toBeGreaterThan(0.5);
    }
  });

  it("negative control: an unrelated next answer is predicted at roughly the chance baseline", () => {
    const rng = mulberry32(hashString("predictive-negative"));
    const sequences: StudentErrorSequence[] = [];

    for (let s = 0; s < 60; s++) {
      const mr = sub.malrules[s % sub.malrules.length]!;
      const applicable = sub.instances.filter((i) => i.predictions[mr.id] !== undefined);
      const chosen = shuffle(applicable, rng).slice(0, 4);
      const fitOn = chosen.slice(0, 3).map((inst) => ({ instanceId: inst.instance_id, studentAnswer: inst.predictions[mr.id]! }));
      // The k+1th "error" is unrelated noise, not this malrule's prediction.
      const targetInstance = chosen[3]!;
      const unrelated = { instanceId: targetInstance.instance_id, studentAnswer: pureRandomAnswer(targetInstance.correct_answer, rng) };
      sequences.push({ studentId: `student-${s}`, category: sub.category, errors: [...fitOn, unrelated] });
    }

    const result = runPredictiveCheck(sequences, sub.instances, malrulesByCategory, [3]);
    const point = result.byK[0]!;
    expect(point.n).toBeGreaterThan(20);
    // Hit rate should be close to chance -- not systematically elevated.
    expect(point.hitRate).toBeLessThan(point.meanChanceBaseline + 0.15);
  });

  it("excludes sequences shorter than k+1 and unknown categories", () => {
    const sequences: StudentErrorSequence[] = [
      { studentId: "too-short", category: sub.category, errors: [{ instanceId: sub.instances[0]!.instance_id, studentAnswer: "1" }] },
      { studentId: "unknown-cat", category: "not_a_real_category", errors: [
        { instanceId: sub.instances[0]!.instance_id, studentAnswer: "1" },
        { instanceId: sub.instances[1]!.instance_id, studentAnswer: "2" },
      ] },
    ];
    const result = runPredictiveCheck(sequences, sub.instances, malrulesByCategory, [1]);
    expect(result.byK[0]!.n).toBe(0);
  });

  it("is deterministic across identical calls (no RNG inside the metric itself)", () => {
    const rng = mulberry32(hashString("predictive-determinism"));
    const sequences: StudentErrorSequence[] = [];
    for (let s = 0; s < 10; s++) {
      const mr = sub.malrules[s % sub.malrules.length]!;
      const applicable = sub.instances.filter((i) => i.predictions[mr.id] !== undefined);
      const chosen = shuffle(applicable, rng).slice(0, 3);
      sequences.push({ studentId: `s-${s}`, category: sub.category, errors: chosen.map((inst) => ({ instanceId: inst.instance_id, studentAnswer: inst.predictions[mr.id]! })) });
    }
    const r1 = runPredictiveCheck(sequences, sub.instances, malrulesByCategory, [1, 2]);
    const r2 = runPredictiveCheck(sequences, sub.instances, malrulesByCategory, [1, 2]);
    expect(r1).toEqual(r2);
  });
});
