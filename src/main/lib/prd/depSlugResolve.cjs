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
 * Resolution rule: exact slug match first; else bare-name match after
 * stripping one leading `NN-` prefix — a human-authored `dependsOn:` can't
 * know the `NN-` prefix the allocator will hand a sibling PRD.
 */

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

module.exports = { bareSlug, resolveDepSlug, findNearMatches };
