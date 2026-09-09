# Pre-registration: testing malrule-diagnose against FoundationalASSIST

**Status at time of writing: FoundationalASSIST access is PENDING. No real
data has been loaded, viewed, or used to inform anything in this document
or any of the code it references.** This document is itself part of the
commitment: it exists so that, once access clears, there is a dated, public
record of what was decided beforehand, so none of it can be quietly revised
against results.

Frozen artifact this document points to: `config/abstention.json`, written
`2026-09-09T06:38:41.636Z`, self-integrity-checked (see below) so it cannot
be edited after the fact without the tamper detector in
`scripts/lib/frozenAbstentionConfig.mts` refusing to load it.

## 1. The abstention threshold

`diagnose()` already had an abstention mechanism (`noPatternDetected` /
`abstentionThreshold`); this project's contribution was calibrating it
properly and freezing the result before real data exists, rather than
tuning it against FoundationalASSIST behavior later.

**Selection rule, decided before the calibration sweep was run:** the
smallest grid threshold (`{0, 0.5, 1, 1.5, 2, 3, 5, 8, 12, 20}`) whose
calibration-set top-1 precision among non-abstained diagnoses is **≥ 95%**,
ties toward the lower (more permissive) threshold.

**Split:** every synthetic instance is deterministically assigned to a
calibration set (~80%, 1,641 instances) or a held-out set (~20%, 439
instances) via `hashString(instance_id) % 5 !== 0`. The threshold was
selected using the calibration set only; the held-out set was never
consulted for selection, only for reporting afterward.

**Result: `abstentionThreshold = 3`.**

| | Calibration set | Held-out set (not used for selection) |
|---|---|---|
| n | 2,600 | 2,600 |
| Abstention rate at threshold=3 | 32.3% | 30.3% |
| Precision at threshold=3 | 95.2% | 96.0% |

The held-out figures track the calibration figures closely (95.2%→96.0%
precision, 32.3%→30.3% abstention) — no sign of overfitting to the
calibration split. For reference, the shipped default (`threshold=1`)
reaches only 92.5% calibration precision — **below the pre-registered bar**
— and is not used for this evaluation; that gap is reported, not hidden.

**Committed, machine-checkable:** `config/abstention.json` carries the
chosen threshold, the deterministic seed basis, the calibration/held-out
instance-id-set hashes, the full threshold-sweep curve for both sets, and a
`selfHash` covering its own content. `loadFrozenAbstentionConfig()`
recomputes that hash and throws if it doesn't match — a silent post-hoc
edit to the threshold is not possible through the intended loading path.

**Commitment: this threshold will not be revisited, re-swept, or replaced
after real data is loaded**, for any reason short of a genuine bug in the
calibration code itself (in which case the fix and its rationale would be
documented, not a silent re-tune).

## 2. The three label-free metrics

All three are implemented in `scripts/lib/metric*.mts`, unit-tested against
synthetic positive/negative-control fixtures (never real data), and take
generic observation records so the same code runs unmodified once
FoundationalASSIST is loaded through the Phase 3 adapter.

### 2a. Coverage vs. null (`metricCoverage.mts`)

**Metric:** fraction of wrong answers that receive a non-abstain diagnosis
("real coverage"), against a shuffled null that holds the problem fixed and
substitutes the observed wrong answer with a wrong answer some *other*
observation gave on a *different* problem in the same skill — preserving
the marginal distribution of wrong answers within that skill while
destroying the problem-answer correspondence.

**Reported:** real coverage, null coverage, the gap, and a paired
(McNemar-style) 95% CI on the gap.

**What would count as evidence for transfer:** a gap whose 95% CI excludes
zero.

**What would count as evidence against transfer, and is a valid,
reportable result, not a failure to hide:** a gap near zero, or a CI
including zero. **This will be reported as the headline finding if it is
what the data shows** — the whole purpose of building this before seeing
real data is to remove any incentive to bury a null result.

### 2b. Within-student systematicity (`metricSystematicity.mts`)

**Metric:** per student (≥ 2 non-abstain diagnoses in a skill), the modal-
diagnosis share and Shannon entropy (bits) of their diagnosis-label
distribution across different problems in that skill.

**Null:** a permutation null that shuffles which diagnosis label lands on
which student's slot within a skill, holding each student's observation
count fixed (so it controls for how many problems each student attempted
and the overall label frequency in that skill — only the *assignment* of
labels to students is randomized).

**Reported:** observed mean modal share and mean entropy, and two-sided
p-values against the permutation distribution (500 permutation trials,
seeded).

**What would count as evidence for the malrule framework describing real
students:** observed concentration (high modal share / low entropy)
significantly outside the permutation null (p < 0.05).

**What would count as evidence against it:** observed statistics
indistinguishable from the null — students' diagnoses look no more
consistent than random label reassignment. Also reportable as-is.

