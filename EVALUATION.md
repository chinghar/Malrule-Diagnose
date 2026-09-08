# Evaluation

All numbers below are computed against MalruleLib-generated synthetic data
only (`data/index/`), covering the v1 scope: 26 malrules across
subtraction, fractions, decimals, and multiplication/division
(2080 problem instances). **This is an upper bound.** Real
children's work is noisier than any slip-rate model here can fully capture --
see the README for the classroom-validity caveat.

The diagnosis engine's assumed noise parameter (`slipRate`) was held fixed at
**0.15** for every measurement below, including when the *true*
injected slip rate in (b) differs from it. This deliberately tests robustness
to not knowing a real child's slip rate in advance, rather than reporting an
oracle best case.

**Malrule identification accuracy and Malrule Reasoning Accuracy (MRA) are
different metrics.** Identification accuracy (a, b) asks only "did the
correct malrule rank first (or in the top 3)?" MRA (c) is the paper's task:
infer the malrule from one example, then predict the student's answer on a
*different* problem. Only (c) is a like-for-like comparison with the paper's
published LLM baselines (40.5% cross-template answer-only, 46.5% with step
traces).

## (a) Identification accuracy vs. number of observations (clean data)

0% injected slip, 40 trials per malrule per observation count,
model slip rate 0.15.

| Observations | n | Top-1 | Top-1-or-tied | Top-3 |
|---|---|---|---|---|
| 1 | 1040 | 87.5% | 100.0% | 98.6% |
| 2 | 1040 | 89.4% | 94.8% | 99.4% |
| 3 | 1040 | 92.6% | 94.5% | 100.0% |
| 4 | 1040 | 93.1% | 94.2% | 100.0% |
| 5 | 1040 | 93.1% | 93.9% | 100.0% |
| 6 | 1040 | 92.5% | 92.9% | 100.0% |
| 7 | 1040 | 93.2% | 93.2% | 100.0% |
| 8 | 1040 | 93.2% | 93.2% | 100.0% |
| 9 | 1040 | 92.9% | 93.0% | 100.0% |
| 10 | 1040 | 92.3% | 92.3% | 100.0% |

## (b) Identification accuracy vs. number of observations, by injected slip rate

Each table uses the same trial protocol as (a) but with random slips injected
into the simulated student's answers at the stated rate (the model still
assumes slip rate 0.15 throughout, regardless of the true rate).

### Injected slip rate: 5%

| Observations | n | Top-1 | Top-1-or-tied | Top-3 |
|---|---|---|---|---|
| 1 | 1040 | 82.7% | 96.8% | 96.9% |
| 2 | 1040 | 85.9% | 92.5% | 99.2% |
| 3 | 1040 | 88.1% | 91.1% | 99.2% |
| 4 | 1040 | 87.1% | 88.8% | 99.6% |
| 5 | 1040 | 87.0% | 87.4% | 99.9% |
| 6 | 1040 | 86.3% | 86.9% | 100.0% |
| 7 | 1040 | 86.3% | 86.3% | 100.0% |
| 8 | 1040 | 84.5% | 84.6% | 99.8% |
| 9 | 1040 | 85.0% | 85.0% | 99.8% |
| 10 | 1040 | 83.8% | 83.8% | 99.8% |

### Injected slip rate: 10%

| Observations | n | Top-1 | Top-1-or-tied | Top-3 |
|---|---|---|---|---|
| 1 | 1040 | 81.7% | 93.8% | 96.3% |
| 2 | 1040 | 78.7% | 87.9% | 96.0% |
| 3 | 1040 | 82.7% | 86.0% | 98.6% |
| 4 | 1040 | 82.3% | 84.2% | 98.7% |
| 5 | 1040 | 82.6% | 83.0% | 99.0% |
| 6 | 1040 | 81.6% | 82.5% | 99.1% |
| 7 | 1040 | 78.8% | 79.1% | 99.6% |
| 8 | 1040 | 77.8% | 78.0% | 99.6% |
| 9 | 1040 | 77.5% | 77.6% | 98.8% |
| 10 | 1040 | 78.1% | 78.2% | 99.4% |

### Injected slip rate: 20%

| Observations | n | Top-1 | Top-1-or-tied | Top-3 |
|---|---|---|---|---|
| 1 | 1040 | 70.6% | 85.8% | 93.4% |
| 2 | 1040 | 69.8% | 83.9% | 95.0% |
| 3 | 1040 | 71.3% | 77.1% | 95.5% |
| 4 | 1040 | 70.9% | 75.1% | 96.4% |
| 5 | 1040 | 71.4% | 73.1% | 97.9% |
| 6 | 1040 | 70.3% | 71.2% | 98.1% |
| 7 | 1040 | 70.7% | 71.1% | 98.0% |
| 8 | 1040 | 67.2% | 67.4% | 98.0% |
| 9 | 1040 | 66.0% | 66.3% | 98.0% |
| 10 | 1040 | 64.6% | 65.0% | 98.5% |

