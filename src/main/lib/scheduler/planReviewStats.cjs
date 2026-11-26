'use strict';

/**
 * planReviewStats.cjs — pure aggregate comparing an Epic's reviewed plans (a
 * stored plan-review record with a release) against its unreviewed ones, on
 * review findings accepted/rejected, validator findings, REFUTED verdicts and
 * fixes[] escapes (missKind spec-gap | missing-test).
 *
 * A plan is a validate slug. A PRD belongs to a reviewed plan when it appears
 * in that record's reviews[].review.prds[].prd (bare slug). Every other verdict
 * or fix is unreviewed; unreviewed `plans` counts the distinct `plan` keys a
 * verdict entry carries (entries with none add to the totals only).
 */

const ESCAPE_KINDS = new Set(['spec-gap', 'missing-test']);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const bare = (s) => String(s).replace(/^\d+-/, '');

/**
 * @param {{ planReviews?: any[], verdictFiles?: any[], fixes?: any[] }} [input]
 */
function planReviewStats({ planReviews, verdictFiles, fixes } = {}) {
  const reviewed = { plans: 0, acceptedFindings: 0, rejectedFindings: 0, validatorFindings: 0, refuted: 0, escapes: 0 };
  const unreviewed = { plans: 0, validatorFindings: 0, refuted: 0, escapes: 0 };
  const member = new Map(); // bare prd slug -> validateSlug of a reviewed plan

  for (const rec of Array.isArray(planReviews) ? planReviews : []) {
    if (!isObj(rec) || !isObj(rec.release)) continue;
    reviewed.plans += 1;
    const acc = rec.release.accepted;
    if (Number.isFinite(acc)) reviewed.acceptedFindings += acc;
    if (Array.isArray(rec.release.rejected)) reviewed.rejectedFindings += rec.release.rejected.length;
    for (const r of Array.isArray(rec.reviews) ? rec.reviews : []) {
      const prds = isObj(r) && isObj(r.review) && Array.isArray(r.review.prds) ? r.review.prds : [];
      for (const p of prds) if (isObj(p) && typeof p.prd === 'string') member.set(bare(p.prd), rec.validateSlug);
    }
  }

  const unreviewedPlanKeys = new Set();
  for (const v of Array.isArray(verdictFiles) ? verdictFiles : []) {
    if (!isObj(v) || typeof v.prd !== 'string') continue;
    const target = member.has(bare(v.prd)) ? reviewed : unreviewed;
    if (target === unreviewed) {
      const key = typeof v.plan === 'string' && v.plan ? v.plan : null;
      if (key) unreviewedPlanKeys.add(key);
    }
    target.validatorFindings += Array.isArray(v.findings) ? v.findings.length : 0;
    if (v.verdict === 'REFUTED') target.refuted += 1;
  }
  unreviewed.plans = unreviewedPlanKeys.size;

  for (const f of Array.isArray(fixes) ? fixes : []) {
    if (!isObj(f) || typeof f.prd !== 'string' || !ESCAPE_KINDS.has(f.missKind)) continue;
    (member.has(bare(f.prd)) ? reviewed : unreviewed).escapes += 1;
  }

  return { reviewed, unreviewed };
}

module.exports = { planReviewStats };
