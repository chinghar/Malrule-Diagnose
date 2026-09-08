// Deterministic synthetic-student helpers shared by the diagnosis test
// suites. Not part of the public engine API -- test-only.

import type { ProblemInstance } from "./types";

export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function shuffle<T>(items: T[], rng: () => number): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = arr[i]!;
    const b = arr[j]!;
    arr[i] = b;
    arr[j] = a;
  }
  return arr;
}

/** Any on-record answer for this instance other than malruleId's own predicted answer. */
export function slipAnswer(instance: ProblemInstance, malruleId: string, rng: () => number): string {
  const own = instance.predictions[malruleId];
  const candidates = new Set<string>([instance.correct_answer, ...Object.values(instance.predictions)]);
  if (own !== undefined) candidates.delete(own);
  if (candidates.size === 0) return `${own ?? instance.correct_answer}~slip`;
  const pool = [...candidates];
  return pool[Math.floor(rng() * pool.length)]!;
}

/**
 * Simulate a child who executes `malruleId` on a random sample of instances
 * it applies to, slipping to some other on-record answer with probability
 * `injectedSlipRate`.
 */
export function simulateObservations(
  malruleId: string,
  instances: ProblemInstance[],
  count: number,
  injectedSlipRate: number,
  rng: () => number
): { instanceId: string; studentAnswer: string }[] {
  const applicable = instances.filter((inst) => inst.predictions[malruleId] !== undefined);
  const chosen = shuffle(applicable, rng).slice(0, count);
  return chosen.map((inst) => {
    const followsRule = rng() >= injectedSlipRate;
    const answer = followsRule ? inst.predictions[malruleId]! : slipAnswer(inst, malruleId, rng);
    return { instanceId: inst.instance_id, studentAnswer: answer };
  });
}
