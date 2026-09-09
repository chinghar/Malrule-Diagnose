// Phase 2, metric 2 -- within-student diagnosis systematicity. Label-free:
// "diagnosis" here means the malrule-diagnose engine's OWN single-observation
// output, never a ground-truth malrule id. A student running one procedure
// should produce the SAME diagnosis across different problems in a skill; a
// slip should not, so it should recur far less than random.
//
// Per student (with >=2 non-abstain diagnoses in a skill): modal-malrule
// share (fraction of their diagnoses that are the single most common one)
// and Shannon entropy (bits) of their diagnosis-label distribution. Tested
// against a permutation null that shuffles which diagnosis label lands on
// which student's slot within a skill, holding each student's OBSERVATION
// COUNT fixed (so the null's group sizes match the real data's, and only
// the assignment of labels to students is randomized).

import { diagnose, DEFAULT_ABSTENTION_THRESHOLD, DEFAULT_SLIP_RATE } from "../../lib/diagnose/diagnose.ts";
import { shuffle } from "../../lib/diagnose/testSupport.ts";
import type { MalruleMeta, ProblemInstance } from "../../lib/diagnose/types.ts";

export interface StudentObservation {
  studentId: string;
  category: string;
  instanceId: string;
  studentAnswer: string;
}

function modalShareAndEntropy(labels: string[]): { modalShare: number; entropyBits: number } {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  const n = labels.length;
  const modalCount = Math.max(...counts.values());
  let entropyBits = 0;
  for (const c of counts.values()) {
    const p = c / n;
    entropyBits -= p * Math.log2(p);
  }
  return { modalShare: modalCount / n, entropyBits };
}

/** Diagnoses every observation individually (one-observation diagnose() calls) and returns the non-abstain top malrule id, or null when abstained/untested. */
function diagnoseEach(
  observations: { instanceId: string; studentAnswer: string }[],
  instances: ProblemInstance[],
  malrules: MalruleMeta[],
  slipRate: number,
  abstentionThreshold: number
): (string | null)[] {
  return observations.map((obs) => {
    const result = diagnose([obs], instances, malrules, slipRate, abstentionThreshold);
    if (result.noPatternDetected || result.ranked.length === 0) return null;
    return result.ranked[0]!.malruleId;
  });
}

export interface SystematicityResult {
  nStudents: number; // students with >= minObservations non-abstain diagnoses in the skill
  observedMeanModalShare: number;
  observedMeanEntropyBits: number;
  permutationTrials: number;
  pValueModalShare: number; // P(permuted mean modal share >= observed)
  pValueEntropyBits: number; // P(permuted mean entropy <= observed) -- lower entropy is more systematic
}

/**
 * `minObservations` (default 2): a student needs at least this many
 * non-abstain diagnoses in a skill to contribute a concentration statistic
 * at all -- concentration is undefined for a single data point.
 */
export function computeSystematicity(
  observations: StudentObservation[],
  instances: ProblemInstance[],
  malrulesByCategory: Map<string, MalruleMeta[]>,
  rng: () => number,
  permutationTrials: number = 500,
  minObservations: number = 2,
  slipRate: number = DEFAULT_SLIP_RATE,
  abstentionThreshold: number = DEFAULT_ABSTENTION_THRESHOLD
): SystematicityResult {
  // Group by (category, studentId), diagnose each observation individually,
  // keep only the non-abstain labels.
  const groups = new Map<string, { category: string; labels: string[] }>();
  for (const obs of observations) {
    const key = obs.category + " " + obs.studentId;
    if (!groups.has(key)) groups.set(key, { category: obs.category, labels: [] });
  }
  const byGroupObs = new Map<string, { instanceId: string; studentAnswer: string }[]>();
  for (const obs of observations) {
    const key = obs.category + " " + obs.studentId;
    const list = byGroupObs.get(key) ?? [];
    list.push({ instanceId: obs.instanceId, studentAnswer: obs.studentAnswer });
    byGroupObs.set(key, list);
  }
  for (const [key, group] of groups) {
    const malrules = malrulesByCategory.get(group.category);
    if (!malrules) continue;
    const labels = diagnoseEach(byGroupObs.get(key)!, instances, malrules, slipRate, abstentionThreshold).filter((l): l is string => l !== null);
    group.labels = labels;
  }

  const qualifying = [...groups.values()].filter((g) => g.labels.length >= minObservations);
  const nStudents = qualifying.length;
  if (nStudents === 0) {
    return { nStudents: 0, observedMeanModalShare: NaN, observedMeanEntropyBits: NaN, permutationTrials, pValueModalShare: NaN, pValueEntropyBits: NaN };
  }

  const observedStats = qualifying.map((g) => modalShareAndEntropy(g.labels));
  const observedMeanModalShare = observedStats.reduce((s, x) => s + x.modalShare, 0) / nStudents;
  const observedMeanEntropyBits = observedStats.reduce((s, x) => s + x.entropyBits, 0) / nStudents;

  // Permutation null: within each skill (category), pool every qualifying
  // student's labels, shuffle the pooled labels, and re-deal them back out
  // preserving each student's original group size. This holds fixed how
  // many labels each student contributed and how often each label occurs
  // overall in that skill -- only WHICH student got which specific labels
  // is randomized.
  const byCategoryQualifying = new Map<string, { labels: string[] }[]>();
  for (const g of qualifying) {
    const list = byCategoryQualifying.get(g.category) ?? [];
    list.push({ labels: g.labels });
    byCategoryQualifying.set(g.category, list);
  }

  let permutedAtLeastAsModal = 0;
  let permutedAtMostAsEntropic = 0;

  for (let trial = 0; trial < permutationTrials; trial++) {
    let sumModalShare = 0;
    let sumEntropy = 0;
    let count = 0;
    for (const groupList of byCategoryQualifying.values()) {
      const pool = groupList.flatMap((g) => g.labels);
      const shuffled = shuffle(pool, rng);
      let cursor = 0;
      for (const g of groupList) {
        const dealt = shuffled.slice(cursor, cursor + g.labels.length);
        cursor += g.labels.length;
        const stat = modalShareAndEntropy(dealt);
        sumModalShare += stat.modalShare;
        sumEntropy += stat.entropyBits;
        count += 1;
      }
    }
    const permutedMeanModalShare = sumModalShare / count;
    const permutedMeanEntropy = sumEntropy / count;
    if (permutedMeanModalShare >= observedMeanModalShare) permutedAtLeastAsModal += 1;
    if (permutedMeanEntropy <= observedMeanEntropyBits) permutedAtMostAsEntropic += 1;
  }

  return {
    nStudents,
    observedMeanModalShare,
    observedMeanEntropyBits,
    permutationTrials,
    pValueModalShare: permutedAtLeastAsModal / permutationTrials,
    pValueEntropyBits: permutedAtMostAsEntropic / permutationTrials,
  };
}
