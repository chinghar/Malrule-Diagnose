import { describe, expect, it } from "vitest";
import {
  parseInteractionsCsv,
  parseProblemsCsv,
  parseSkillsCsv,
  parseAnswerList,
  classifyAnswerType,
  checkWrongness,
  type ProblemRecord,
} from "./loader.mts";

const INTERACTIONS_HEADER = "problem_id,hint_count,answer_text,saw_answer,discrete_score,end_time,user_xid\n";
const PROBLEMS_HEADER =
  "problem_id,problem_set_id,problem_part,problem_type,answer_type,problem_body,fill_in_options,fill_in_answers,multiple_choice_options,multiple_choice_answers\n";
const SKILLS_HEADER = "problem_id,skill_id,node_code,node_name\n";

function fillInProblem(overrides: Partial<ProblemRecord> = {}): ProblemRecord {
  return {
    problemId: "p1",
    problemSetId: "ps1",
    problemPart: "1",
    problemType: "fill-in-the-blank",
    answerType: "Numeric",
    problemBody: "<p>2+2</p>",
    fillInOptionsRaw: "",
    fillInAnswersRaw: "[4]",
    multipleChoiceOptionsRaw: "",
    multipleChoiceAnswersRaw: "",
    ...overrides,
  };
}

describe("parseInteractionsCsv", () => {
  it("parses a well-formed row", () => {
    const csv = INTERACTIONS_HEADER + "p1,2,4,False,1,2024-01-01T00:00:00Z,student-abc\n";
    const rows = parseInteractionsCsv(csv);
    expect(rows).toEqual([
      { problemId: "p1", hintCount: 2, answerText: "4", sawAnswer: false, discreteScore: 1, endTime: "2024-01-01T00:00:00Z", userXid: "student-abc" },
    ]);
  });

  it("throws loudly when the header doesn't match the documented schema", () => {
    const csv = "problem_id,answer_text\np1,4\n";
    expect(() => parseInteractionsCsv(csv)).toThrow(/Schema mismatch/);
  });
});

describe("parseProblemsCsv / parseSkillsCsv", () => {
  it("parses a well-formed Problems row, including HTML with embedded commas in problem_body", () => {
    const csv = PROBLEMS_HEADER + 'p1,ps1,1,fill-in,Numeric,"<p>Compute 3, 4, and 5</p>",,[4],,\n';
    const rows = parseProblemsCsv(csv);
    expect(rows[0]!.problemBody).toBe("<p>Compute 3, 4, and 5</p>");
    expect(rows[0]!.fillInAnswersRaw).toBe("[4]");
  });

  it("parses a well-formed Skills row", () => {
    const csv = SKILLS_HEADER + "p1,s1,6.NS.C.6,Identify Opposites of Integers\n";
    expect(parseSkillsCsv(csv)).toEqual([{ problemId: "p1", skillId: "s1", nodeCode: "6.NS.C.6", nodeName: "Identify Opposites of Integers" }]);
  });
});

describe("parseAnswerList", () => {
  it("parses a JSON array", () => {
    expect(parseAnswerList('["4", "four"]')).toEqual(["4", "four"]);
  });

  it("parses a Python-list literal with single-quoted strings", () => {
    expect(parseAnswerList("['4', 'four']")).toEqual(["4", "four"]);
  });

  it("parses a bare scalar (no list syntax) as a single-element answer", () => {
    expect(parseAnswerList("4")).toEqual(["4"]);
  });

  it("returns null for an empty field", () => {
    expect(parseAnswerList("")).toBeNull();
    expect(parseAnswerList("   ")).toBeNull();
  });

  it("returns null rather than guessing for list-syntax that parses to nothing usable", () => {
    expect(parseAnswerList("[]")).toBeNull();
  });
});

describe("classifyAnswerType", () => {
  it("classifies documented fill-in types", () => {
    expect(classifyAnswerType("Numeric")).toBe("fill_in");
    expect(classifyAnswerType("Exact Fraction")).toBe("fill_in");
    expect(classifyAnswerType("Algebraic Expression")).toBe("fill_in");
  });

  it("classifies documented multiple-choice types", () => {
    expect(classifyAnswerType("Multiple Choice")).toBe("multiple_choice");
    expect(classifyAnswerType("Check All That Apply")).toBe("multiple_choice");
  });

  it("classifies an undocumented/ambiguous type (e.g. Ordering) as unsupported rather than guessing", () => {
    expect(classifyAnswerType("Ordering")).toBe("unsupported");
  });
});

describe("checkWrongness", () => {
  it("correctly identifies a wrong fill-in answer", () => {
    const problem = fillInProblem({ fillInAnswersRaw: "[4]" });
    expect(checkWrongness("5", problem)).toEqual({ isWrong: true });
  });

  it("correctly identifies a correct fill-in answer", () => {
    const problem = fillInProblem({ fillInAnswersRaw: "[4]" });
    expect(checkWrongness("4", problem)).toEqual({ isWrong: false });
  });

  it("correctly identifies a correct multiple-choice answer", () => {
    const problem = fillInProblem({ answerType: "Multiple Choice", multipleChoiceAnswersRaw: "['B']" });
    expect(checkWrongness("B", problem)).toEqual({ isWrong: false });
  });

  it("returns isWrong: null (never a guess) for an unsupported answer_type", () => {
    const problem = fillInProblem({ answerType: "Ordering" });
    const result = checkWrongness("A,B,C", problem);
    expect(result.isWrong).toBeNull();
    expect(result.reason).toMatch(/unsupported/);
  });

  it("returns isWrong: null when the correct-answer field is empty/unparseable, never guessing", () => {
    const problem = fillInProblem({ fillInAnswersRaw: "" });
    const result = checkWrongness("4", problem);
    expect(result.isWrong).toBeNull();
  });

  // ---------------------------------------------------------------------
  // THE required trap test: discrete_score must never be used to derive
  // wrongness, because it can be 0 even when answer_text was correct (a
  // hint or answer-reveal happened). Construct exactly that case and
  // confirm checkWrongness -- which never reads discrete_score at all --
  // still correctly reports isWrong: false.
  // ---------------------------------------------------------------------
  it("does NOT treat discrete_score == 0 as evidence of a wrong answer (the documented trap)", () => {
    const interactionsCsv =
      INTERACTIONS_HEADER +
      // discrete_score is 0 (the student requested a hint), but answer_text
      // ("4") is in fact the documented correct answer for this problem.
      "p1,1,4,False,0,2024-01-01T00:00:00Z,student-abc\n";
    const interaction = parseInteractionsCsv(interactionsCsv)[0]!;
    expect(interaction.discreteScore).toBe(0); // sanity: this row IS the trap case

    const problem = fillInProblem({ fillInAnswersRaw: "[4]" });
    const result = checkWrongness(interaction.answerText, problem);

    // The correctness derivation must go by answer_text vs. the Problems
    // file's correct answer, not by discreteScore -- so a discreteScore of
    // 0 here must NOT make isWrong true.
    expect(result.isWrong).toBe(false);
  });

  it("conversely, a genuinely wrong answer_text is flagged wrong regardless of discreteScore's value", () => {
    const interactionsCsv = INTERACTIONS_HEADER + "p1,0,7,False,0,2024-01-01T00:00:00Z,student-abc\n";
    const interaction = parseInteractionsCsv(interactionsCsv)[0]!;
    const problem = fillInProblem({ fillInAnswersRaw: "[4]" });
    expect(checkWrongness(interaction.answerText, problem).isWrong).toBe(true);
  });
});
