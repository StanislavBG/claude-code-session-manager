// @ts-check
'use strict';
// GET /admin/usage-hold — the usage hold Session Manager is applying to
// automatic claude -p runs right now ('pause above'), the same hold
// POST /admin/tasks refuses on. Answers
//   200 { ok: true, hold, threshold }
// where hold is null when nothing is held, else
//   { reason, window, percent, threshold, resetsAt, detail } (+ baseThreshold
// when set) — publicHold below, the same shape every 429 usage_held answers,
// and threshold is the saved 'pause above' percent. A failed read answers
//   503 { ok: false, error: 'usage_hold_error', details }.
// Read by scripts that start claude -p directly (e.g. Self's Kiln daily job
// while its Task switch is off): they check `hold === null` before an
// automatic run. Read-only: ignores any query string, reads no body, writes nothing.

const { sendJson } = require('../feedback-remote/localAdminHttp.cjs');

/**
 * The hold's one outside shape, shared by GET /admin/usage-hold and every
 * 429 usage_held answer. baseThreshold (the saved 'pause above' before
 * pro-rating) is forwarded only when it is a finite number.
 * @param {any} hold
 * @returns {Record<string, unknown> | null}
 */
function publicHold(hold) {
  if (hold == null) return null;
  /** @type {Record<string, unknown>} */
  const out = {
    reason: hold.reason ?? null,
    window: hold.window ?? null,
    percent: hold.percent ?? null,
    threshold: hold.threshold ?? null,
    resetsAt: hold.resetsAt ?? null,
    detail: hold.detail ?? null,
  };
  if (typeof hold.baseThreshold === 'number' && Number.isFinite(hold.baseThreshold)) {
    out.baseThreshold = hold.baseThreshold;
  }
  return out;
}

/**
 * The 429 usage_held body: the public hold minus detail, with detail and the
 * caller's hint at the top level.
 * @param {any} hold
 * @param {string} hint
 */
function usageHeldBody(hold, hint) {
  const { detail, ...rest } = publicHold(hold ?? {}) || {};
  return { ok: false, error: 'usage_held', hold: rest, detail: detail ?? null, hint };
}

/**
 * @param {{ registerRoute: Function }} adminHttp
 * @param {{ usageHold?: () => unknown, threshold?: () => number }} [deps]
 */
function registerUsageHoldRoute(adminHttp, deps = {}) {
  const usageHold = deps.usageHold || (() => require('../../scheduler.cjs').currentUsageHold());
  const threshold = deps.threshold || (() => require('../../scheduler.cjs').usageHoldThreshold());

  adminHttp.registerRoute('GET', '/admin/usage-hold', (/** @type {unknown} */ _req, /** @type {import('node:http').ServerResponse} */ res) => {
    let hold;
    let t;
    try {
      hold = usageHold() ?? null;
      t = threshold();
    } catch (e) {
      sendJson(res, 503, { ok: false, error: 'usage_hold_error', details: e instanceof Error ? e.message : String(e) });
      return;
    }
    sendJson(res, 200, { ok: true, hold: publicHold(hold), threshold: t });
  });
}

module.exports = { registerUsageHoldRoute, publicHold, usageHeldBody };
