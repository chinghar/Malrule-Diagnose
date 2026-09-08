import { describe, expect, it } from "vitest";
import { diagnose, DEFAULT_ABSTENTION_THRESHOLD } from "./diagnose";
import type { MalruleMeta, ProblemInstance } from "./types";

const malrules: MalruleMeta[] = [
  { id: "cat.rule_a", category: "cat", name: "Rule A", description: "" },
  { id: "cat.rule_b", category: "cat", name: "Rule B", description: "" },
  { id: "cat.rule_c", category: "cat", name: "Rule C", description: "" },
  { id: "cat.rule_untested", category: "cat", name: "Untested Rule", description: "" },
];

// Three instances. rule_a and rule_b agree on i1 (both indistinguishable
// there) but diverge on i2 and i3. rule_c always predicts the correct
// answer's twin so it never matches a student who is wrong. rule_untested's
// algorithm never runs on any of these shapes.
const instances: ProblemInstance[] = [
  {
    instance_id: "i1",
    native_malrule_id: "cat.rule_a",
    template: "t1",
    problem_text: "1",
    operation: "op",
    correct_answer: "100",
    predictions: { "cat.rule_a": "10", "cat.rule_b": "10", "cat.rule_c": "20" },
  },
  {
    instance_id: "i2",
    native_malrule_id: "cat.rule_a",
    template: "t1",
    problem_text: "2",
    operation: "op",
    correct_answer: "200",
    predictions: { "cat.rule_a": "11", "cat.rule_b": "22", "cat.rule_c": "33" },
  },
  {
    instance_id: "i3",
    native_malrule_id: "cat.rule_a",
    template: "t1",
    problem_text: "3",
    operation: "op",
    correct_answer: "300",
    predictions: { "cat.rule_a": "12", "cat.rule_b": "24", "cat.rule_c": "36" },
  },
];

