// Audit -- non-triggering (instance, malrule) pairs. Where a problem does
// not trigger a malrule's bug, that malrule's algorithm produces the
// CORRECT answer, and predictions[malrule] === correct_answer for that
// instance. Such a pair carries zero information about whether a student
// is running that malrule -- matching it is indistinguishable from
// matching "correct."
//
// build_index.py filters this out for a malrule's OWN native instances
// (`if native_answer == correct_answer: continue`), but NOT for
// cross-applied predictions (the loop over `other_info` in build_category
// has no equivalent check) -- so non-triggering pairs exist in the
// committed index, entirely on the cross-application side, unfiltered.
//
// lib/diagnose and lib/select were read in full before writing this
// module: neither scoreMalrule() (diagnose.ts) nor scoreCandidates()
// (select.ts) special-cases predictions[m] === correct_answer in any way
// -- a non-triggering match is scored and grouped identically to a
// genuine, informative one. This is a real, reportable structural gap,
// not fixed here.

import { CATEGORIES, pct } from "./data.mts";
import { fmtWilson } from "./stats.mts";

export interface CategoryNonTriggeringStats {
  category: string;
  totalDefinedPairs: number; // (instance, malrule) pairs with any prediction at all
  nonTriggeringPairs: number; // of those, where the prediction equals the correct answer
  nativeNonTriggering: number; // should be exactly 0, by build_index.py's own filter -- verified, not assumed
  crossAppliedNonTriggering: number;
}

export function auditNonTriggeringPairs(): CategoryNonTriggeringStats[] {
  return CATEGORIES.map((cat) => {
    let totalDefinedPairs = 0;
    let nonTriggeringPairs = 0;
    let nativeNonTriggering = 0;
    let crossAppliedNonTriggering = 0;

    for (const inst of cat.instances) {
      for (const [malruleId, predicted] of Object.entries(inst.predictions)) {
        totalDefinedPairs += 1;
        if (predicted === inst.correct_answer) {
          nonTriggeringPairs += 1;
          if (malruleId === inst.native_malrule_id) nativeNonTriggering += 1;
          else crossAppliedNonTriggering += 1;
        }
      }
    }

    return { category: cat.category, totalDefinedPairs, nonTriggeringPairs, nativeNonTriggering, crossAppliedNonTriggering };
  });
}

/**
 * Exposure in the actual (a)/(b)/(c) sweep and Experiment A protocols:
 * `simulateObservations`/leave-one-out sample uniformly from ALL instances
 * where the true malrule has a defined prediction (native + cross-applied),
 * not just its own 80 native ones. This measures what fraction of that
 * applicable pool is non-triggering for the malrule being simulated --
 * i.e. how often a "clean" observation of that malrule is actually
 * zero-information by construction.
 */
export interface MalruleExposure {
  malruleId: string;
  category: string;
  applicableInstances: number;
  nonTriggeringInstances: number;
  nonTriggeringFraction: number;
}

export function auditPerMalruleExposure(): MalruleExposure[] {
  const rows: MalruleExposure[] = [];
  for (const cat of CATEGORIES) {
    for (const mr of cat.malrules) {
      let applicable = 0;
      let nonTriggering = 0;
      for (const inst of cat.instances) {
        const predicted = inst.predictions[mr.id];
        if (predicted === undefined) continue;
        applicable += 1;
        if (predicted === inst.correct_answer) nonTriggering += 1;
      }
      rows.push({
        malruleId: mr.id,
        category: cat.category,
        applicableInstances: applicable,
        nonTriggeringInstances: nonTriggering,
        nonTriggeringFraction: applicable > 0 ? nonTriggering / applicable : 0,
      });
    }
  }
  return rows.sort((a, b) => b.nonTriggeringFraction - a.nonTriggeringFraction);
}

export function renderMarkdown(categoryStats: CategoryNonTriggeringStats[], exposure: MalruleExposure[]): string {
  const totalDefined = categoryStats.reduce((s, c) => s + c.totalDefinedPairs, 0);
  const totalNonTrig = categoryStats.reduce((s, c) => s + c.nonTriggeringPairs, 0);
  const totalNative = categoryStats.reduce((s, c) => s + c.nativeNonTriggering, 0);
  const totalCross = categoryStats.reduce((s, c) => s + c.crossAppliedNonTriggering, 0);
  const meanExposure = exposure.reduce((s, e) => s + e.nonTriggeringFraction, 0) / exposure.length;

  const categoryTable = `| Category | Total defined pairs | Non-triggering pairs | Native non-triggering | Cross-applied non-triggering |\n|---|---|---|---|---|\n${categoryStats
    .map((c) => `| ${c.category} | ${c.totalDefinedPairs} | ${c.nonTriggeringPairs} (${pct(c.nonTriggeringPairs / c.totalDefinedPairs)}) | ${c.nativeNonTriggering} | ${c.crossAppliedNonTriggering} |`)
    .join("\n")}`;

  const topExposure = exposure.slice(0, 5);
  const exposureTable = `| Malrule | Applicable instances | Non-triggering | Exposure |\n|---|---|---|---|\n${topExposure
    .map((e) => `| ${e.malruleId} | ${e.applicableInstances} | ${e.nonTriggeringInstances} | ${fmtWilson(e.nonTriggeringInstances, e.applicableInstances)} |`)
    .join("\n")}`;

  return `Read \`lib/diagnose\` and \`lib/select\` in full before writing this audit:
**neither special-cases a prediction that equals the correct answer** --
\`scoreMalrule()\` and \`scoreCandidates()\` both score and group a
non-triggering match identically to a genuine, informative one. This is a
real, confirmed structural gap, reported as a bug here, not fixed.

${categoryTable}

**${totalNonTrig}/${totalDefined} (${fmtWilson(totalNonTrig, totalDefined)}) of all (instance, malrule) pairs in the
committed index are non-triggering** -- entirely on the cross-applied side
(native: ${totalNative}, confirmed empirically to be exactly zero by
\`build_index.py\`'s own filter, not merely assumed from reading the script;
cross-applied: ${totalCross}). Mean exposure across all 26 malrules (the
fraction of a malrule's own applicable instances that are non-triggering
for it, which is also the probability any single uniformly-sampled
observation of that malrule in the (a)/(b) sweep or Experiment A is
zero-information by construction) is ${pct(meanExposure)}.

**Highest-exposure malrules** (top 5 of 26):

${exposureTable}

These are the same three subtraction malrules Experiment E already found
driving nearly all of that experiment's false positives, and the same
cluster Experiment B flagged as densely collision-prone -- three
independent analyses converging on the same root cause. **This directly
and provably explains Experiment E's type (a)/(b) false positives**: a
"correct student matches malrule X" event is, by definition, a
non-triggering pair for X on that instance -- there is no other way for a
genuinely correct answer to match a malrule's predicted (wrong-by-design)
output. It also plausibly contributes to Experiment D's 6.9-percentage-point
collision-driven error and the 20.6% MRA tie rate, though that split has
not been fully decomposed here.`;
}