### 2c. Predictive check (`metricPredictiveCheck.mts`)

**Metric:** fit the malrule hypothesis on a student's first *k* errors in a
skill (`diagnose()` on those *k* observations), then predict their EXACT
wrong answer on error *k*+1 by executing the top-ranked malrule against
that problem — not "was it wrong," the literal string.

**Baseline:** per-item chance, computed from the number of distinct answer
values actually on record for that specific problem (same principle as
`diagnose.ts`'s own internal chance-rate calculation) — not an assumed
answer-space size.

**Reported:** hit rate by *k*, against the chance baseline, for each *k* in
a pre-specified set (to be fixed at implementation of the Phase 5 run
script, before that script is pointed at real data — see commitments
below).

**Interpretation:** a hit rate persistently and substantially above chance
across *k* is evidence a documented malrule is not just describable but
*predictive* of a specific student's next mistake. A hit rate at or near
chance is evidence against that, and is reportable as such.

### What is explicitly NOT claimed

None of these three metrics can validate that a *named* malrule is
correct — there are no real labels to check that against. They can only
show whether the malrule-diagnose *framework* (candidate procedures,
matching, abstention) explains real wrong-answer patterns better than
chance would. That distinction will be stated plainly wherever these
metrics are reported, not blurred into an accuracy claim.

## 3. The data adapter

Schema sourced from the HuggingFace dataset card
(`https://huggingface.co/datasets/ASSISTments/FoundationalASSIST`, fetched
2026-09-08) and cross-checked against the dataset paper (arXiv:2602.00070).
Two things that documentation does not specify precisely are flagged, not
guessed: the exact serialization of `fill_in_answers` /
`multiple_choice_answers`, and the full `answer_type` enum. The loader
tries several plausible formats and returns `null` rather than a guess
when it can't confidently parse a value (`scripts/lib/foundationalAssist/loader.mts`).

**The discrete_score trap, committed handling:** `discrete_score` is 0
whenever a student requested a hint or saw the answer, even if their first
answer (`answer_text`) was correct. Wrongness is derived **only** by
comparing `answer_text` against the correct answer read from the linked
Problems record — `discrete_score` is parsed and exposed for bookkeeping
but is never read for this purpose anywhere in the adapter. Enforced by an
explicit, passing unit test (`loader.test.mts`, "does NOT treat
discrete_score == 0 as evidence of a wrong answer").

**One observation per student-problem:** `answer_text` is documented as
the student's first answer only; there is no attempt-sequence field. The
adapter does not, and will not, write code that assumes multiple attempts
exist per problem.

**Schema validator:** fails loudly (throws, with a diff of missing vs.
unexpected columns) if the real files' headers don't match the documented
schema above. This is the first thing that runs against the real files —
before anything else touches them.

## 4. The problem-text parser

Bounded, pattern-based extraction of (operation, operands) from
`problem_body`, since malrule inference needs specific numbers, not a
description. **Expected to succeed on a subset of the 3,395 problems, not
all of them** — this is not a target to be hit, it is an honest limitation
to be reported. Ambiguous or unrecognized phrasing returns `null`, never a
guess (`scripts/lib/foundationalAssist/problemParser.mts`).

**Committed:** when run against the real Problems file, `computeParseCoverage()`
will report the coverage fraction as measured, with no floor or target to
meet, and `emitUnparseableSet()` will write the *complete* unparseable set
to a file for manual inspection — never a sample, never silently dropped.

## 5. What is explicitly deferred to Phase 5 (gated on data access)

Not decided or run yet, and this document makes no commitments about their
outcome, only about the process once they run:

- The skill-overlap audit: which of the 224 IM skill codes in the Skills
  file intersect the 26 elementary Number & Operations malrules this
  project covers. This determines how much of FoundationalASSIST is even
  in-scope before any of the metrics above can be run on it.
- Fixing the exact `k` grid for the predictive check (§2c) — will be fixed
  in the Phase 5 run script BEFORE it is pointed at real data, and that
  commit will be the record of when it was fixed.
- Any actual numbers from real data. None exist yet.

## 6. Standing commitments (apply to every section above)

- No metric definition, null construction, or the abstention selection
  rule will be changed after real data is loaded.
- A null or near-zero result on any of the three metrics is reported as
  the finding, at the same prominence a positive result would get — not
  downgraded, caveated away, or led with a different metric instead.
- If the schema validator fails against the real files, the fix is a
  deliberate, documented schema update (not a silent broadening of what
  counts as a match) — logged as a change to `schema.mts`, not a workaround
  in the loader.
- Every number that ends up in a report from this point forward must be
  regenerable from the frozen config and the committed code, the same
  discipline this project has followed since round one's `npm run
  evaluate`.
