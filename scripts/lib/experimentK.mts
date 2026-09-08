// Experiment K -- mixed and transitioning students. Real children
// half-transition between strategies rather than cleanly switching. This
// generates observations from a probabilistic mixture of two DIFFERENT
// library malrules (both still valid candidates -- unlike Experiment H,
// nothing is held out here, since the question is what the engine reports
// when the true generative process genuinely is two known procedures, not
// how it handles a truly novel one) and classifies the outcome.

import { diagnose, DEFAULT_ABSTENTION_THRESHOLD } from "../../lib/diagnose/diagnose.ts";
import { hashString, mulberry32, shuffle } from "../../lib/diagnose/testSupport.ts";
import { CATEGORIES, MODEL_SLIP_RATE, pct } from "./data.mts";
import { fmtWilson } from "./stats.mts";

const REFERENCE_OBS_COUNT = 5;
const TRIALS_PER_PAIR = 20;
export const MIX_RATIOS = [0.5, 0.7, 0.9];

export type Outcome = "abstained" | "tied" | "namedComponentX" | "namedComponentY" | "namedThirdMalrule";

export interface MixResultRow {
  ratio: number; // fraction of observations from the MAJORITY component
  n: number;
  outcomes: Record<Outcome, number>;
}

function classify(
  result: ReturnType<typeof diagnose>,
  xId: string,
  yId: string
): Outcome {
  if (result.noPatternDetected) return "abstained";
  if (result.tiedTop.length > 1) return "tied";
  const top = result.ranked[0]!.malruleId;
  if (top === xId) return "namedComponentX";
  if (top === yId) return "namedComponentY";
  return "namedThirdMalrule";
}

export function runExperimentK(): MixResultRow[] {
  const rows: MixResultRow[] = MIX_RATIOS.map((ratio) => ({
    ratio,
    n: 0,
    outcomes: { abstained: 0, tied: 0, namedComponentX: 0, namedComponentY: 0, namedThirdMalrule: 0 },
  }));

  for (const cat of CATEGORIES) {
    for (let i = 0; i < cat.malrules.length; i++) {
      for (let j = i + 1; j < cat.malrules.length; j++) {
        const x = cat.malrules[i]!;
        const y = cat.malrules[j]!;
        const coApplicable = cat.instances.filter(
          (inst) => inst.predictions[x.id] !== undefined && inst.predictions[y.id] !== undefined
        );
        if (coApplicable.length < REFERENCE_OBS_COUNT) continue;

        for (const ratio of MIX_RATIOS) {
          const row = rows.find((r) => r.ratio === ratio)!;
          for (let trial = 0; trial < TRIALS_PER_PAIR; trial++) {
            const rng = mulberry32(hashString(`expK:${x.id}:${y.id}:${ratio}:${trial}`));
            const chosen = shuffle(coApplicable, rng).slice(0, REFERENCE_OBS_COUNT);
            if (chosen.length < REFERENCE_OBS_COUNT) continue;
            const obs = chosen.map((inst) => {
              const useX = rng() < ratio;
              return { instanceId: inst.instance_id, studentAnswer: useX ? inst.predictions[x.id]! : inst.predictions[y.id]! };
            });
            const result = diagnose(obs, cat.instances, cat.malrules, MODEL_SLIP_RATE, DEFAULT_ABSTENTION_THRESHOLD);
            const outcome = classify(result, x.id, y.id);
            row.n += 1;
            row.outcomes[outcome] += 1;
          }
        }
      }
    }
  }

  return rows;
}

export function renderMarkdown(rows: MixResultRow[]): string {
  const table = `| Mixture ratio | n | Abstained | Tied | Named majority component | Named minority component | Named a THIRD malrule |\n|---|---|---|---|---|---|---|\n${rows
    .map(
      (r) =>
        `| ${Math.round(r.ratio * 100)}/${Math.round((1 - r.ratio) * 100)} | ${r.n} | ${pct(r.outcomes.abstained / r.n)} | ${pct(r.outcomes.tied / r.n)} | ${pct(r.outcomes.namedComponentX / r.n)} | ${pct(r.outcomes.namedComponentY / r.n)} | ${pct(r.outcomes.namedThirdMalrule / r.n)} |`
    )
    .join("\n")}`;

  const fiftyFifty = rows.find((r) => r.ratio === 0.5)!;
  const ninetyTen = rows.find((r) => r.ratio === 0.9)!;

  return `Every pair of distinct malrules within a category (co-applicable
instances only), mixed per-observation at the stated ratio, 5
observations, ${TRIALS_PER_PAIR} trials per (pair, ratio). "Majority component" is
whichever of the two true generating malrules supplied more than half the
observations (X at ratio > 0.5, always the intended interpretation of the
stated ratio here); at exactly 50/50 there is no majority and "X"/"Y" are
arbitrary category-order labels.

${table}

At 50/50, the engine confidently names ONE of the two true components
${pct((fiftyFifty.outcomes.namedComponentX + fiftyFifty.outcomes.namedComponentY) / fiftyFifty.n)}
of the time -- more than twice as often as it abstains or ties
(${pct((fiftyFifty.outcomes.abstained + fiftyFifty.outcomes.tied) / fiftyFifty.n)} combined). That is arguably a defensible
outcome for a genuine 50/50 blend (it correctly identifies one of the two
real contributing misconceptions, rather than flagging ambiguity it can't
resolve further from five observations), but it is a single, confident,
unhedged malrule name shown to the user -- with no indication that the
underlying evidence was actually split between two candidates. As the
mixture skews toward one component (90/10), the engine increasingly names
the majority component confidently (${pct(ninetyTen.outcomes.namedComponentX / ninetyTen.n)} of trials), which is
more clearly correct behavior -- a 90/10 mixture is closer to "mostly
using one procedure" than a genuine 50/50 blend.

**A third malrule (neither true component) is named confidently in
${fmtWilson(fiftyFifty.outcomes.namedThirdMalrule, fiftyFifty.n)} of 50/50 trials and
${fmtWilson(ninetyTen.outcomes.namedThirdMalrule, ninetyTen.n)} of 90/10 trials.**
This is a distinct failure mode from anything in Experiments A or E: not
just "wrong which known malrule," but wrong in a way that points a
worksheet author toward a completely unrelated misconception, when the
truth is closer to two adjacent, already-identified ones.`;
}
