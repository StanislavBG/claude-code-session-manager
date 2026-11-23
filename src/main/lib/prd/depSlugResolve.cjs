'use strict';

/**
 * depSlugResolve.cjs — the single `dependsOn` slug-resolution rule (PRD 832),
 * shared by schedulerBatch.cjs's findBlockingDep (run-time gating: does a
 * queue row exist for this dep) and prdCreate.cjs's write-time validation
 * (does a PRD exist for this dep at all). Both must agree on what a
 * `dependsOn` entry resolves to, or a dep that validates at PRD-create time
 * could still fail to block at run time (or vice versa) — so the matching
 * rule lives here once, not copied into each caller.
 *
 * Resolution rule (write-time resolveDepSlug): exact slug match first; else
 * bare-name match after stripping one leading `NN-` prefix — a human-authored
 * `dependsOn:` can't know the `NN-` prefix the allocator will hand a sibling
 * PRD. Run-time gating uses makeDepResolver below, which adds the satisfied
 * record and Epic ordering on top of the same bare-name rule.
 */

const { isCancelledRow } = require('../scheduler/cancelledRow.cjs');

/** Strip one leading `NN-` prefix, if present. */
function bareSlug(slug) {
  return String(slug ?? '').replace(/^\d+-/, '');
}

/**
 * Resolve `depSlug` against `candidateSlugs`: exact match wins outright;
 * otherwise every candidate whose bare name matches. Returns a (possibly
 * empty) array of matching candidate slugs.
 */
function resolveDepSlug(depSlug, candidateSlugs) {
  if (candidateSlugs.includes(depSlug)) return [depSlug];
  const bare = bareSlug(depSlug);
  return candidateSlugs.filter((slug) => bareSlug(slug) === bare);
}

/**
 * Is this dep ROW satisfied? `completed`, or a `skipped` row stamped
 * `needsReviewAutoResolvedSkip` — the bounded needs_review auto-resolve's
 * terminal decision (scheduler.cjs applyNeedsReviewAutoResolve), deliberately
 * not a permanent block. Shared by schedulerBatch.findBlockingDep (dispatch)
 * and runVerify.checkDeps (post-run): when they disagreed, the picker fired a
 * dependent of an auto-skipped row and the verifier downgraded every finished
 * run back to pending on "is skipped (need completed)" — an unbounded billed
 * re-run loop (Bilko-Launch-Kit validator, ~20 runs, 2026-10-11).
 */
function isSatisfiedDepRow(row) {
  return row?.status === 'completed'
    || (row?.status === 'skipped' && row.needsReviewAutoResolvedSkip === true);
}

/**
 * Levenshtein edit distance. O(n*m) in the two strings' lengths — fine here
 * since it only ever runs over short slug strings (<= 60 chars, PRD_CREATE_SLUG_RE's
 * cap) at PRD-create time, never in a hot/per-tick path.
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prevRow = new Array(n + 1);
  const curRow = new Array(n + 1);
  for (let j = 0; j <= n; j++) prevRow[j] = j;
  for (let i = 1; i <= m; i++) {
    curRow[0] = i;
    for (let j = 1; j <= n; j++) {
      curRow[j] = a[i - 1] === b[j - 1]
        ? prevRow[j - 1]
        : 1 + Math.min(prevRow[j - 1], prevRow[j], curRow[j - 1]);
    }
    for (let j = 0; j <= n; j++) prevRow[j] = curRow[j];
  }
  return prevRow[n];
}

/**
 * Nearest existing slugs to `depSlug` by bare-name edit distance, closest
 * first, capped at `limit` — used to build an actionable "did you mean"
 * error when a dependsOn entry resolves to nothing.
 */
