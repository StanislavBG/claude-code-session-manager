// Stage 2 of the Project Pages pipeline: deterministic, non-LLM selection of
// one variant per slot per lens. Formalizes each variant's prose `note` into
// requires/avoidIf predicates (selectionPredicates.ts) instead of ad hoc
// judgment, so regenerating a project's pages doesn't reshuffle the layout
// on every run. Deliberately no eval/new Function anywhere in this file or
// selectionPredicates.ts — the predicate strings are developer-authored (not
// user input), but a small hand-written dot-path+comparator parser is the
// correct scope for this, not a general expression language reachable via
// code-eval.
import type { PageLensDef } from './library/types';
import type { ProjectPageSummary, ProjectPagePicks } from './summaryType';
import { requirementsFor, requirementsSatisfied, anyAvoided } from './selectionPredicates';

/**
 * Tie-break rule (the ONE deterministic rule this function uses): for each
 * slot, walk the lens's presets in their defined order (v1, v2, v3, ...) and
 * use the first preset whose pick for this slot is eligible (requires
 * satisfied, avoidIf not triggered). This is what lets a requirement-gated
 * variant (e.g. a quote-driven layout) actually win: it's some preset's
 * curated pick, and that preset is tried once v1's pick turns out
 * ineligible for this summary. If none of the presets' picks are eligible,
 * fall back to the first eligible variant in the slot's own defined order.
 * If NO variant in the slot is eligible at all, fall back to the preset v1
 * pick regardless of its own eligibility — a slot must never go unpicked.
 */
export function scoreVariants(lens: PageLensDef, summary: ProjectPageSummary): Record<string, string> {
  const result: Record<string, string> = {};

  for (const slot of lens.slots) {
    const isEligible = (variantId: string) => {
      const variant = slot.variants.find((v) => v.id === variantId);
      if (!variant) return false;
      const { requires, avoidIf } = requirementsFor(lens.id, slot.id, variant.id);
      return requirementsSatisfied(requires, summary) && !anyAvoided(avoidIf, summary);
    };

    const presetPick = lens.presets.map((preset) => preset.pick[slot.id]).find((pickId) => pickId != null && isEligible(pickId));

    if (presetPick != null) {
      result[slot.id] = presetPick;
      continue;
    }

    const firstEligible = slot.variants.find((v) => isEligible(v.id));
    if (firstEligible) {
      result[slot.id] = firstEligible.id;
      continue;
    }

    // No variant is eligible for this slot — fall back to preset v1
    // regardless, rather than leaving the slot unpicked.
    const v1PickId = lens.presets.find((p) => p.id === 'v1')?.pick[slot.id];
    result[slot.id] = v1PickId ?? slot.variants[0]?.id ?? '';
  }

  return result;
}

/**
 * Merges an existing hand-made picks.json with freshly scored picks: keeps
 * `existing`'s choice for a slot unless that slot id is listed in
 * `resetSlots`, in which case `scored`'s choice wins. `existing === null`
 * (no picks.json yet) returns `scored` unchanged.
 */
export function mergePicks(
  existing: ProjectPagePicks | null,
  scored: ProjectPagePicks,
  resetSlots: string[] = [],
): ProjectPagePicks {
  if (existing === null) return scored;

  const resetSet = new Set(resetSlots);
  const merged: ProjectPagePicks = {};

  for (const lensId of Object.keys(scored)) {
    const scoredLens = scored[lensId] ?? {};
    const existingLens = existing[lensId] ?? {};
    const mergedLens: Record<string, string> = {};

    for (const slotId of Object.keys(scoredLens)) {
      const key = `${lensId}.${slotId}`;
      if (!resetSet.has(key) && !resetSet.has(slotId) && existingLens[slotId] != null) {
        mergedLens[slotId] = existingLens[slotId];
      } else {
        mergedLens[slotId] = scoredLens[slotId];
      }
    }

    merged[lensId] = mergedLens;
  }

  return merged;
}
