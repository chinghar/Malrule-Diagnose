// Phase 3 -- typed record extraction and wrongness derivation for the
// FoundationalASSIST files.
//
// THE TRAP (documented, and load-bearing for this whole module): discrete_score
// is 0 whenever a student requested a hint or saw the answer, EVEN IF their
// submitted answer (answer_text) was correct. "Students can input the
// correct answer on their first try, and still be incorrect [in
// discrete_score], if they requested a hint or requested to see the
// answer." (arXiv:2602.00070). So `discrete_score == 0` does NOT mean
// answer_text was wrong -- this module never reads discrete_score for that
// purpose. Wrongness is derived ONLY by comparing answer_text against the
// correct answer read from the linked Problems record.
//
// answer_text is documented as the student's FIRST answer; there is no
// attempt-sequence field. Each Interactions row is therefore already
// exactly one (student, problem) observation -- this module does not, and
// must not, attempt to group or order multiple "attempts" per problem; the
// only meaningful ordering across rows is BETWEEN different problems for
// the same student (via end_time), which Phase 2's predictive-check metric
// uses.

import { parseCsvString, rowsToRecords } from "./csv.mts";
import { validateOrThrow, INTERACTIONS_SCHEMA, PROBLEMS_SCHEMA, SKILLS_SCHEMA } from "./schema.mts";

export interface InteractionRecord {
  problemId: string;
  hintCount: number;
  answerText: string;
  sawAnswer: boolean;
  discreteScore: number; // parsed and exposed for completeness/bookkeeping only -- NEVER used to derive wrongness, see module doc comment
  endTime: string;
  userXid: string;
}

export type AnswerTypeKind = "fill_in" | "multiple_choice" | "unsupported";

const FILL_IN_ANSWER_TYPES = new Set(["Numeric", "Exact Match", "Exact Fraction", "Numeric Expression", "Algebraic Expression"]);
const MULTIPLE_CHOICE_ANSWER_TYPES = new Set(["Multiple Choice", "Check All That Apply", "Dropdown"]);

export interface ProblemRecord {
  problemId: string;
  problemSetId: string;
  problemPart: string;
  problemType: string;
  answerType: string;
  problemBody: string;
  fillInOptionsRaw: string;
  fillInAnswersRaw: string;
  multipleChoiceOptionsRaw: string;
  multipleChoiceAnswersRaw: string;
}

export interface SkillRecord {
  problemId: string;
  skillId: string;
  nodeCode: string;
  nodeName: string;
}

export function parseInteractionsCsv(text: string): InteractionRecord[] {
  const { header, records } = rowsToRecords(parseCsvString(text));
  validateOrThrow(INTERACTIONS_SCHEMA, header);
  return records.map((r) => ({
    problemId: r.problem_id!,
    hintCount: Number(r.hint_count),
    answerText: r.answer_text!,
    sawAnswer: r.saw_answer === "True" || r.saw_answer === "true" || r.saw_answer === "1",
    discreteScore: Number(r.discrete_score),
    endTime: r.end_time!,
    userXid: r.user_xid!,
  }));
}

export function parseProblemsCsv(text: string): ProblemRecord[] {
  const { header, records } = rowsToRecords(parseCsvString(text));
  validateOrThrow(PROBLEMS_SCHEMA, header);
  return records.map((r) => ({
    problemId: r.problem_id!,
    problemSetId: r.problem_set_id!,
    problemPart: r.problem_part!,
    problemType: r.problem_type!,
    answerType: r.answer_type!,
    problemBody: r.problem_body!,
    fillInOptionsRaw: r.fill_in_options!,
    fillInAnswersRaw: r.fill_in_answers!,
    multipleChoiceOptionsRaw: r.multiple_choice_options!,
    multipleChoiceAnswersRaw: r.multiple_choice_answers!,
  }));
}

export function parseSkillsCsv(text: string): SkillRecord[] {
  const { header, records } = rowsToRecords(parseCsvString(text));
  validateOrThrow(SKILLS_SCHEMA, header);
  return records.map((r) => ({
    problemId: r.problem_id!,
    skillId: r.skill_id!,
    nodeCode: r.node_code!,
    nodeName: r.node_name!,
  }));
}

/**
 * Best-effort parse of a serialized answer-list field. The exact
 * serialization format is NOT precisely documented (see schema.mts's
 * header comment) -- this tries, in order: a JSON array, a Python-list
 * literal (single-quoted strings, e.g. "['a', 'b']"), then falls back to
 * treating the whole raw value as one scalar answer. Returns null (never a
 * guessed partial parse) when the value is empty or looks like a list
 * syntax that didn't fully parse, so callers can skip rather than trust an
 * ambiguous result.
 */
export function parseAnswerList(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const asJson = JSON.parse(trimmed);
      if (Array.isArray(asJson)) return asJson.length > 0 ? asJson.map((v) => String(v)) : null;
    } catch {
      // Not valid JSON; try a Python-list-literal reading (single quotes, no strict JSON quoting).
    }
    const pythonLiteralMatch = trimmed.slice(1, -1);
    const items = pythonLiteralMatch
      .split(",")
      .map((s) => s.trim())
      .map((s) => (s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')) ? s.slice(1, -1) : s)
      .filter((s) => s.length > 0);
    if (items.length > 0) return items;
    return null; // looked like a list but nothing usable came out -- do not guess
  }

  return [trimmed]; // a bare scalar value, not list-syntax
}

export function classifyAnswerType(answerType: string): AnswerTypeKind {
  if (FILL_IN_ANSWER_TYPES.has(answerType)) return "fill_in";
  if (MULTIPLE_CHOICE_ANSWER_TYPES.has(answerType)) return "multiple_choice";
  return "unsupported"; // e.g. "Ordering" -- ground-truth field is not confidently documented; never guessed
}

export interface WrongnessCheckResult {
  isWrong: boolean | null; // null when the answer type is unsupported or the correct-answer field couldn't be parsed -- never guessed
  reason?: string;
}

/**
 * Derives whether `answerText` was wrong for `problem`, comparing ONLY
 * against the correct answer read from the Problems record -- never
 * discrete_score (see module doc comment for why).
 */
export function checkWrongness(answerText: string, problem: ProblemRecord): WrongnessCheckResult {
  const kind = classifyAnswerType(problem.answerType);
  if (kind === "unsupported") {
    return { isWrong: null, reason: `unsupported answer_type "${problem.answerType}"` };
  }

  const correctRaw = kind === "fill_in" ? problem.fillInAnswersRaw : problem.multipleChoiceAnswersRaw;
  const correctAnswers = parseAnswerList(correctRaw);
  if (correctAnswers === null) {
    return { isWrong: null, reason: `could not parse the correct-answer field for answer_type "${problem.answerType}"` };
  }

  return { isWrong: !correctAnswers.includes(answerText) };
}
