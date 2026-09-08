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

This project has now been through two rounds of evaluation: the first
established closed-world accuracy and a structural property of the
malrule library; the second attacked the cases the first missed, and
found one that changes what can honestly be claimed about usability.
**This tool should not be described as usable at its shipped default
without the qualification below.**

**Correct students get confidently misdiagnosed, and in one category it's
close to a coin flip.** `diagnose()` has no "correct answer" hypothesis
anywhere in its candidate set — only malrules. Feeding it a student who
answers every problem correctly (or with only minor arithmetic slips, no
misconception at all) produces a confident, wrong malrule diagnosis 15% of
the time, pooled across categories — but that pooled number hides the real
story. Checked separately, it's **~50% in subtraction** and only 3–4%
elsewhere; the between-category confidence interval's lower bound touches
zero, meaning "15% overall" is not a stable claim, "roughly 50% in
subtraction" is. The mechanistic cause is identified, not just observed:
three specific subtraction malrules simply don't trigger their own bug on
34–54% of the problems they could be asked, so a correct answer there
coincidentally *is* what they predict. This was first seen manually, not
statistically — three correct answers to real subtraction problems
produced an 85%-confident wrong diagnosis during this project's own UI
testing, before any of the systematic measurement in
[EVALUATION.md §2](EVALUATION.md) existed.

**Adaptive problem selection compounds this rather than fixing it.** It
does not misdiagnose out-of-library students *more often* than asking
random questions — but when it is wrong, it is far more confident: 96–99%
posterior versus random selection's 79–85%, and the gap widens with more
questions asked. The feature that makes correct diagnoses converge faster
makes incorrect ones look more certain, with no way for the UI to tell the
two apart.

**The displayed confidence number is least reliable on exactly the calls
where a user would lean on it.** Restricted to trials where the top two
malrules are close — the ones most likely to be shown as ambiguous — a
reported "~53% confident" call is actually correct only about 11% of the
time. The UI displays the raw posterior with no calibration adjustment
anywhere in the pipeline.

**The previously-reported 28% misattribution rate on genuinely novel
procedures has no established direction of bias**, and should not be
reported as a single corrected number. Testing synthetic bugs harder than
a held-out library malrule found the two plausible "novel bug" shapes move
in *opposite* directions: a child blending two known misconceptions is
misattributed *more* often (up to 38%); a child with a known bug plus one
extra unrelated slip is misattributed *far less* often (under 2%). Which
better describes a given real child can't be determined from this
evidence — 28% is a real number for held-out library malrules
specifically, not a general-purpose estimate for "novel bugs."

**None of this is an artifact of the scoring function.** Re-running both
headline findings above under three alternative scorers (naive exact-match
count, full binomial likelihood, a non-uniform prevalence prior — added
behind a parameter specifically to test this) never produced a *better*
result than the current scorer; every alternative was equal to or worse.
That supports reading these numbers as a property of matching-based
diagnosis over a collision-prone hypothesis space, not a fixable
implementation quirk — it strengthens, rather than narrows, the
generalization claim below.

**The first round's structural finding still stands, and still matters** —
just no longer as the single most urgent thing to know. Checking all 325
possible malrule pairs against the entire committed index, exactly **one
pair is fully indistinguishable**: `decimals.ignore_decimal_point` and
`decimals.whole_number_thinking`. No problem in this library, however
chosen, can ever tell them apart. 18 more pairs collide on *some*
templates but are fixable by choosing a different problem shape — each
with a concrete discriminating example in
[EVALUATION.md](EVALUATION.md) and the machine-readable
`data/indistinguishability.json`.

**On the paper comparison:** this project also measured the paper's own
task (Malrule Reasoning Accuracy) and got **92.8% cross-template**, against
the paper's reported LLM baseline of 40.5%/46.5%. **That comparison is not
apples to apples, and the number should not be read as this engine
outperforming the LLM baseline.** The paper's task is open-world — an LLM
must infer an *unseen* procedure and correctly re-execute it, with no
guarantee the student is even running a systematic procedure at all. This
engine selects from a pre-enumerated candidate set (5–8 malrules per
category) that contains the true answer by construction in every
measurement except the ones described above. The 92.8% figure is humbling
on closer inspection too: roughly a fifth of those trials are genuinely
tied between two equally-supported malrules, and part of the reported
number depends on an arbitrary alphabetical tie-break convention rather
than additional evidence — see EVALUATION.md's ceiling analysis, and §11
for the full non-comparability statement.

The part that does generalize beyond this project — precondition intact,
and sharpened by this round: when the hypothesis space is a library of
*executable procedures* and the true procedure is known to be a member of
that library, "which procedure produced this output" is a matching
problem, not a reasoning problem. That precondition is load-bearing.
Outside it, matching has no mechanism for representing "none of the above"
except an explicit abstention rule — and this round found that rule
unreliable specifically for the case that will be the *most common* input
to a real deployment: a student who is doing nothing wrong.

This project is best read as an engineering artifact plus an honest audit
of its own limits, not a benchmark result: a deterministic inverse solver
over an open, executable misconception library, with adaptive next-problem
selection and a working interface, which does not appear to exist
elsewhere — evaluated, in this second round, specifically for the ways it
could mislead the people using it.

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
- **That abstention mechanism is not reliable enough yet to call this tool
  safe for correct students, particularly in subtraction** (~50%
  false-positive rate there at the shipped default — see Key takeaway and
  [EVALUATION.md §2](EVALUATION.md)). This is stated here plainly, not just
  in the evaluation report, because it directly bears on whether to trust
  a diagnosis this tool gives you.
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
                          are not — see EVALUATION.md §4).

lib/select/                Pure TypeScript, no I/O. Given the current
                          posterior, scores candidate next problems by
                          expected posterior-entropy reduction and picks
                          the one that best discriminates the remaining
                          malrules. Frozen since the first evaluation
                          round; only ever called, never modified, by
                          every experiment module below.

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
