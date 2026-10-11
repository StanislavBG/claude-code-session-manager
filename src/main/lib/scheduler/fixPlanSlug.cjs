/**
 * fixPlanSlug.cjs — single source of truth for recognizing a scheduler-
 * authored fix-plan PRD (PRD 1131).
 *
 * `isFixPlanSlug`'s `/^\d+-fix-/` name test used to be treated as sufficient
 * evidence on its own. But any PRD an agent or human authors through
 * `scheduler_create_prd` whose title happens to kebab-case into a
 * `fix-`-leading slug silently inherited every fix-plan special case
 * (depth-capped auto-investigation, `commitGuardVerdict`'s zero-edit
 * exemption) it never asked for — PRD 1126
 * (`126-fix-plan-death-reopens-parent`, `createdVia: scheduler-api`) was
 * wrongly stamped `investigationDepth: 2` before it ever ran and had to be
 * withdrawn and re-slugged.
 *
 * A genuine fix plan is authored directly by scheduler.cjs's
 * `spawnInvestigation` — a raw `Write`, never through `scheduler_create_prd`
 * (see `guard-prd-writes.cjs`'s exemption) — so it never carries a
 * `createdVia` stamp. Its prompt template also stamps an explicit
 * `isFixPlan: true` frontmatter key so classification has a positive
 * signal to check, not just an absence.
 *
 * `classifyDiscoveredFixPlan` is the ONE place a freshly-parsed PRD file
 * (which has real `createdVia`/`isFixPlan` frontmatter) is turned into a
 * boolean fix-plan verdict — `reconcile()` calls it once per newly
 * discovered PRD and persists the verdict onto the queue row's `isFixPlan`
 * field, so every later consumer reads that stamp instead of re-deriving it
 * from the name. `resolveIsFixPlan` is what those consumers call: an
 * explicit `true`/`false` on the row wins; a row with the field entirely
 * absent (any queue.json row persisted before this change shipped) falls
 * back to the legacy slug-only heuristic so live history is never
 * re-classified.
 */
'use strict';

function isFixPlanSlug(slug) {
  return /^\d+-fix-/.test(slug);
}

/**
 * Classify a freshly-parsed PRD file (real `createdVia`/`isFixPlan`
 * frontmatter available). `createdVia` is checked FIRST and always wins —
 * proof the PRD was authored through the sanctioned scheduler_create_prd API
 * (a lower-trust path than spawnInvestigation's own raw write) must never be
 * overridable by an `isFixPlan: true` stamp in the same file, even though no
 * current write path can produce both on one file (see prdCreate.cjs's
 * slug-refusal + guard-prd-writes.cjs's write-guard). Structural belt, not
 * just relying on those two other files staying in sync.
 */
function classifyDiscoveredFixPlan({ isFixPlan, createdVia } = {}, slug) {
  if (createdVia) return false;
  if (isFixPlan === true) return true;
  return isFixPlanSlug(slug);
}

/** Classify a queue-row job, honoring an already-persisted `isFixPlan` stamp over the slug. */
function resolveIsFixPlan(slug, isFixPlan) {
  if (isFixPlan === true) return true;
  if (isFixPlan === false) return false;
  return isFixPlanSlug(slug);
}

module.exports = { isFixPlanSlug, classifyDiscoveredFixPlan, resolveIsFixPlan };
