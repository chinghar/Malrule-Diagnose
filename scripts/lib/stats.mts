// Confidence interval utilities for Experiment F. No external dependency:
// Wilson score interval (closed-form, good coverage even at small n or
// extreme proportions, unlike the normal/Wald approximation, and avoids
// needing the incomplete-beta-function machinery Clopper-Pearson requires)
// for trial-level rates, plus a between-cluster t-interval for whenever
// trials sharing a malrule (or category) are not independent draws.

import { pct } from "./data.mts";

export const Z_95 = 1.959963984540054; // two-tailed 95% normal critical value

export interface Interval {
  point: number;
  lower: number;
  upper: number;
}

/** Wilson score interval for a binomial proportion (successes out of n). */
export function wilsonInterval(successes: number, n: number, z: number = Z_95): Interval {
  if (n === 0) return { point: NaN, lower: NaN, upper: NaN };
  const phat = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  return { point: phat, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

// Standard two-tailed 95% Student's t critical values, df 1-30; the normal
// approximation (z=1.96) is used beyond df=30, where the two are within
// ~0.08 of each other.
const T_TABLE_95: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145, 15: 2.131, 16: 2.12, 17: 2.11, 18: 2.101, 19: 2.093, 20: 2.086,
  21: 2.08, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.06, 26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
};

export function tCritical95(df: number): number {
  if (df < 1) return Z_95;
  return T_TABLE_95[Math.round(df)] ?? Z_95;
}

/**
 * Between-cluster interval: treat each cluster's own rate (e.g. one
 * malrule's misattribution rate across its own trials, or one category's
 * false-positive rate) as a single data point, and compute a t-interval
 * over that small set of cluster means.
 *
 * WHY this exists: trials within a cluster are not independent -- they
 * share whatever structural property of that malrule/category drives the
 * outcome (e.g. decimals.ignore_decimal_point misattributes on ~100% of
 * ITS trials specifically, because of its near-twin, not because
 * misattribution is uniformly likely across all trials everywhere). A
 * trial-level Wilson interval that pools all trials as if independent
 * ignores this and is therefore optimistic (too narrow) whenever
 * between-cluster variance is non-trivial. This interval is the
 * conservative alternative: it has only k degrees of freedom (k =
 * number of clusters), not n (number of trials), which is usually far
 * fewer and produces a correspondingly wider, more honest interval.
 */
export function clusterInterval(clusterRates: number[]): Interval & { k: number; sd: number } {
  const k = clusterRates.length;
  const mean = clusterRates.reduce((s, x) => s + x, 0) / k;
  if (k < 2) return { point: mean, lower: NaN, upper: NaN, k, sd: NaN };
  const variance = clusterRates.reduce((s, x) => s + (x - mean) ** 2, 0) / (k - 1);
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(k);
  const t = tCritical95(k - 1);
  const margin = t * se;
  return { point: mean, lower: Math.max(0, mean - margin), upper: Math.min(1, mean + margin), k, sd };
}

/** "15.4% (95% CI 13.1-18.0%, Wilson, n=800)" */
export function fmtWilson(successes: number, n: number): string {
  if (n === 0) return "n/a (n=0)";
  const { point, lower, upper } = wilsonInterval(successes, n);
  return `${pct(point)} (95% CI ${pct(lower)}-${pct(upper)}, Wilson, n=${n})`;
}

/** Recovers successes from an already-computed rate (rate = successes/n exactly, as every rate in this codebase is). */
export function fmtWilsonFromRate(rate: number, n: number): string {
  return fmtWilson(Math.round(rate * n), n);
}

/** "15.4% (95% CI 8.2-22.6%, between-malrule t-interval, k=26)" */
export function fmtCluster(clusterRates: number[], unitLabel: string): string {
  const { point, lower, upper, k } = clusterInterval(clusterRates);
  if (Number.isNaN(lower)) return `${pct(point)} (cluster interval unavailable with only k=${k} ${unitLabel})`;
  return `${pct(point)} (95% CI ${pct(lower)}-${pct(upper)}, between-${unitLabel} t-interval, k=${k})`;
}
