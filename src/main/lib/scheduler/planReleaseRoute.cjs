/**
 * planReleaseRoute.cjs — POST /admin/scheduler/release-plan: the planner's one
 * call that releases a plan held for independent review.
 *
 *   body { cwd, epicId, validateSlug, rejected: [{ finding, reason }],
 *          accepted: number, rereview?: boolean }
 *
 *   - release: records plan-records/<epic>/<slug>.plan-review.json release
 *     { by: 'planner', rejected, accepted }. A second call → 200 alreadyReleased.
 *     Every rejected entry needs a non-empty one-line reason (400 otherwise).
 *   - rereview: true instead asks for ONE more review after a block. Accepted
 *     only when the latest review has a `block` decision and round is 1 and the
 *     plan is not released; writes rereviewRequested: true, else 400 + reason.
 *   - unsafe epicId / validateSlug → 400.
 */
'use strict';

const { z } = require('zod');
const { readBody, sendJson } = require('../feedback-remote/localAdminHttp.cjs');
const { planReviewPath, readPlanReview, recordPlanRelease } = require('./planReviewStore.cjs');
const { assertOpsWrite } = require('../opsOwnership.cjs');
const { writeJsonAtomic } = require('../util/atomicFs.cjs');
const { EPIC_ID_RE } = require('./planRecordHarvest.cjs');

const MAX_BODY_BYTES = 256 * 1024;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const bodySchema = z.object({
  cwd: z.string().min(1),
  epicId: z.string(),
  validateSlug: z.string(),
  rejected: z.array(z.object({ finding: z.string(), reason: z.string() })).optional().default([]),
  accepted: z.number().finite().min(0).optional().default(0),
  rereview: z.boolean().optional(),
});

/** @param {any} record */
function latestHasBlock(record) {
  const reviews = record && Array.isArray(record.reviews) ? record.reviews : [];
  const last = reviews[reviews.length - 1];
  const prds = last && last.review && Array.isArray(last.review.prds) ? last.review.prds : [];
  return prds.some((/** @type {any} */ p) => p && p.decision === 'block');
}

/** @param {{ registerRoute: Function }} adminHttp */
function registerPlanReleaseRoute(adminHttp) {
  adminHttp.registerRoute('POST', '/admin/scheduler/release-plan', async (/** @type {any} */ req, /** @type {any} */ res) => {
    const bad = (/** @type {any} */ details) => sendJson(res, 400, { ok: false, error: 'invalid_request', details });
    let raw;
    try { raw = await readBody(req, MAX_BODY_BYTES); } catch (e) {
      bad(e instanceof Error ? e.message : String(e));
      return;
    }
    let json;
    try { json = JSON.parse(raw || '{}'); } catch { bad('body is not valid JSON'); return; }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) { bad(parsed.error.issues); return; }
    const { cwd, epicId, validateSlug, rejected, accepted, rereview } = parsed.data;
    if (!EPIC_ID_RE.test(epicId) || !SLUG_RE.test(validateSlug) || validateSlug.includes('..')) {
      bad('unsafe epicId or validateSlug');
      return;
    }
    try {
      const prior = readPlanReview(cwd, epicId, validateSlug);

      if (rereview) {
        let reason = null;
        if (!prior || !Array.isArray(prior.reviews) || prior.reviews.length === 0) reason = 'no review on record for this plan';
        else if (prior.release) reason = 'the plan is already released';
        else if (!latestHasBlock(prior)) reason = 'the latest review has no block decision';
        else if (prior.round !== 1) reason = `a re-review is allowed once per plan; the plan is at round ${prior.round}`;
        else if (prior.rereviewRequested) reason = 're-review was already requested';
        if (reason) { sendJson(res, 400, { ok: false, error: 'rereview_refused', reason }); return; }
        const file = planReviewPath(cwd, epicId, validateSlug);
        assertOpsWrite(file, 'scheduler');
        await writeJsonAtomic(file, { ...prior, rereviewRequested: true });
        sendJson(res, 200, { ok: true, rereviewRequested: true });
        return;
      }

      const missing = rejected.findIndex((r) => !r.reason.trim());
      if (missing !== -1) {
        sendJson(res, 400, { ok: false, error: 'reason_required', reason: `rejected[${missing}] needs a non-empty one-line reason` });
        return;
      }
      const out = await recordPlanRelease({
        cwd, epicId, validateSlug, by: 'planner',
        rejected: rejected.map((r) => ({ finding: r.finding, reason: r.reason.trim() })),
        accepted,
      });
      if (out && out.alreadyReleased) { sendJson(res, 200, { ok: true, alreadyReleased: true }); return; }
      sendJson(res, 200, { ok: true, released: true, accepted, rejected: rejected.length });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: 'release_failed', details: e instanceof Error ? e.message : String(e) });
    }
  });
}

module.exports = { registerPlanReleaseRoute };