describe("diagnose", () => {
  it("ranks the malrule matching every observation above the others", () => {
    const result = diagnose(
      [
        { instanceId: "i1", studentAnswer: "10" },
        { instanceId: "i2", studentAnswer: "11" },
        { instanceId: "i3", studentAnswer: "12" },
      ],
      instances,
      malrules,
      0.1
    );
    expect(result.ranked[0]?.malruleId).toBe("cat.rule_a");
    expect(result.ranked[0]?.matches).toBe(3);
    expect(result.tiedTop).toEqual(["cat.rule_a"]);
  });

  it("a rule matching more observations outranks one matching fewer", () => {
    const result = diagnose(
      [
        { instanceId: "i1", studentAnswer: "10" }, // matches a and b
        { instanceId: "i2", studentAnswer: "22" }, // matches b only
        { instanceId: "i3", studentAnswer: "24" }, // matches b only
      ],
      instances,
      malrules,
      0.1
    );
    expect(result.ranked[0]?.malruleId).toBe("cat.rule_b");
    expect(result.ranked[0]?.matches).toBe(3);
    const a = result.ranked.find((r) => r.malruleId === "cat.rule_a");
    expect(a?.matches).toBe(1);
    expect(result.ranked[0]!.logLikelihood).toBeGreaterThan(a!.logLikelihood);
  });

  it("reports a tie when two malrules are indistinguishable on the observations given", () => {
    const result = diagnose([{ instanceId: "i1", studentAnswer: "10" }], instances, malrules, 0.1);
    expect(result.tiedTop.sort()).toEqual(["cat.rule_a", "cat.rule_b"]);
  });

  it("excludes malrules that never applied to any observed instance, listing them as untested", () => {
    const result = diagnose([{ instanceId: "i1", studentAnswer: "10" }], instances, malrules, 0.1);
    expect(result.ranked.some((r) => r.malruleId === "cat.rule_untested")).toBe(false);
    expect(result.untested).toEqual(["cat.rule_untested"]);
  });

  it("flags no systematic pattern when answers don't beat chance for any malrule", () => {
    // "99" never appears as anyone's prediction anywhere -- pure noise.
    const result = diagnose(
      [
        { instanceId: "i1", studentAnswer: "99" },
        { instanceId: "i2", studentAnswer: "98" },
        { instanceId: "i3", studentAnswer: "97" },
      ],
      instances,
      malrules,
      0.1
    );
    expect(result.noPatternDetected).toBe(true);
  });

  it("does not flag no-pattern when a malrule is consistently matched", () => {
    const result = diagnose(
      [
        { instanceId: "i1", studentAnswer: "10" },
        { instanceId: "i2", studentAnswer: "11" },
        { instanceId: "i3", studentAnswer: "12" },
      ],
      instances,
      malrules,
      0.1
    );
    expect(result.noPatternDetected).toBe(false);
  });

  it("returns an empty, no-pattern result for zero observations", () => {
    const result = diagnose([], instances, malrules, 0.1);
    expect(result.ranked).toEqual([]);
    expect(result.noPatternDetected).toBe(true);
    expect(result.untested).toHaveLength(4);
  });

  it("normalized posteriors sum to 1 across applicable malrules", () => {
    const result = diagnose(
      [
        { instanceId: "i1", studentAnswer: "10" },
        { instanceId: "i2", studentAnswer: "22" },
      ],
      instances,
      malrules,
      0.1
    );
    const sum = result.ranked.reduce((s, r) => s + r.posterior, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("rejects slip rates outside (0, 1)", () => {
    expect(() => diagnose([{ instanceId: "i1", studentAnswer: "10" }], instances, malrules, 0)).toThrow();
    expect(() => diagnose([{ instanceId: "i1", studentAnswer: "10" }], instances, malrules, 1)).toThrow();
  });

  it("throws on an observation referencing an unknown instance id", () => {
    expect(() => diagnose([{ instanceId: "nope", studentAnswer: "10" }], instances, malrules, 0.1)).toThrow();
  });

  it("abstentionThreshold defaults to reproducing the original hardcoded behavior", () => {
    const withDefault = diagnose(
      [
        { instanceId: "i1", studentAnswer: "10" },
        { instanceId: "i2", studentAnswer: "22" },
      ],
      instances,
      malrules,
      0.1
    );
    const withExplicitOne = diagnose(
      [
        { instanceId: "i1", studentAnswer: "10" },
        { instanceId: "i2", studentAnswer: "22" },
      ],
      instances,
      malrules,
      0.1,
      1.0
    );
    expect(withExplicitOne.noPatternDetected).toBe(withDefault.noPatternDetected);
    expect(withExplicitOne.ranked).toEqual(withDefault.ranked);
  });

  it("raising abstentionThreshold can turn a previously-confident call into an abstention", () => {
    const obs = [
      { instanceId: "i1", studentAnswer: "10" },
      { instanceId: "i2", studentAnswer: "22" },
    ];
    const lenient = diagnose(obs, instances, malrules, 0.1, 1.0);
    expect(lenient.noPatternDetected).toBe(false); // rule_b matches both -- confident at the default
    const strict = diagnose(obs, instances, malrules, 0.1, 100);
    expect(strict.noPatternDetected).toBe(true); // same evidence, much higher bar -- now abstains
    // Threshold never changes the ranking itself, only whether we report abstention.
    expect(strict.ranked).toEqual(lenient.ranked);
  });

  it("lowering abstentionThreshold to 0 abstains only when there are zero matches", () => {
    const obs = [{ instanceId: "i1", studentAnswer: "99" }]; // matches nobody
    const result = diagnose(obs, instances, malrules, 0.1, 0);
    expect(result.noPatternDetected).toBe(true);
  });

  it("rejects a negative abstentionThreshold", () => {
    expect(() => diagnose([{ instanceId: "i1", studentAnswer: "10" }], instances, malrules, 0.1, -1)).toThrow();
  });
});

describe("diagnose -- alternative scoring methods (Experiment G)", () => {
  it("defaults to scoringMethod 'logLikelihood' with byte-identical output to specifying it explicitly", () => {
    const obs = [
      { instanceId: "i1", studentAnswer: "10" },
      { instanceId: "i2", studentAnswer: "22" },
    ];
    const implicit = diagnose(obs, instances, malrules, 0.1);
    const explicit = diagnose(obs, instances, malrules, 0.1, DEFAULT_ABSTENTION_THRESHOLD, "logLikelihood");
    expect(explicit).toEqual(implicit);
  });

  // ruleA is applicable to (and matches on) 2 instances; ruleB is applicable
  // to (and matches on) only 1. Under the default per-observation product,
  // ruleB's single confident match outscores ruleA's two (fewer factors,
  // each < 1, beats more of them) -- a real, non-obvious property of the
  // log-likelihood model. naiveExactMatch, which only ever counts matches,
  // must reverse that ranking.
  const scoringMalrules: MalruleMeta[] = [
    { id: "x.ruleA", category: "x", name: "A", description: "" },
    { id: "x.ruleB", category: "x", name: "B", description: "" },
  ];
  const scoringInstances: ProblemInstance[] = [
    { instance_id: "jA", native_malrule_id: "x.ruleA", template: "t", problem_text: "a", operation: "op", correct_answer: "0", predictions: { "x.ruleA": "5", "x.ruleB": "5" } },
    { instance_id: "jB", native_malrule_id: "x.ruleA", template: "t", problem_text: "b", operation: "op", correct_answer: "0", predictions: { "x.ruleA": "6" } },
  ];
  const scoringObs = [
    { instanceId: "jA", studentAnswer: "5" },
    { instanceId: "jB", studentAnswer: "6" },
  ];

  it("default logLikelihood scoring can rank fewer-but-perfect matches above more matches", () => {
    const result = diagnose(scoringObs, scoringInstances, scoringMalrules, 0.1, DEFAULT_ABSTENTION_THRESHOLD, "logLikelihood");
    expect(result.ranked[0]?.malruleId).toBe("x.ruleB"); // 1/1, beats ruleA's 2/2
  });

  it("naiveExactMatch ranks purely by match count, reversing that", () => {
    const result = diagnose(scoringObs, scoringInstances, scoringMalrules, 0.1, DEFAULT_ABSTENTION_THRESHOLD, "naiveExactMatch");
    expect(result.ranked[0]?.malruleId).toBe("x.ruleA"); // 2 matches > 1
    expect(result.ranked[0]?.logLikelihood).toBe(2); // naive score IS the raw match count
  });

  it("binomialLikelihood equals logLikelihood plus log(C(applicable, matches)) exactly", () => {
    const withPartialMismatch = diagnose(
      [
        { instanceId: "jA", studentAnswer: "5" }, // matches both
        { instanceId: "jB", studentAnswer: "6" }, // matches ruleA only (ruleB inapplicable here)
      ],
      scoringInstances,
      scoringMalrules,
      0.1,
      DEFAULT_ABSTENTION_THRESHOLD,
      "logLikelihood"
    );
    const binomial = diagnose(
      [
        { instanceId: "jA", studentAnswer: "5" },
        { instanceId: "jB", studentAnswer: "6" },
      ],
      scoringInstances,
      scoringMalrules,
      0.1,
      DEFAULT_ABSTENTION_THRESHOLD,
      "binomialLikelihood"
    );
    const ruleA_default = withPartialMismatch.ranked.find((r) => r.malruleId === "x.ruleA")!;
    const ruleA_binom = binomial.ranked.find((r) => r.malruleId === "x.ruleA")!;
    // ruleA: applicable=2, matches=2 -> log(C(2,2)) = log(1) = 0
    expect(ruleA_binom.logLikelihood - ruleA_default.logLikelihood).toBeCloseTo(Math.log(1), 10);
  });

  // ruleZ has three distinct templates in its own native instances; ruleA
  // has one. On an observation where both match identically (a genuine tie
  // under every other method), prevalencePrior must break the tie in favor
  // of the higher-template-count malrule -- and ruleZ sorts *after* ruleA
  // alphabetically, so a win for ruleZ can't be explained by the alphabetic
  // tie-break alone.
  const priorMalrules: MalruleMeta[] = [
    { id: "y.ruleA", category: "y", name: "A", description: "" },
    { id: "y.ruleZ", category: "y", name: "Z", description: "" },
  ];
  const priorInstances: ProblemInstance[] = [
    { instance_id: "k1", native_malrule_id: "y.ruleZ", template: "t1", problem_text: "k1", operation: "op", correct_answer: "0", predictions: { "y.ruleA": "5", "y.ruleZ": "5" } },
    { instance_id: "k2", native_malrule_id: "y.ruleZ", template: "t2", problem_text: "k2", operation: "op", correct_answer: "0", predictions: { "y.ruleZ": "9" } },
    { instance_id: "k3", native_malrule_id: "y.ruleZ", template: "t3", problem_text: "k3", operation: "op", correct_answer: "0", predictions: { "y.ruleZ": "9" } },
    { instance_id: "k4", native_malrule_id: "y.ruleA", template: "t1", problem_text: "k4", operation: "op", correct_answer: "0", predictions: { "y.ruleA": "9" } },
  ];

  it("logLikelihood/naiveExactMatch/binomialLikelihood tie on equal evidence (alphabetical tie-break picks ruleA)", () => {
    for (const method of ["logLikelihood", "naiveExactMatch", "binomialLikelihood"] as const) {
      const result = diagnose([{ instanceId: "k1", studentAnswer: "5" }], priorInstances, priorMalrules, 0.1, DEFAULT_ABSTENTION_THRESHOLD, method);
      expect(result.tiedTop.sort()).toEqual(["y.ruleA", "y.ruleZ"]);
      expect(result.ranked[0]?.malruleId).toBe("y.ruleA"); // alphabetical tie-break only
    }
  });

  it("prevalencePrior breaks that same tie in favor of the higher-template-count malrule, not alphabetically", () => {
    const result = diagnose(
      [{ instanceId: "k1", studentAnswer: "5" }],
      priorInstances,
      priorMalrules,
      0.1,
      DEFAULT_ABSTENTION_THRESHOLD,
      "prevalencePrior"
    );
    expect(result.tiedTop).toEqual(["y.ruleZ"]); // no longer tied
    expect(result.ranked[0]?.malruleId).toBe("y.ruleZ"); // 3 templates outweighs 1, against alphabetical order
  });
});
