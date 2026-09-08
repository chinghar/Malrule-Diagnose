// Shapes mirror the JSON emitted by scripts/build_index.py into data/index/.

export interface MalruleMeta {
  id: string;
  category: string;
  name: string;
  description: string;
}

export interface ProblemInstance {
  instance_id: string;
  native_malrule_id: string;
  template: string;
  problem_text: string;
  operation: string;
  correct_answer: string;
  // Keyed by malrule id. A malrule missing from this map was not applicable
  // to this instance's problem shape (its algorithm raised on it) -- that is
  // an abstention, not a wrong answer, and must not be scored as one.
  predictions: Record<string, string>;
}

export interface CategoryIndex {
  category: string;
  malrules: MalruleMeta[];
  instances: ProblemInstance[];
}

export interface Observation {
  instanceId: string;
  studentAnswer: string;
}

export interface MalruleScore {
  malruleId: string;
  /** Observations where this malrule's predicted answer matched the student's. */
  matches: number;
  /** Observations where this malrule's algorithm could run at all. */
  applicable: number;
  logLikelihood: number;
  /** Normalized posterior probability, relative to other applicable malrules only. */
  posterior: number;
}

export interface DiagnosisResult {
  /** Sorted descending by posterior; only malrules with applicable > 0. */
  ranked: MalruleScore[];
  /** Malrule ids whose logLikelihood ties the top score (within floating tolerance). */
  tiedTop: string[];
  /**
   * True when the leading malrule's match count does not exceed what a
   * uniform random guess would be expected to hit by coincidence, given the
   * distinct answers actually on record for the observed instances. When
   * true, ranked may still be non-empty -- it means nothing in it rises
   * above chance, not that nothing was computed.
   */
  noPatternDetected: boolean;
  /** Malrule ids that could not be evaluated on any observed instance. */
  untested: string[];
  slipRate: number;
  observedCount: number;
}
