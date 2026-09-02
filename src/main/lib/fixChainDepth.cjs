/**
 * fixChainDepth.cjs — pure slug-inspection helpers for the fix-chain depth
 * guard (PRD 1113). Generalizes scheduler.cjs's `isFixPlanSlug` (`^\d+-fix-`)
 * into a counter: how many CONSECUTIVE '-fix-' segments immediately follow
 * the leading `NN-` prefix. Only a run starting right at the prefix counts —
 * a later segment that happens to read 'fix' (e.g.
 * '13-fix-loop-extraction-and-round-trip', where 'loop' breaks the run right
 * after the first 'fix') does not extend the count, and a segment that only
 * contains 'fix' as a substring (e.g. '113-prefix-foo') never matches at all
 * since segments are compared for exact equality after splitting on '-'.
 *
 * No filesystem access, no scheduler.cjs dependency — safe to require from
 * lib/prdCreate.cjs without pulling in the scheduler module graph.
 */
'use strict';

function fixChainDepthOf(slug) {
  const rest = String(slug).replace(/^\d+-/, '');
  const segments = rest.split('-');
  let depth = 0;
  for (const seg of segments) {
    if (seg !== 'fix') break;
    depth += 1;
  }
  return depth;
}

/**
 * Strips the leading consecutive '-fix-' chain a slug carries, returning the
 * base slug the chain descends from — e.g. '113-fix-fix-foo' -> '113-foo'.
 * Used only for error messages (naming what actually failed to close).
 */
function baseSlugOf(slug) {
  const str = String(slug);
  const prefixMatch = str.match(/^(\d+)-/);
  const prefix = prefixMatch ? prefixMatch[1] : '';
  const rest = str.replace(/^\d+-/, '');
  const segments = rest.split('-');
  let i = 0;
  while (i < segments.length && segments[i] === 'fix') i += 1;
  const remainder = segments.slice(i).join('-');
  return prefix ? `${prefix}-${remainder}` : remainder;
}

module.exports = { fixChainDepthOf, baseSlugOf };
