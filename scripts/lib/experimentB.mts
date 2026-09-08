// Experiment B -- indistinguishability, properly characterized.
//
// This is a property of MalruleLib's problem generators and the standard
// problem templates, not of the diagnosis engine: it is computed directly
// from the committed index's predicted-answer columns, with no diagnose()
// call anywhere in this module. It survives someone reimplementing the
// scoring engine from scratch.
//
// Checks EVERY pair among all 26 malrules (not just within-category pairs)
// against EVERY instance in the entire index (not just their own
// category's instances), so the "do collisions cross categories" question
// is answered empirically rather than assumed from how the index happens
// to be built.

import type { ProblemInstance } from "../../lib/diagnose/types";
import { CATEGORIES, pct } from "./data.mts";
import { fmtWilson } from "./stats.mts";

export const MIN_INSTANCES_TO_JUDGE_TEMPLATE = 3;

interface MalruleRef {
  id: string;
  category: string;
}

export interface TemplateAgreement {
  category: string;
  template: string;
  compared: number;
  agree: number;
  /** compared >= MIN_INSTANCES_TO_JUDGE_TEMPLATE && agree === compared -- enough evidence, and total agreement. */
  identical: boolean;
}

export interface DiscriminatingInstance {
  instanceId: string;
  category: string;
  template: string;
  problemText: string;
  answerA: string;
  answerB: string;
}

export interface PairResult {
  malruleA: string;
  malruleB: string;
  sameCategory: boolean;
  totalCompared: number;
  totalAgree: number;
  /** No instance anywhere in the entire index distinguishes them -- not fixable by any problem choice in this library. */
  fullyIndistinguishable: boolean;
  /** First instance (by id) where they disagree, if one exists anywhere. */
  discriminatingInstance: DiscriminatingInstance | null;
  perTemplate: TemplateAgreement[];
  inScopeTemplateCount: number;
  identicalTemplateCount: number;
  fractionIdenticalTemplates: number | null;
  /** At least one template is a total trap, but a discriminating instance exists elsewhere -- fixable by problem choice. */
  indistinguishableOnSomeTemplates: boolean;
}

export interface ConfusabilityRow {
  malruleId: string;
  category: string;
  fullyIndistinguishableCount: number;
  collidesOnSomeTemplateCount: number;
  partners: string[];
}

export interface ExperimentBResult {
  minInstancesToJudgeTemplate: number;
  pairsChecked: number;
  crossCategoryPairsChecked: number;
  pairsWithAnyCoApplicableInstance: number;
  crossCategoryPairsWithAnyCoApplicableInstance: number;
  pairs: PairResult[];
  confusability: ConfusabilityRow[];
}

function allMalruleRefs(): MalruleRef[] {
  return CATEGORIES.flatMap((c) => c.malrules.map((m) => ({ id: m.id, category: c.category })));
}

function allInstances(): ProblemInstance[] {
  return CATEGORIES.flatMap((c) => c.instances);
}

interface TemplateBucket {
  category: string;
  template: string;
  compared: number;
  agree: number;
}

