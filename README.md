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
them. This project exists to test whether that beats the paper's LLM
baseline with no model in the loop anywhere. See
[EVALUATION.md](EVALUATION.md) for the numbers, measured honestly — the
report states plainly where a comparison to the paper is and isn't
apples-to-apples.

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
                          posterior — never a single verdict.

lib/select/                Pure TypeScript, no I/O. Given the current
                          posterior, scores candidate next problems by
                          expected posterior-entropy reduction and picks
                          the one that best discriminates the remaining
                          malrules.

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
npm run evaluate    # regenerates EVALUATION.md from the committed index
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