function findNearMatches(depSlug, candidateSlugs, limit = 3) {
  const depBare = bareSlug(depSlug);
  return candidateSlugs
    .map((slug) => ({ slug, dist: levenshtein(depBare, bareSlug(slug)) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit)
    .map((entry) => entry.slug);
}

/** The Epic a queue row belongs to: `epicId`, else its `sourcePromptId`. */
function epicOf(job) {
  return job?.epicId ?? job?.sourcePromptId ?? null;
}

/** True when `slug` carries a leading `NN-` allocator prefix. */
function isPrefixedSlug(slug) {
  return /^\d+-/.test(String(slug ?? ''));
}

/**
 * makeDepResolver(projectJobs, satisfiedSlugs, { failOpen, epicId }) — the ONE
 * run-time `dependsOn` resolution rule, shared by every schedulerBatch.cjs
 * gate (findBlockingDep, findUnresolvableDepRoots, pickForProject's hold
 * records and root-blocker walk) so gating, holds and the root walk can never
 * disagree about what a dep names.
 *
 * resolve(dep, dependentJob) → { kind: 'row'|'satisfied'|'unresolved', rows }, in order:
 *   1. an exact live row                              → 'row'
 *   2. the exact slug in satisfiedSlugs               → 'satisfied'
 *   3. NN-prefixed dep: a live row with the same bare name IN THE DEPENDENT'S
 *      EPIC                                           → 'row'; else 'unresolved'
 *      (a dep written with a full slug names one PRD — another Epic's
 *      re-allocated sibling is not it)
 *   4. bare dep: live rows with that bare name, preferring rows in the
 *      dependent's Epic                               → 'row'
 *   5. bare dep: a satisfied record with that bare name → 'satisfied'
 *   6.                                                 → 'unresolved'
 * In steps 3-4 a cancelled row (isCancelledRow, lib/scheduler/cancelledRow.cjs) is dropped when a satisfied
 * record shares its bare name — a human-cancelled duplicate must never freeze
 * the dependents of the PRD that genuinely finished (Self, 2026-11-22: the
 * cancelled 1056-sm-contract-client froze 16 dependents of the completed
 * 1047-sm-contract-client).
 *
 * `failOpen` (the caller's history/archive lookup failed this tick): any dep
 * that resolves to no live row is 'satisfied' instead of 'unresolved'.
 * `epicId` is the fallback Epic when resolve() is called without a dependent.
 */
function makeDepResolver(projectJobs, satisfiedSlugs = new Set(), opts = {}) {
  const failOpen = opts.failOpen === true;
  const satisfied = satisfiedSlugs instanceof Set ? satisfiedSlugs : new Set(satisfiedSlugs ?? []);
  const rowBySlug = new Map();
  const rowsByBareSlug = new Map();
  for (const j of projectJobs) {
    if (!rowBySlug.has(j.slug)) rowBySlug.set(j.slug, j);
    const bare = bareSlug(j.slug);
    if (!rowsByBareSlug.has(bare)) rowsByBareSlug.set(bare, []);
    rowsByBareSlug.get(bare).push(j);
  }
  let satisfiedBareSlugs = null;
  const hasSatisfiedBare = (bare) => {
    if (satisfiedBareSlugs === null) {
      satisfiedBareSlugs = new Set();
      for (const s of satisfied) satisfiedBareSlugs.add(bareSlug(s));
    }
    return satisfiedBareSlugs.has(bare);
  };
  const unresolved = () => (failOpen ? { kind: 'satisfied', rows: [] } : { kind: 'unresolved', rows: [] });

  const resolve = (dep, dependentJob) => {
    const exact = rowBySlug.get(dep);
    if (exact) return { kind: 'row', rows: [exact] };
    if (satisfied.has(dep)) return { kind: 'satisfied', rows: [] };
    const bare = bareSlug(dep);
    const depEpic = dependentJob ? epicOf(dependentJob) : (opts.epicId ?? null);
    const sameEpic = (r) => depEpic != null && epicOf(r) === depEpic;
    const bareRows = rowsByBareSlug.get(bare) ?? [];
    const bareSatisfied = hasSatisfiedBare(bare);
    const live = (rows) => (bareSatisfied ? rows.filter((r) => !isCancelledRow(r)) : rows);

    if (isPrefixedSlug(dep)) {
      const rows = live(bareRows.filter(sameEpic));
      return rows.length > 0 ? { kind: 'row', rows } : unresolved();
    }
    const preferred = bareRows.filter(sameEpic);
    const rows = live(preferred.length > 0 ? preferred : bareRows);
    if (rows.length > 0) return { kind: 'row', rows };
    if (bareSatisfied) return { kind: 'satisfied', rows: [] };
    return unresolved();
  };
  const rowsForDep = (dep, dependentJob) => resolve(dep, dependentJob).rows;
  const isKnownSatisfied = (dep, dependentJob) => resolve(dep, dependentJob).kind === 'satisfied';
  return { resolve, rowsForDep, isKnownSatisfied };
}

module.exports = {
  bareSlug, resolveDepSlug, findNearMatches, isSatisfiedDepRow, epicOf, makeDepResolver,
};
