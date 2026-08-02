// Safe, hand-written evaluator for the tiny predicate language used by
// VariantRequirement's requires/avoidIf strings — deliberately NOT
// eval/new Function (see select.ts's header comment for why). Supports
// exactly three shapes, evaluated against a ProjectPageSummary:
//   "<dot.path>.length > N"
//   "<dot.path>.length === 0"
//   "<dot.path>"                (plain truthiness)
import type { ProjectPageSummary } from './summaryType';

function getAtPath(root: unknown, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, root);
}

const LENGTH_GT = /^(.+)\.length\s*>\s*(\d+)$/;
const LENGTH_EQ_ZERO = /^(.+)\.length\s*===\s*0$/;

export function evaluatePredicate(expr: string, summary: ProjectPageSummary): boolean {
  const gt = LENGTH_GT.exec(expr);
  if (gt) {
    const value = getAtPath(summary, gt[1]);
    const n = Number(gt[2]);
    return Array.isArray(value) ? value.length > n : false;
  }

  const eqZero = LENGTH_EQ_ZERO.exec(expr);
  if (eqZero) {
    const value = getAtPath(summary, eqZero[1]);
    // A missing/non-array path is not the same claim as "this array is
    // empty" — treat it as unsatisfied rather than silently matching, so a
    // typo'd dot-path fails loudly instead of always satisfying the check.
    return Array.isArray(value) ? value.length === 0 : false;
  }

  // Plain dot-path truthiness. Special-case arrays so `requires: ['quotes']`
  // means the same thing as `requires: ['quotes.length > 0']` — JS's
  // `Boolean([])` is `true`, which would otherwise silently defeat the
  // "needs at least one" intent this predicate language exists for.
  const value = getAtPath(summary, expr);
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

export function requirementsSatisfied(requires: string[], summary: ProjectPageSummary): boolean {
  return requires.every((expr) => evaluatePredicate(expr, summary));
}

export function anyAvoided(avoidIf: string[], summary: ProjectPageSummary): boolean {
  return avoidIf.some((expr) => evaluatePredicate(expr, summary));
}

// requires/avoidIf keyed by `${lensId}.${slotId}.${variantId}`, formalizing
// each variant's existing prose `note` — see library/*.tsx for the source
// notes this was derived from. Only variants whose note text implies an
// actual, checkable ProjectPageSummary condition get an entry here; a note
// with no such qualifier (the overwhelming majority) means "always
// eligible," which is the default when a key is absent from this map.
//
// 'marketing.proof.quote' ("A single voice. Needs a real quote.") and
// 'marketing.proof.stats' ("Ruled cells. Use when numbers are concrete.")
// are the only two notes in the library that name a condition checkable
// against the summary schema — quotes[] and stats[] respectively.
// 'marketing.hero.split' ("Needs a strong screenshot.") is intentionally NOT
// encoded here: ProjectPageSummary has no screenshot/shot field (screenshot
// capture is explicitly out of scope per PRD 929's "Out of scope" section),
// so there is nothing in the summary to check that requirement against
// without inventing a field.
export const VARIANT_REQUIREMENTS: Record<string, { requires?: string[]; avoidIf?: string[] }> = {
  'marketing.proof.quote': { requires: ['quotes.length > 0'] },
  'marketing.proof.stats': { requires: ['stats.length > 0'] },
};

export function requirementsFor(lensId: string, slotId: string, variantId: string): { requires: string[]; avoidIf: string[] } {
  const key = `${lensId}.${slotId}.${variantId}`;
  const entry = VARIANT_REQUIREMENTS[key];
  return { requires: entry?.requires ?? [], avoidIf: entry?.avoidIf ?? [] };
}