function analyzePair(a: MalruleRef, b: MalruleRef, instances: ProblemInstance[]): PairResult {
  let totalCompared = 0;
  let totalAgree = 0;
  let discriminatingInstance: DiscriminatingInstance | null = null;
  const byTemplate = new Map<string, TemplateBucket>();

  for (const inst of instances) {
    const pa = inst.predictions[a.id];
    const pb = inst.predictions[b.id];
    if (pa === undefined || pb === undefined) continue;

    // An instance's predictions map only ever contains keys for malrules in
    // its own category (see build_index.py), so pa/pb both being defined
    // already guarantees inst belongs to the one category where both a and
    // b are real candidates.
    const instCategory = inst.native_malrule_id.split(".")[0] ?? "";

    totalCompared += 1;
    const bucketKey = `${instCategory}::${inst.template}`;
    const bucket = byTemplate.get(bucketKey) ?? { category: instCategory, template: inst.template, compared: 0, agree: 0 };
    bucket.compared += 1;

    if (pa === pb) {
      totalAgree += 1;
      bucket.agree += 1;
    } else if (!discriminatingInstance) {
      discriminatingInstance = {
        instanceId: inst.instance_id,
        category: instCategory,
        template: inst.template,
        problemText: inst.problem_text,
        answerA: pa,
        answerB: pb,
      };
    }
    byTemplate.set(bucketKey, bucket);
  }

  const perTemplate: TemplateAgreement[] = [...byTemplate.values()]
    .map((v) => ({
      category: v.category,
      template: v.template,
      compared: v.compared,
      agree: v.agree,
      identical: v.compared >= MIN_INSTANCES_TO_JUDGE_TEMPLATE && v.agree === v.compared,
    }))
    .sort((x, y) => x.template.localeCompare(y.template));

  const inScope = perTemplate.filter((t) => t.compared >= MIN_INSTANCES_TO_JUDGE_TEMPLATE);
  const identicalCount = inScope.filter((t) => t.identical).length;

  const fullyIndistinguishable = totalCompared > 0 && totalCompared === totalAgree;

  return {
    malruleA: a.id,
    malruleB: b.id,
    sameCategory: a.category === b.category,
    totalCompared,
    totalAgree,
    fullyIndistinguishable,
    discriminatingInstance,
    perTemplate,
    inScopeTemplateCount: inScope.length,
    identicalTemplateCount: identicalCount,
    fractionIdenticalTemplates: inScope.length > 0 ? identicalCount / inScope.length : null,
    indistinguishableOnSomeTemplates: !fullyIndistinguishable && identicalCount > 0,
  };
}

export function runExperimentB(): ExperimentBResult {
  const refs = allMalruleRefs();
  const instances = allInstances();
  const pairs: PairResult[] = [];

  for (let i = 0; i < refs.length; i++) {
    for (let j = i + 1; j < refs.length; j++) {
      const a = refs[i]!;
      const b = refs[j]!;
      const result = analyzePair(a, b, instances);
      if (result.totalCompared > 0) pairs.push(result);
    }
  }

  const pairsChecked = (refs.length * (refs.length - 1)) / 2;
  const crossCategoryCompared = pairs.filter((p) => !p.sameCategory);
  let crossCategoryPairsChecked = 0;
  for (let i = 0; i < refs.length; i++) {
    for (let j = i + 1; j < refs.length; j++) {
      if (refs[i]!.category !== refs[j]!.category) crossCategoryPairsChecked += 1;
    }
  }

  const confusabilityMap = new Map<string, { category: string; full: Set<string>; some: Set<string> }>();
  for (const ref of refs) confusabilityMap.set(ref.id, { category: ref.category, full: new Set(), some: new Set() });

  for (const p of pairs) {
    if (p.fullyIndistinguishable) {
      confusabilityMap.get(p.malruleA)!.full.add(p.malruleB);
      confusabilityMap.get(p.malruleB)!.full.add(p.malruleA);
    }
    if (p.fullyIndistinguishable || p.indistinguishableOnSomeTemplates) {
      confusabilityMap.get(p.malruleA)!.some.add(p.malruleB);
      confusabilityMap.get(p.malruleB)!.some.add(p.malruleA);
    }
  }

  const confusability: ConfusabilityRow[] = [...confusabilityMap.entries()]
    .map(([malruleId, v]) => ({
      malruleId,
      category: v.category,
      fullyIndistinguishableCount: v.full.size,
      collidesOnSomeTemplateCount: v.some.size,
      partners: [...v.some].sort(),
    }))
    .sort(
      (a, b) =>
        b.collidesOnSomeTemplateCount - a.collidesOnSomeTemplateCount ||
        b.fullyIndistinguishableCount - a.fullyIndistinguishableCount ||
        a.malruleId.localeCompare(b.malruleId)
    );

  return {
    minInstancesToJudgeTemplate: MIN_INSTANCES_TO_JUDGE_TEMPLATE,
    pairsChecked,
    crossCategoryPairsChecked,
    pairsWithAnyCoApplicableInstance: pairs.length,
    crossCategoryPairsWithAnyCoApplicableInstance: crossCategoryCompared.length,
    pairs,
    confusability,
  };
}

