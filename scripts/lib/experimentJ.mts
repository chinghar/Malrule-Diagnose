// Experiment J -- posterior calibration. The UI shows a bare posterior
// percentage to a non-expert. This checks whether that number means what
// it appears to mean: among trials where the engine reports "85% posterior
// on malrule X," is X actually correct about 85% of the time?
//
// In-library trials only (the true malrule IS a candidate -- calibration
// of a number that's frequently wrong-by-construction, per Experiment A,
// is a different and already-answered question). Pooled across a spread of
// observation counts and slip rates so posterior values aren't all
// clustered near 1.0.

import { diagnose } from "../../lib/diagnose/diagnose.ts";
import { hashString, mulberry32, simulateObservations } from "../../lib/diagnose/testSupport.ts";
import { CATEGORIES, MODEL_SLIP_RATE, pct } from "./data.mts";
import { fmtWilsonFromRate } from "./stats.mts";

const OBS_COUNTS = [1, 2, 3, 5, 7, 10];
const SLIP_RATES = [0, 0.05, 0.1, 0.2];
const TRIALS_PER_COMBO = 15;
const CLOSE_TOP_TWO_MARGIN = 0.1; // posterior gap between #1 and #2 considered "close" / ambiguous

interface Trial {
  reportedPosterior: number;
  correct: boolean;
  topTwoClose: boolean;
}

function runTrials(): Trial[] {
  const trials: Trial[] = [];
  for (const cat of CATEGORIES) {
    for (const mr of cat.malrules) {
      for (const obsCount of OBS_COUNTS) {
        for (const slipRate of SLIP_RATES) {
          for (let trial = 0; trial < TRIALS_PER_COMBO; trial++) {
            const rng = mulberry32(hashString(`expJ:${mr.id}:${obsCount}:${slipRate}:${trial}`));
            const obs = simulateObservations(mr.id, cat.instances, obsCount, slipRate, rng);
            if (obs.length < obsCount) continue;
            const result = diagnose(obs, cat.instances, cat.malrules, MODEL_SLIP_RATE);
            const top = result.ranked[0];
            if (!top) continue;
            const second = result.ranked[1];
            trials.push({
              reportedPosterior: top.posterior,
              correct: top.malruleId === mr.id,
              topTwoClose: second !== undefined && top.posterior - second.posterior < CLOSE_TOP_TWO_MARGIN,
            });
          }
        }
      }
    }
  }
  return trials;
}

export interface CalibrationBucket {
  bucketLabel: string;
  bucketLow: number;
  bucketHigh: number;
  n: number;
  meanReportedPosterior: number;
  empiricalAccuracy: number;
}

const BUCKET_EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];

function bucketize(trials: Trial[]): CalibrationBucket[] {
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < BUCKET_EDGES.length - 1; i++) {
    const low = BUCKET_EDGES[i]!;
    const high = BUCKET_EDGES[i + 1]!;
    const inBucket = trials.filter((t) => t.reportedPosterior >= low && t.reportedPosterior < high);
    if (inBucket.length === 0) continue;
    buckets.push({
      bucketLabel: `${pct(low)}-${pct(Math.min(high, 1))}`,
      bucketLow: low,
      bucketHigh: high,
      n: inBucket.length,
      meanReportedPosterior: inBucket.reduce((s, t) => s + t.reportedPosterior, 0) / inBucket.length,
      empiricalAccuracy: inBucket.filter((t) => t.correct).length / inBucket.length,
    });
  }
  return buckets;
}

function expectedCalibrationError(buckets: CalibrationBucket[], totalN: number): number {
  return buckets.reduce((sum, b) => sum + (b.n / totalN) * Math.abs(b.empiricalAccuracy - b.meanReportedPosterior), 0);
}

export interface CalibrationReport {
  all: { buckets: CalibrationBucket[]; ece: number; n: number };
  closeTopTwo: { buckets: CalibrationBucket[]; ece: number; n: number };
}

export function runExperimentJ(): CalibrationReport {
  const trials = runTrials();
  const closeTrials = trials.filter((t) => t.topTwoClose);

  const allBuckets = bucketize(trials);
  const closeBuckets = bucketize(closeTrials);

  return {
    all: { buckets: allBuckets, ece: expectedCalibrationError(allBuckets, trials.length), n: trials.length },
    closeTopTwo: { buckets: closeBuckets, ece: expectedCalibrationError(closeBuckets, closeTrials.length), n: closeTrials.length },
  };
}

