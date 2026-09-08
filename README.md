# malrule-diagnose

A deterministic engine that infers which documented **malrule** (a
systematic wrong arithmetic procedure) a child is executing from their
answers to arithmetic problems, plus a Next.js interface that runs the
diagnosis live and suggests the next problem that best discriminates
between the remaining candidates.

No LLM calls anywhere in the product or the pipeline. The diagnosis is
computed by directly executing candidate malrules against observed
problems and comparing outputs — not by asking a model to guess.

## Why deterministic

[MalruleLib](https://github.com/sonkar-lab/malrulelib) (also mirrored at
[luffycodes/malrulelib](https://github.com/luffycodes/malrulelib), same
author) accompanies the paper *MalruleLib: Large-Scale Executable
Misconception Reasoning with Step Traces for Modeling Student Thinking in
Mathematics* ([arXiv:2601.03217](https://arxiv.org/abs/2601.03217)), which
reports that language models reach only **40.5%** accuracy inferring a
misconception from one example and predicting the student's next answer
across templates (**46.5%** with step traces).

Because malrules in MalruleLib are executable code, not descriptions, the
inverse problem — "which malrule produced these answers?" — doesn't need to
be solved by inference. It can be solved by direct execution and matching:
run every candidate malrule against the observed problems, score each by
how well it explains the answers under an explicit noise model, and rank
them. This project exists to test that idea directly, with no model in the
loop anywhere — see **Key takeaway** below for what actually held up and
what didn't. See [EVALUATION.md](EVALUATION.md) for the full numbers,
measured honestly — the report states plainly where a comparison to the
paper is and isn't apples-to-apples.

## Key takeaway

Three evaluation rounds: closed-world accuracy, then confident
misdiagnosis of correct students, then this round's exact mechanism,
fix, and cost.

**Correct students were confidently misdiagnosed — ~50% of the time in
subtraction — entirely from coincidence: certain malrules' predicted
wrong answer happens to equal the correct answer on some problems, and
`diagnose()` cannot tell that apart from a real match. Excluding exactly
those coincidences drops the false-positive rate from 15.4%/50.5%
(pooled/subtraction) to 0.0% in both — a complete, confirmed explanation,
not a partial one.**

**The fix comes with a real, measured cost.** The shipped UI now includes
a "no misconception, just slips" candidate that fixes this live
(15.4%→0.6% pooled, 50.5%→0.0% subtraction) — **not for free**: it costs
a small, measured amount of sensitivity on genuine malrule students
(91.4%→91.2% overall, 93.0%→91.5% on the three malrules most prone to
this coincidence), and it opens a new failure mode: a genuinely novel
misconception can now be told "no misconception" instead of flagged
unrecognized (~5% of held-out trials at 5 observations, 0% before). In
plain terms: a child with a real but unusual misconception can now be
told they're fine when they aren't — a false negative on exactly the
population this tool exists to serve, though a rarer one (~5%) than the
false positive it replaced (up to ~50%), and a trade made deliberately,
not one that went unnoticed. One disclosed caveat: the tie-break for
close calls favors the fix in subtraction but not the other three
categories, an artifact of alphabetical order, not a chosen advantage.

**This coincidence does not meaningfully inflate anything else measured
here.** MRA (92.8%) is mechanically guaranteed unaffected; top-1/top-3
accuracy, calibration, and adaptive-selection convergence all move less
than sampling noise once it's excluded. It does modestly inflate
leave-one-out misattribution (28.1%→26.0%, ~7% relative) — real, far
smaller than its effect on false positives.

**Adaptive selection compounds wrongness, not fixes it** (far more
confident when wrong: 96–99% posterior vs. random's 79–85%, no UI signal
to tell them apart). Round four found part of why: `lib/select` groups a
malrule's predicted answer by raw value only, never checking it against
the correct answer, so a coincidentally-correct ("non-triggering")
prediction counts exactly like a genuine one — measured at 22.2% of
adaptive selections in that same experiment, and trials with at least one
such coincidence went on to misattribute 100% of the time (60/60) vs.
26.1% without (120/460). That's a strong association, not an isolated
proven cause — collision-prone malrules may drive both independently —
and `lib/select` is left unmodified, measured not fixed, pending further
work.

**Shown confidence is least reliable on close calls** ("~53% confident"
close top-two calls are correct ~11% of the time; the UI shows the raw,
uncalibrated posterior).

**The 28% misattribution rate on novel procedures has no established
bias direction** — blended misconceptions misattribute more (up to 38%),
a known bug plus one slip far less (under 2%); 28% is specific to
held-out library malrules, not novel bugs generally.

**None of this is a scoring-function artifact** — three alternative
scorers never beat the current one, so the finding **survives an attempt
to attribute it to the scorer**; that alone doesn't establish
generalization beyond four scorers, one library, 26 malrules.

**The first round's structural finding still stands:** one malrule pair
is fully indistinguishable (`decimals.ignore_decimal_point` /
`decimals.whole_number_thinking`); 18 more collide on some templates but
are fixable by problem choice — [EVALUATION.md](EVALUATION.md).

**On the paper comparison:** 92.8% cross-template MRA vs. the paper's
40.5%/46.5% LLM baseline is **not apples to apples** — the paper infers
an unseen procedure open-world; this engine picks from a pre-enumerated
set containing the true answer by construction almost everywhere (§11).

What generalizes: given known executable procedures, "which one produced
this" is matching, not reasoning. Outside that, matching needs an
explicit "none of the above" rule — this round found it unreliable for
the most common real input (a correct student), traced why, fixed it,
and measured the cost.

This project is best read as an engineering artifact plus an honest audit
of its own limits, not a benchmark result: a deterministic inverse solver
over an open, executable misconception library, with adaptive next-problem
selection and a working interface, which does not appear to exist
elsewhere — evaluated, across three rounds, specifically for the ways it
could mislead the people using it, with the most serious way found so far
now measurably fixed, at a measured cost.

## Prior art

This is not a new idea, just an old one done with a modern executable
misconception library:

- **Brown, J.S. & Burton, R.R. (1978).** "Diagnostic Models for Procedural
  Bugs in Basic Mathematical Skills." *Cognitive Science*, 2(2), 155–192.
  Introduced BUGGY, a library of subtraction "bugs" (systematic
  misconceptions) used to diagnose a student's specific error pattern from
  their answers.
- **Burton, R.R. (1982).** "Diagnosing bugs in a simple procedural skill."
  In D. Sleeman & J.S. Brown (Eds.), *Intelligent Tutoring Systems*
  (pp. 157–183). Academic Press. Extended this into DEBUGGY, which also
  generated diagnostic tests chosen to discriminate between candidate bugs
  — the same idea implemented here as adaptive problem selection.
- **Eedi** does something similar commercially today via hand-authored
  multiple-choice distractors mapped to misconceptions.

None of these ships a deterministic inverse solver with an open,
executable misconception library and an interactive interface — that's
the gap this project fills, using MalruleLib in place of a hand-authored
bug library.

## What this is (and isn't)

- **v1 scope:** Elementary Number & Operations only — subtraction,
  fractions, decimals, and multiplication/division. Not algebra, radicals,
  functions, or geometry. 26 malrules, 2,080 problem instances across
  these four categories (see `data/index/manifest.json`).
- **Evaluated entirely on MalruleLib-generated synthetic data.** Every
  number in [EVALUATION.md](EVALUATION.md) is an **upper bound**. Real
  children's work is noisier than any slip-rate model here can fully
  capture — inconsistent procedures, problem-specific slips, partially
  transitioning between strategies, careless errors uncorrelated with any
  malrule at all. **This project has not been validated in a classroom
  and makes no claim of classroom validity.**
- The diagnosis never collapses to a single verdict. It always shows a
  ranked posterior, says so when malrules are indistinguishable given the
  observations so far, and reports "no systematic pattern detected" rather
  than forcing a match when nothing explains the answers better than
  chance.
- **Abstention alone was not reliable enough to call this tool safe for
  correct students, particularly in subtraction** (~50% false-positive
  rate there — see Key takeaway). The shipped UI now also scores a "no
  misconception, just slips" candidate (`includeNullHypothesis`,
  [EVALUATION.md §2](EVALUATION.md)) alongside every malrule, which fixes
  most of this — but not all of it, and not for free: it costs measured
  sensitivity on genuine malrule students and opens a new way for a
  genuinely novel misconception to be told "no misconception." Read the
  Key takeaway and EVALUATION.md before trusting a diagnosis from either
  mechanism alone.
- **The library itself still defaults `includeNullHypothesis` to `false`**
  so every figure measured before this candidate existed stays exactly
  reproducible from the library's own default, with no argument needed.
  That default is for reproducibility, not a recommendation: anyone
  importing `lib/diagnose` directly for actual diagnosis, not evaluation,
  should pass `true` unless deliberately reproducing a historical figure
  — which is exactly what the shipped UI already does.
- The displayed posterior percentage is not currently calibrated,
  especially on close top-two calls (EVALUATION.md §6) — read it as a
  ranking signal, not a literal probability of correctness.

## Architecture

```
scripts/build_index.py   Offline precompute (Python, uses vendor/malrulelib
                          directly). For every (problem instance, malrule)
                          pair in the v1 scope, records the answer that
                          malrule produces and the correct answer. Runs
                          once, on the developer's machine — never at
                          request time. Writes data/index/*.json.

lib/diagnose/             Pure TypeScript, no I/O. Given observed
                          (problem, answer) pairs, scores every malrule by
                          how well it explains them under an explicit
                          slip-rate noise model, returning a ranked
                          posterior — never a single verdict. Abstention
                          ("no systematic pattern detected") fires via an
                          explicit, tunable `abstentionThreshold`
                          parameter. Alternative scoring functions
                          (`scoringMethod`: naive exact-match, full
                          binomial likelihood, non-uniform prevalence
                          prior) are available behind a parameter that
                          defaults to the original scorer, added to test
                          whether findings are scorer-specific (they
                          are not — see EVALUATION.md §4). A "correct
                          student, wrong answers are slips" candidate is
                          available behind `includeNullHypothesis`,
                          default false so every figure measured before
                          this candidate existed stays reproducible from
                          the library default with no argument needed --
                          not a recommendation against using it. A
                          consumer importing this module directly should
                          pass `true` unless deliberately reproducing a
                          historical figure; the shipped UI already does
                          (see EVALUATION.md §2 for the measured benefit
                          and cost).

lib/select/                Pure TypeScript, no I/O. Given the current
                          posterior, scores candidate next problems by
                          expected posterior-entropy reduction and picks
                          the one that best discriminates the remaining
                          malrules. Frozen since the first evaluation
                          round; only ever called, never modified, by
                          every experiment module below. Confirmed by
                          direct code reading (round four): groups a
                          malrule's predicted answer by raw value only,
                          never checking it against the correct answer,
                          so a coincidentally-correct prediction is
                          treated as fully discriminating as a genuine
                          one -- see Key takeaway for the measured
                          exposure and its association with adaptive
                          selection's overconfidence when wrong.

scripts/lib/               Experiment modules for `npm run evaluate`:
                          leave-one-out misattribution, false positives on
                          non-malrule students, indistinguishability
                          characterization (writes
                          data/indistinguishability.json), scorer and
                          leave-one-out-proxy robustness checks, adaptive-
                          selection and calibration analysis, mixed-student
                          behavior, chance baselines and candidate-set
                          scaling, and ceiling/error decomposition.
                          `stats.mts` implements the Wilson and
                          between-cluster confidence intervals reported
                          throughout EVALUATION.md. Each module reads only
                          the committed index, no MalruleLib clone
                          required.

app/                      Next.js App Router UI, statically exported
                          (output: "export"). Reads only the committed
                          index. No database, no auth, no env vars, no API
                          routes, no runtime fetching — ships to Vercel
                          with zero configuration.

vendor/malrulelib/         MalruleLib, cloned as a read-only dependency.
                          Never edited.
```

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # Vitest — engine unit tests + planted-malrule recovery
npm run build      # static export, zero env vars required
npm run evaluate    # regenerates EVALUATION.md + data/indistinguishability.json
```

`data/index/` is precommitted, so none of the above needs MalruleLib itself.
Rebuilding the index from scratch does — `vendor/` is gitignored (it has its
own nested `.git`), so clone it first:

```bash
git clone https://github.com/sonkar-lab/malrulelib vendor/malrulelib
python3 scripts/build_index.py
```

## Noise model

A child correctly executing a malrule still makes occasional random slips
(arithmetic errors, copy errors, lapses). The engine scores each malrule by
consistency under an explicit `slipRate` parameter — the probability of a
slip on any single observation — not by requiring exact agreement on every
answer. `slipRate` is a named argument everywhere in `lib/diagnose` and
`lib/select`, adjustable live in the UI; it is never a hidden constant.

## Credits

- [MalruleLib](https://github.com/sonkar-lab/malrulelib) / [arXiv:2601.03217](https://arxiv.org/abs/2601.03217) — the executable
  misconception library and problem generators this project is built on.
  Vendored, unmodified, under `vendor/malrulelib/`.
- Brown, J.S. & Burton, R.R. (1978), *Cognitive Science* — BUGGY, the
  original bug-library diagnosis system.
- Burton, R.R. (1982), in Sleeman & Brown (Eds.), *Intelligent Tutoring
  Systems* — DEBUGGY, which added adaptive diagnostic test generation.
