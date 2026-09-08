import { describe, expect, it } from "vitest";
import { diagnose } from "./diagnose";
import { hashString, mulberry32, simulateObservations } from "./testSupport";
import { allCategories } from "@/lib/data/loadIndex";

const MODEL_SLIP_RATE = 0.1;
const OBS_COUNT = 5;

interface Trial {
  category: string;
  malruleId: string;
  top1: boolean;
  top3: boolean;
}

function runTrials(injectedSlipRate: number): Trial[] {
  const trials: Trial[] = [];
  for (const cat of allCategories()) {
    for (const mr of cat.malrules) {
      const rng = mulberry32(hashString(`${mr.id}:${injectedSlipRate}`));
      const obs = simulateObservations(mr.id, cat.instances, OBS_COUNT, injectedSlipRate, rng);
      if (obs.length < OBS_COUNT) continue; // not enough applicable instances to run a fair trial
      const result = diagnose(obs, cat.instances, cat.malrules, MODEL_SLIP_RATE);
      const top1 = result.ranked[0]?.malruleId === mr.id;
      const top3 = result.ranked.slice(0, 3).some((r) => r.malruleId === mr.id);
      trials.push({ category: cat.category, malruleId: mr.id, top1, top3 });
    }
  }
  return trials;
}

function summarize(trials: Trial[]) {
  const n = trials.length;
  const top1 = trials.filter((t) => t.top1).length / n;
  const top3 = trials.filter((t) => t.top3).length / n;
  return { n, top1, top3 };
}

describe("diagnose recovers a planted malrule from synthetic answers", () => {
  it("clean data (0% injected slip): top-1 and top-3 identification accuracy", () => {
    const trials = runTrials(0);
    const { n, top1, top3 } = summarize(trials);
    // eslint-disable-next-line no-console
    console.log(
      `[recovery/clean] n=${n} top-1=${(top1 * 100).toFixed(1)}% top-3=${(top3 * 100).toFixed(1)}%`
    );
    expect(n).toBeGreaterThan(0);
    expect(top1).toBeGreaterThanOrEqual(0.8);
    expect(top3).toBeGreaterThanOrEqual(0.95);
  });

  it("10% injected slip: identification accuracy degrades gracefully but stays high", () => {
    const trials = runTrials(0.1);
    const { n, top1, top3 } = summarize(trials);
    // eslint-disable-next-line no-console
    console.log(
      `[recovery/slip10] n=${n} top-1=${(top1 * 100).toFixed(1)}% top-3=${(top3 * 100).toFixed(1)}%`
    );
    expect(n).toBeGreaterThan(0);
    expect(top1).toBeGreaterThanOrEqual(0.6);
    expect(top3).toBeGreaterThanOrEqual(0.85);
  });
});