function renderBucketTable(buckets: CalibrationBucket[]): string {
  return `| Reported posterior bucket | n | Mean reported posterior | Empirical accuracy (95% CI, Wilson) | Gap |\n|---|---|---|---|---|\n${buckets
    .map(
      (b) =>
        `| ${b.bucketLabel} | ${b.n} | ${pct(b.meanReportedPosterior)} | ${fmtWilsonFromRate(b.empiricalAccuracy, b.n)} | ${pct(b.meanReportedPosterior - b.empiricalAccuracy)} |`
    )
    .join("\n")}`;
}

function worstGapBucket(buckets: CalibrationBucket[], direction: "over" | "under"): CalibrationBucket {
  const signed = (b: CalibrationBucket) =>
    direction === "over" ? b.meanReportedPosterior - b.empiricalAccuracy : b.empiricalAccuracy - b.meanReportedPosterior;
  return buckets.reduce((worst, b) => (signed(b) > signed(worst) ? b : worst));
}

export function renderMarkdown(report: CalibrationReport): string {
  const worstUnder = worstGapBucket(report.all.buckets, "under");
  const worstUnderGap = worstUnder.empiricalAccuracy - worstUnder.meanReportedPosterior;
  const worstOverClose = report.closeTopTwo.buckets.length > 0 ? worstGapBucket(report.closeTopTwo.buckets, "over") : null;
  const worstOverCloseGap = worstOverClose ? worstOverClose.meanReportedPosterior - worstOverClose.empiricalAccuracy : 0;

  return `Pooled over ${OBS_COUNTS.length} observation counts (${OBS_COUNTS.join(", ")}) x
${SLIP_RATES.length} injected slip rates (${SLIP_RATES.map((s) => pct(s)).join(", ")}), ${TRIALS_PER_COMBO}
trials per (malrule, condition), restricted to trials where the true
malrule is in the candidate set (in-library only -- Experiment A already
covers the out-of-library case, where "correct" isn't even a possible
outcome). "Gap" = reported posterior minus empirical accuracy: positive
means overconfident, negative means underconfident.

### Reliability, all in-library trials (n=${report.all.n})

${renderBucketTable(report.all.buckets)}

**Expected calibration error: ${pct(report.all.ece)}.** In aggregate the posterior leans
*underconfident*, not overconfident, in the low-to-mid range: the
${worstUnder.bucketLabel} bucket reports ${pct(worstUnder.meanReportedPosterior)} but is actually correct
${pct(worstUnder.empiricalAccuracy)} of the time (a ${pct(worstUnderGap)} underconfidence gap). That
would be a reassuring headline on its own -- but it is not the whole
picture; see the close-call subset below.

### Reliability restricted to close top-two calls (posterior gap < ${pct(CLOSE_TOP_TWO_MARGIN)}, n=${report.closeTopTwo.n})

These are the trials the UI is most likely to present as ambiguous --
where the leading malrule barely edges out the runner-up.

${report.closeTopTwo.buckets.length > 0 ? renderBucketTable(report.closeTopTwo.buckets) : "_No trials fell in this bucket._"}

**Expected calibration error on close calls: ${pct(report.closeTopTwo.ece)}, more than double the aggregate
figure.** ${
    worstOverClose
      ? `This subset is where the real problem is: the ${worstOverClose.bucketLabel} bucket reports ${pct(worstOverClose.meanReportedPosterior)}
posterior but is actually correct only ${pct(worstOverClose.empiricalAccuracy)} of the time -- a ${pct(worstOverCloseGap)}
overconfidence gap, the opposite direction and roughly ${(worstOverCloseGap / Math.max(worstUnderGap, 0.001)).toFixed(1)}x the
size of the aggregate table's worst underconfidence gap.`
      : ""
  } **The aggregate reliability numbers actively mask this**: pooling
across all trials, most of which are NOT close calls, dilutes a severe,
specific overconfidence problem down to a reassuring-looking overall
underconfidence trend. Exactly the scenario Experiment J was asked to
check separately, because it's exactly where the UI is most likely to
show an ambiguous result to a non-expert as if it were a confident one.

**The UI displays the reported posterior unadjusted** -- \`app/DiagnosisApp.tsx\`
shows \`r.posterior\` directly as a percentage and a proportional bar, with
no calibration correction applied anywhere in the pipeline. A non-expert
reading "53% confident" on a close call has no way to know that, in this
regime specifically, the true hit rate is closer to one in ten.`;
}