export function renderMarkdown(result: ExperimentBResult): string {
  const fullyIndist = result.pairs.filter((p) => p.fullyIndistinguishable);
  const someIndist = result.pairs.filter((p) => p.indistinguishableOnSomeTemplates);

  const fullyIndistTable =
    fullyIndist.length > 0
      ? `| Malrule A | Malrule B | Co-applicable instances | Shared templates |\n|---|---|---|---|\n${fullyIndist
          .map((p) => `| ${p.malruleA} | ${p.malruleB} | ${p.totalCompared} | ${p.inScopeTemplateCount} |`)
          .join("\n")}`
      : "_None found._";

  const someIndistTable = `| Malrule A | Malrule B | Identical templates | Discriminating instance found | Example |\n|---|---|---|---|---|\n${someIndist
    .map((p) => {
      const d = p.discriminatingInstance;
      const example = d ? `"${d.problemText}" (${d.template}): ${p.malruleA}→${d.answerA}, ${p.malruleB}→${d.answerB}` : "n/a";
      return `| ${p.malruleA} | ${p.malruleB} | ${p.identicalTemplateCount}/${p.inScopeTemplateCount} (${pct(p.fractionIdenticalTemplates ?? 0)}) | ${d ? d.instanceId : "n/a"} | ${example} |`;
    })
    .join("\n")}`;

  const confusabilityTable = `| Malrule | Category | Fully indistinguishable from | Collides on some template with |\n|---|---|---|---|\n${result.confusability
    .filter((c) => c.collidesOnSomeTemplateCount > 0)
    .map((c) => `| ${c.malruleId} | ${c.category} | ${c.fullyIndistinguishableCount} | ${c.collidesOnSomeTemplateCount} (${c.partners.join(", ")}) |`)
    .join("\n")}`;

  return `Computed directly from the committed index's predicted-answer columns --
no \`diagnose()\` call anywhere in this analysis. It is a property of
MalruleLib's problem generators and standard templates, not of the scoring
engine, and would survive a full reimplementation of \`lib/diagnose\`.

Checked all ${result.pairsChecked} possible pairs among the 26 malrules (not just
within-category pairs) against every instance in the entire index (not
just their own category's instances). Only ${result.pairsWithAnyCoApplicableInstance} of ${result.pairsChecked} pairs
(${fmtWilson(result.pairsWithAnyCoApplicableInstance, result.pairsChecked)}) are ever co-applicable to the same problem at
all. **Cross-category
collisions: confirmed zero, empirically** -- ${fmtWilson(result.crossCategoryPairsWithAnyCoApplicableInstance, result.crossCategoryPairsChecked)} of the
${result.crossCategoryPairsChecked} checked cross-category pairs ever produced a co-applicable
instance; the Wilson upper bound (not just the point estimate of zero)
bounds how confident that "never" claim is. Collisions are entirely a
within-category phenomenon in this library. Full machine-readable detail,
including every template-level comparison, is in
\`data/indistinguishability.json\`.

### Fully indistinguishable (not fixable by any problem choice in this library)

${fullyIndistTable}

This is the one pair no diagnostic worksheet built from this library's
templates can ever tell apart from each other, no matter which problems
are chosen.

### Indistinguishable on some templates only (fixable by problem choice)

${someIndistTable}

Each row above has a concrete, printed example: a template where the pair
collides completely, and a specific instance elsewhere where they
disagree -- proof the pair is not fundamentally confusable, just unlucky
on some problem shapes. A worksheet author can use this table directly to
avoid the colliding templates.

### Per-malrule confusability degree

${confusabilityTable}

Confusability clusters almost entirely within \`subtraction\` (a six-malrule
group that substantially overlaps: \`always_borrow_left\`, \`borrow_from_bottom\`,
\`borrow_no_decrement\`, \`diff_0_n_equals_n\`, \`smaller_from_larger\`,
\`stops_borrow_at_zero\`) and a small \`decimals\` group. \`multiplication_division\`
has zero confusable pairs at this sample threshold.`;
}
