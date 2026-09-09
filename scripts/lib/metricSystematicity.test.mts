import { describe, expect, it } from "vitest";
import { computeSystematicity, type StudentObservation } from "./metricSystematicity.mts";
import { hashString, mulberry32, shuffle } from "../../lib/diagnose/testSupport.ts";
import { CATEGORIES } from "./data.mts";
import type { MalruleMeta } from "../../lib/diagnose/types.ts";

const malrulesByCategory = new Map<string, MalruleMeta[]>(CATEGORIES.map((c) => [c.category, c.malrules]));
const sub = CATEGORIES.find((c) => c.category === "subtraction")!;

const OBS_PER_STUDENT = 5;
const N_STUDENTS = 40;

describe("computeSystematicity", () => {
  it("positive control: students each consistently running ONE malrule are far more concentrated than the permutation null", () => {
    const rng = mulberry32(hashString("systematicity-positive"));
    const observations: StudentObservation[] = [];

    for (let s = 0; s < N_STUDENTS; s++) {
      const mr = sub.malrules[s % sub.malrules.length]!;
      const applicable = sub.instances.filter((i) => i.predictions[mr.id] !== undefined);
      const chosen = shuffle(applicable, rng).slice(0, OBS_PER_STUDENT);
      for (const inst of chosen) {
        observations.push({ studentId: `student-${s}`, category: sub.category, instanceId: inst.instance_id, studentAnswer: inst.predictions[mr.id]! });
      }
    }

    const result = computeSystematicity(observations, sub.instances, malrulesByCategory, mulberry32(hashString("systematicity-positive-perm")), 300);
    expect(result.nStudents).toBeGreaterThan(20);
    expect(result.observedMeanModalShare).toBeGreaterThan(0.7); // consistently the same malrule most of the time
    expect(result.observedMeanEntropyBits).toBeLessThan(0.7); // low entropy (subtraction's known within-category confusability keeps this above zero)
    expect(result.pValueModalShare).toBeLessThan(0.05); // far more concentrated than random label reassignment
    expect(result.pValueEntropyBits).toBeLessThan(0.05); // far lower entropy than random label reassignment
  });

  it("negative control: students with a different malrule on every problem look like the permutation null", () => {
    const rng = mulberry32(hashString("systematicity-negative"));
    const observations: StudentObservation[] = [];

    for (let s = 0; s < N_STUDENTS; s++) {
      for (let k = 0; k < OBS_PER_STUDENT; k++) {
        // A different, independently-chosen malrule for every single observation -- no genuine within-student procedure at all.
        const mr = sub.malrules[Math.floor(rng() * sub.malrules.length)]!;
        const applicable = sub.instances.filter((i) => i.predictions[mr.id] !== undefined);
        const inst = applicable[Math.floor(rng() * applicable.length)]!;
        observations.push({ studentId: `student-${s}`, category: sub.category, instanceId: inst.instance_id, studentAnswer: inst.predictions[mr.id]! });
      }
    }

    const result = computeSystematicity(observations, sub.instances, malrulesByCategory, mulberry32(hashString("systematicity-negative-perm")), 300);
    expect(result.nStudents).toBeGreaterThan(20);
    // Not concentrated: p-values should NOT be small (this population is
    // exactly what the permutation null models -- no real association
    // between student identity and which label they get).
    expect(result.pValueModalShare).toBeGreaterThan(0.05);
    expect(result.pValueEntropyBits).toBeGreaterThan(0.05);
  });

  it("excludes students below minObservations and categories with no known malrule set", () => {
    const observations: StudentObservation[] = [
      { studentId: "only-one", category: sub.category, instanceId: sub.instances[0]!.instance_id, studentAnswer: "42" },
      { studentId: "unknown-cat", category: "not_a_real_category", instanceId: sub.instances[1]!.instance_id, studentAnswer: "1" },
      { studentId: "unknown-cat", category: "not_a_real_category", instanceId: sub.instances[2]!.instance_id, studentAnswer: "2" },
    ];
    const result = computeSystematicity(observations, sub.instances, malrulesByCategory, mulberry32(1), 50);
    expect(result.nStudents).toBe(0);
  });

  it("is deterministic: identical inputs and seed reproduce identical output", () => {
    const rng = mulberry32(hashString("systematicity-determinism"));
    const observations: StudentObservation[] = [];
    for (let s = 0; s < 10; s++) {
      const mr = sub.malrules[s % sub.malrules.length]!;
      const applicable = sub.instances.filter((i) => i.predictions[mr.id] !== undefined);
      const chosen = shuffle(applicable, rng).slice(0, 3);
      for (const inst of chosen) {
        observations.push({ studentId: `s-${s}`, category: sub.category, instanceId: inst.instance_id, studentAnswer: inst.predictions[mr.id]! });
      }
    }

    const r1 = computeSystematicity(observations, sub.instances, malrulesByCategory, mulberry32(7), 100);
    const r2 = computeSystematicity(observations, sub.instances, malrulesByCategory, mulberry32(7), 100);
    expect(r1).toEqual(r2);
  });
});
