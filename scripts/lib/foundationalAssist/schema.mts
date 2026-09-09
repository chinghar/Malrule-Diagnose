// Phase 3 -- the documented FoundationalASSIST schema, sourced from the
// published documentation (not guessed, and not read off real files, which
// are not on disk this session): the HuggingFace dataset card at
// https://huggingface.co/datasets/ASSISTments/FoundationalASSIST (fetched
// 2026-09-08), cross-checked against the dataset paper
// (arXiv:2602.00070, "FoundationalASSIST: An Educational Dataset for
// Foundational Knowledge Tracing and Pedagogical Grounding of LLMs"), whose
// prose description of each file's fields matches the card's column list.
//
// Two things the documentation does NOT specify precisely, flagged rather
// than guessed silently: the exact serialization format of
// `fill_in_answers` / `multiple_choice_answers` (JSON array? Python list
// literal? delimiter-separated string?), and the exact set of
// `answer_type` string values beyond the ones the card lists as examples.
// loader.mts's correctness-derivation logic is written defensively against
// this uncertainty (tries several plausible formats, and explicitly SKIPS
// -- never guesses -- rows it can't confidently parse; see loader.mts).
// This will need to be checked against the real files once access clears
// (Phase 5).

export interface SchemaDefinition {
  fileLabel: string;
  /** Every column the documentation says this file has. Order is not asserted -- only presence. */
  requiredColumns: string[];
}

export const INTERACTIONS_SCHEMA: SchemaDefinition = {
  fileLabel: "Interactions",
  requiredColumns: ["problem_id", "hint_count", "answer_text", "saw_answer", "discrete_score", "end_time", "user_xid"],
};

export const PROBLEMS_SCHEMA: SchemaDefinition = {
  fileLabel: "Problems",
  requiredColumns: [
    "problem_id",
    "problem_set_id",
    "problem_part",
    "problem_type",
    "answer_type",
    "problem_body",
    "fill_in_options",
    "fill_in_answers",
    "multiple_choice_options",
    "multiple_choice_answers",
  ],
};

export const SKILLS_SCHEMA: SchemaDefinition = {
  fileLabel: "Skills",
  requiredColumns: ["problem_id", "skill_id", "node_code", "node_name"],
};

export interface SchemaValidationResult {
  ok: boolean;
  fileLabel: string;
  missingColumns: string[];
  unexpectedColumns: string[];
}

/** Compares a real file's header row against a SchemaDefinition. Never throws itself -- callers decide whether to fail loudly (see validateOrThrow below). */
export function validateSchema(schema: SchemaDefinition, actualHeader: string[]): SchemaValidationResult {
  const actualSet = new Set(actualHeader);
  const expectedSet = new Set(schema.requiredColumns);
  const missingColumns = schema.requiredColumns.filter((c) => !actualSet.has(c));
  const unexpectedColumns = actualHeader.filter((c) => !expectedSet.has(c));
  return { ok: missingColumns.length === 0, fileLabel: schema.fileLabel, missingColumns, unexpectedColumns };
}

function formatDiff(result: SchemaValidationResult): string {
  const lines = [`Schema mismatch for ${result.fileLabel}:`];
  if (result.missingColumns.length > 0) {
    lines.push(`  MISSING (documented, not present in the file): ${result.missingColumns.join(", ")}`);
  }
  if (result.unexpectedColumns.length > 0) {
    lines.push(`  UNEXPECTED (present in the file, not in the documented schema): ${result.unexpectedColumns.join(", ")}`);
  }
  lines.push(
    "  The documented schema may be stale, or this may not be the file it claims to be. Refusing to proceed rather than guess a column mapping."
  );
  return lines.join("\n");
}

/** Fails loudly -- throws with a clear diff -- when the real header doesn't match the documented schema. Missing columns always fail; unexpected extra columns also fail (a genuinely stale schema definition should be updated deliberately, not silently tolerated). */
export function validateOrThrow(schema: SchemaDefinition, actualHeader: string[]): void {
  const result = validateSchema(schema, actualHeader);
  if (!result.ok || result.unexpectedColumns.length > 0) {
    throw new Error(formatDiff(result));
  }
}
