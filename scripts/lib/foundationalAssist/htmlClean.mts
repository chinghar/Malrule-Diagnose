// Phase 4 -- HTML/MathML to plain-text cleaning for `problem_body`.
//
// The dataset documentation says it ships `clean_utils.py`/`cleantext.py`
// for this, but those files live under the gated `Code/` directory, which
// this session's access request does not yet cover (checked: the
// repository's file tree is visible, but `Code/` contents require the same
// gate as the data). This is therefore an independent implementation, not
// a port of the dataset's own cleaner -- it should be reconciled against
// the real clean_utils.py once access clears (Phase 5), and may diverge
// from it on cases neither the HF card nor the paper documents precisely.
//
// No dependency added: HTML/MathML stripping here is bounded (a small,
// enumerated set of tags/entities relevant to elementary arithmetic
// problem text), not general-purpose HTML5 parsing, so a regex-based
// approach is appropriate and testable rather than under-engineered.

const BLOCK_BOUNDARY_TAGS = /<\/(p|div|li|tr|td|th|br)\s*>|<br\s*\/?>/gi;

const MATHML_FRACTION = /<mfrac>\s*<mn>([^<]*)<\/mn>\s*<mn>([^<]*)<\/mn>\s*<\/mfrac>/gi;
const MATHML_SUPERSCRIPT = /<msup>\s*<mn>([^<]*)<\/mn>\s*<mn>([^<]*)<\/mn>\s*<\/msup>/gi;
const MATHML_MINUS_ENTITY = /&#x2212;|&minus;/gi;
const MATHML_TIMES_ENTITY = /&#xD7;|&times;/gi;
const MATHML_DIVIDE_ENTITY = /&#xF7;|&divide;/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * Converts HTML/MathML-bearing problem_body text into a plain-text string
 * suitable for the operand/operation parser below. MathML fractions and
 * exponents are converted to their linear-text equivalent ("3/4", "2^3")
 * BEFORE generic tag stripping removes the structure that makes that
 * possible; everything else is stripped.
 */
export function cleanProblemBody(html: string): string {
  let text = html;
  text = text.replace(MATHML_FRACTION, (_, num, den) => `${num}/${den}`);
  text = text.replace(MATHML_SUPERSCRIPT, (_, base, exp) => `${base}^${exp}`);
  text = text.replace(MATHML_MINUS_ENTITY, "-");
  text = text.replace(MATHML_TIMES_ENTITY, "×");
  text = text.replace(MATHML_DIVIDE_ENTITY, "÷");
  text = text.replace(BLOCK_BOUNDARY_TAGS, " ");
  text = text.replace(/<[^>]+>/g, " "); // strip all remaining tags
  text = decodeEntities(text);
  text = text.replace(/\s+/g, " ").trim();
  return text;
}