## (c) Malrule Reasoning Accuracy (MRA) -- comparable to the paper

Task: given one worked mistake on problem A (no injected noise -- a clean
example of the malrule), infer the malrule, then predict the student's answer
on a different problem B. Because this engine predicts by directly executing
the diagnosed malrule rather than guessing, a correct diagnosis on an
applicable B guarantees a correct answer prediction by construction -- so
this number is really measuring single-example identification accuracy,
restricted to worked-mistake instances that have a valid new-problem partner
of the stated kind. That collapse (identification-correct implies
answer-correct) is the central mechanical difference from the LLM setting,
where naming a misconception correctly does not guarantee simulating it
correctly on a new problem -- and is a large part of why a deterministic
engine can be expected to outperform a model doing both steps by inference.

| Pairing | n | MRA accuracy | Paper baseline (answer-only / with steps) |
|---|---|---|---|
| Same-template | 2080 | 93.3% | n/a (paper reports cross-template only) |
| Cross-template | 1920 | 92.8% | 40.5% / 46.5% |

## (d) Ambiguity analysis

Malrule pairs whose predicted answers agree on **every** instance of a given
template (minimum 3 instances compared) -- meaning no
amount of observation restricted to that single template can ever tell them
apart. This is a structural property of MalruleLib's problem generators, not
a limitation of the scoring engine: on these templates, only a
differently-shaped problem (the adaptive selector's job -- see Phase 4) can
break the tie.

**subtraction** (74 indistinguishable template-level pairs)

| Template | Malrule A | Malrule B | Instances compared |
|---|---|---|---|
| basic_regrouped_tens | subtraction.borrow_from_bottom | subtraction.diff_0_n_equals_n | 21 |
| basic_regrouped_tens | subtraction.borrow_from_bottom | subtraction.smaller_from_larger | 21 |
| basic_regrouped_tens | subtraction.borrow_from_bottom | subtraction.stops_borrow_at_zero | 21 |
| basic_regrouped_tens | subtraction.diff_0_n_equals_n | subtraction.smaller_from_larger | 21 |
| basic_regrouped_tens | subtraction.diff_0_n_equals_n | subtraction.stops_borrow_at_zero | 21 |
| basic_regrouped_tens | subtraction.smaller_from_larger | subtraction.stops_borrow_at_zero | 21 |
| comparison_problem | subtraction.always_borrow_left | subtraction.stops_borrow_at_zero | 17 |
| consecutive_zeros | subtraction.diff_0_n_equals_n | subtraction.smaller_from_larger | 17 |
| four_digit | subtraction.diff_0_n_equals_n | subtraction.stops_borrow_at_zero | 25 |
| large_digits_no_borrow | subtraction.borrow_from_bottom | subtraction.borrow_no_decrement | 12 |
| large_digits_no_borrow | subtraction.borrow_from_bottom | subtraction.diff_0_n_equals_n | 12 |
| large_digits_no_borrow | subtraction.borrow_from_bottom | subtraction.smaller_from_larger | 12 |
| large_digits_no_borrow | subtraction.borrow_from_bottom | subtraction.stops_borrow_at_zero | 12 |
| large_digits_no_borrow | subtraction.borrow_no_decrement | subtraction.diff_0_n_equals_n | 12 |
| large_digits_no_borrow | subtraction.borrow_no_decrement | subtraction.smaller_from_larger | 12 |
| large_digits_no_borrow | subtraction.borrow_no_decrement | subtraction.stops_borrow_at_zero | 12 |
| large_digits_no_borrow | subtraction.diff_0_n_equals_n | subtraction.smaller_from_larger | 12 |
| large_digits_no_borrow | subtraction.diff_0_n_equals_n | subtraction.stops_borrow_at_zero | 12 |
| large_digits_no_borrow | subtraction.smaller_from_larger | subtraction.stops_borrow_at_zero | 12 |
| missing_number | subtraction.always_borrow_left | subtraction.stops_borrow_at_zero | 15 |
| multi_step_problem | subtraction.always_borrow_left | subtraction.stops_borrow_at_zero | 20 |
| multiple_carries | subtraction.borrow_from_bottom | subtraction.smaller_from_larger | 14 |
| multiple_carries | subtraction.borrow_from_bottom | subtraction.stops_borrow_at_zero | 14 |
| multiple_carries | subtraction.smaller_from_larger | subtraction.stops_borrow_at_zero | 14 |
| multiple_columns_no_borrow | subtraction.borrow_from_bottom | subtraction.borrow_no_decrement | 17 |
| multiple_columns_no_borrow | subtraction.borrow_from_bottom | subtraction.diff_0_n_equals_n | 17 |
| multiple_columns_no_borrow | subtraction.borrow_from_bottom | subtraction.smaller_from_larger | 17 |
| multiple_columns_no_borrow | subtraction.borrow_from_bottom | subtraction.stops_borrow_at_zero | 17 |
| multiple_columns_no_borrow | subtraction.borrow_no_decrement | subtraction.diff_0_n_equals_n | 17 |
| multiple_columns_no_borrow | subtraction.borrow_no_decrement | subtraction.smaller_from_larger | 17 |
| multiple_columns_no_borrow | subtraction.borrow_no_decrement | subtraction.stops_borrow_at_zero | 17 |
| multiple_columns_no_borrow | subtraction.diff_0_n_equals_n | subtraction.smaller_from_larger | 17 |
| multiple_columns_no_borrow | subtraction.diff_0_n_equals_n | subtraction.stops_borrow_at_zero | 17 |
| multiple_columns_no_borrow | subtraction.smaller_from_larger | subtraction.stops_borrow_at_zero | 17 |
| multiple_regroupings | subtraction.borrow_from_bottom | subtraction.diff_0_n_equals_n | 16 |
| multiple_regroupings | subtraction.borrow_from_bottom | subtraction.smaller_from_larger | 16 |
| multiple_regroupings | subtraction.borrow_from_bottom | subtraction.stops_borrow_at_zero | 16 |
| multiple_regroupings | subtraction.diff_0_n_equals_n | subtraction.smaller_from_larger | 16 |
| multiple_regroupings | subtraction.diff_0_n_equals_n | subtraction.stops_borrow_at_zero | 16 |
| multiple_regroupings | subtraction.smaller_from_larger | subtraction.stops_borrow_at_zero | 16 |
| multiple_zeros | subtraction.diff_0_n_equals_n | subtraction.smaller_from_larger | 13 |
| regrouped_ones | subtraction.always_borrow_left | subtraction.borrow_from_bottom | 9 |
| regrouped_ones | subtraction.always_borrow_left | subtraction.diff_0_n_equals_n | 9 |
| regrouped_ones | subtraction.always_borrow_left | subtraction.smaller_from_larger | 9 |
| regrouped_ones | subtraction.always_borrow_left | subtraction.stops_borrow_at_zero | 9 |
| regrouped_ones | subtraction.borrow_from_bottom | subtraction.diff_0_n_equals_n | 9 |
| regrouped_ones | subtraction.borrow_from_bottom | subtraction.smaller_from_larger | 9 |
| regrouped_ones | subtraction.borrow_from_bottom | subtraction.stops_borrow_at_zero | 9 |
| regrouped_ones | subtraction.diff_0_n_equals_n | subtraction.smaller_from_larger | 9 |
| regrouped_ones | subtraction.diff_0_n_equals_n | subtraction.stops_borrow_at_zero | 9 |
| regrouped_ones | subtraction.smaller_from_larger | subtraction.stops_borrow_at_zero | 9 |
| three_digit_no_borrow | subtraction.borrow_from_bottom | subtraction.borrow_no_decrement | 15 |
| three_digit_no_borrow | subtraction.borrow_from_bottom | subtraction.diff_0_n_equals_n | 15 |
| three_digit_no_borrow | subtraction.borrow_from_bottom | subtraction.smaller_from_larger | 15 |
| three_digit_no_borrow | subtraction.borrow_from_bottom | subtraction.stops_borrow_at_zero | 15 |
| three_digit_no_borrow | subtraction.borrow_no_decrement | subtraction.diff_0_n_equals_n | 15 |
| three_digit_no_borrow | subtraction.borrow_no_decrement | subtraction.smaller_from_larger | 15 |
| three_digit_no_borrow | subtraction.borrow_no_decrement | subtraction.stops_borrow_at_zero | 15 |
| three_digit_no_borrow | subtraction.diff_0_n_equals_n | subtraction.smaller_from_larger | 15 |
| three_digit_no_borrow | subtraction.diff_0_n_equals_n | subtraction.stops_borrow_at_zero | 15 |
| three_digit_no_borrow | subtraction.smaller_from_larger | subtraction.stops_borrow_at_zero | 15 |
| two_digit_no_borrow | subtraction.borrow_from_bottom | subtraction.borrow_no_decrement | 16 |
| two_digit_no_borrow | subtraction.borrow_from_bottom | subtraction.diff_0_n_equals_n | 16 |
| two_digit_no_borrow | subtraction.borrow_from_bottom | subtraction.smaller_from_larger | 16 |
| two_digit_no_borrow | subtraction.borrow_from_bottom | subtraction.stops_borrow_at_zero | 16 |
| two_digit_no_borrow | subtraction.borrow_no_decrement | subtraction.diff_0_n_equals_n | 16 |
| two_digit_no_borrow | subtraction.borrow_no_decrement | subtraction.smaller_from_larger | 16 |
| two_digit_no_borrow | subtraction.borrow_no_decrement | subtraction.stops_borrow_at_zero | 16 |
| two_digit_no_borrow | subtraction.diff_0_n_equals_n | subtraction.smaller_from_larger | 16 |
| two_digit_no_borrow | subtraction.diff_0_n_equals_n | subtraction.stops_borrow_at_zero | 16 |
| two_digit_no_borrow | subtraction.smaller_from_larger | subtraction.stops_borrow_at_zero | 16 |
| word_problem_context | subtraction.always_borrow_left | subtraction.stops_borrow_at_zero | 18 |
| word_problem_missing_minuend | subtraction.diff_0_n_equals_n | subtraction.stops_borrow_at_zero | 3 |
| zero_in_ones_place | subtraction.diff_0_n_equals_n | subtraction.smaller_from_larger | 17 |

**fractions** (4 indistinguishable template-level pairs)

| Template | Malrule A | Malrule B | Instances compared |
|---|---|---|---|
| basic_comparison | fractions.denominator_comparison_error | fractions.natural_number_bias_numerator_only | 17 |
| ordering | fractions.denominator_comparison_error | fractions.natural_number_bias_numerator_only | 5 |
| visual_models | fractions.denominator_comparison_error | fractions.natural_number_bias_numerator_only | 15 |
| word_problem_ordering | fractions.denominator_comparison_error | fractions.natural_number_bias_numerator_only | 15 |

**decimals** (12 indistinguishable template-level pairs)

| Template | Malrule A | Malrule B | Instances compared |
|---|---|---|---|
| basic_comparison | decimals.longer_is_larger | decimals.whole_number_thinking | 18 |
| basic_multiplication | decimals.ignore_decimal_point | decimals.whole_number_thinking | 15 |
| basic_multiplication | decimals.longer_is_larger | decimals.shorter_is_larger | 15 |
| basic_subtraction | decimals.right_align_decimals | decimals.whole_number_thinking | 6 |
| division | decimals.ignore_decimal_point | decimals.whole_number_thinking | 12 |
| division | decimals.longer_is_larger | decimals.shorter_is_larger | 12 |
| measurement_context | decimals.ignore_decimal_point | decimals.whole_number_thinking | 17 |
| money_context | decimals.ignore_decimal_point | decimals.whole_number_thinking | 10 |
| scientific_context | decimals.ignore_decimal_point | decimals.whole_number_thinking | 10 |
| subtraction | decimals.longer_is_larger | decimals.shorter_is_larger | 16 |
| three_number_mixed | decimals.right_align_decimals | decimals.whole_number_thinking | 17 |
| word_problem | decimals.longer_is_larger | decimals.whole_number_thinking | 16 |

## Phase 4: adaptive vs. random problem selection

Re-runs measurement (a)'s protocol, but instead of asking a fixed number of
random observations, each strategy is run to **convergence**: keep asking
(clean, 0% slip) questions until the diagnosis uniquely and correctly
identifies the true malrule (top-1 correct and not tied with any other
malrule), or 15 observations are used without converging.
"Adaptive" picks, at each step, the not-yet-asked problem with the highest
expected posterior-entropy reduction (`lib/select`); "random" picks
uniformly among not-yet-asked problems. Both strategies draw only from
problems the true malrule can actually be evaluated on, and every
(malrule, trial) pair uses the same trial index for both strategies so the
comparison isn't confounded by which problems happen to be available.
20 trials per malrule per strategy (520 runs each).

| Strategy | Converged | Mean observations to converge |
|---|---|---|
| adaptive | 500/520 (96.2%) | 1.00 |
| random | 498/520 (95.8%) | 1.40 |

Adaptive selection needed **0.40 fewer observations on average** (28.3% reduction) to reach a unique, correct diagnosis, and converged in 96.2% of runs vs. 95.8% for random selection within the 15-observation cap.
