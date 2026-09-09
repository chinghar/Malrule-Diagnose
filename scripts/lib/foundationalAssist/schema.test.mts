import { describe, expect, it } from "vitest";
import { validateSchema, validateOrThrow, INTERACTIONS_SCHEMA, PROBLEMS_SCHEMA, SKILLS_SCHEMA } from "./schema.mts";

describe("validateSchema / validateOrThrow", () => {
  it("passes when the header exactly matches the documented Interactions schema", () => {
    const result = validateSchema(INTERACTIONS_SCHEMA, ["problem_id", "hint_count", "answer_text", "saw_answer", "discrete_score", "end_time", "user_xid"]);
    expect(result.ok).toBe(true);
    expect(result.missingColumns).toEqual([]);
    expect(result.unexpectedColumns).toEqual([]);
    expect(() => validateOrThrow(INTERACTIONS_SCHEMA, ["problem_id", "hint_count", "answer_text", "saw_answer", "discrete_score", "end_time", "user_xid"])).not.toThrow();
  });

  it("passes regardless of column order", () => {
    const result = validateSchema(SKILLS_SCHEMA, ["node_name", "problem_id", "node_code", "skill_id"]);
    expect(result.ok).toBe(true);
  });

  it("FAILS LOUDLY on a deliberately malformed fixture missing a documented column (the discrete_score trap's own column, for instance)", () => {
    // A plausible real-world malformation: someone re-exports the file and
    // drops discrete_score, which is exactly the column this project's
    // wrongness-derivation logic must NOT rely on anyway -- but the
    // validator must still catch its absence rather than silently
    // proceeding with a different file shape than documented.
    const malformedHeader = ["problem_id", "hint_count", "answer_text", "saw_answer", "end_time", "user_xid"];
    const result = validateSchema(INTERACTIONS_SCHEMA, malformedHeader);
    expect(result.ok).toBe(false);
    expect(result.missingColumns).toEqual(["discrete_score"]);
    expect(() => validateOrThrow(INTERACTIONS_SCHEMA, malformedHeader)).toThrow(/MISSING/);
    expect(() => validateOrThrow(INTERACTIONS_SCHEMA, malformedHeader)).toThrow(/discrete_score/);
  });

  it("fails loudly when the file has extra, undocumented columns", () => {
    const withExtra = [...PROBLEMS_SCHEMA.requiredColumns, "internal_review_flag"];
    const result = validateSchema(PROBLEMS_SCHEMA, withExtra);
    expect(result.ok).toBe(true); // no MISSING columns
    expect(result.unexpectedColumns).toEqual(["internal_review_flag"]);
    expect(() => validateOrThrow(PROBLEMS_SCHEMA, withExtra)).toThrow(/UNEXPECTED/);
  });

  it("fails loudly and clearly when the file is a completely different shape (e.g. someone points the loader at the wrong file)", () => {
    const wrongFile = ["completely", "unrelated", "columns"];
    expect(() => validateOrThrow(INTERACTIONS_SCHEMA, wrongFile)).toThrow(/Schema mismatch for Interactions/);
  });

  it("the error message names every missing column, not just the first", () => {
    const almostEmpty = ["problem_id"];
    let message = "";
    try {
      validateOrThrow(SKILLS_SCHEMA, almostEmpty);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("skill_id");
    expect(message).toContain("node_code");
    expect(message).toContain("node_name");
  });
});
