// @ts-check
'use strict';
// GET /admin/usage-hold — the usage hold Session Manager is applying to
// automatic claude -p runs right now ('pause above'), the same hold
// POST /admin/tasks refuses on. Answers
//   200 { ok: true, hold, threshold }
// where hold is null when nothing is held, else
//   { reason, window, percent, threshold, resetsAt, detail },
// and threshold is the saved 'pause above' percent. A failed read answers
//   503 { ok: false, error: 'usage_hold_error', details }.
// Read by scripts that start claude -p directly (e.g. Self's Kiln daily job
// while its Task switch is off): they check `hold === null` before an
// automatic run. Read-only: ignores any query string, reads no body, writes nothing.

const { sendJson } = require('../feedback-remote/localAdminHttp.cjs');

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
    sendJson(res, 200, { ok: true, hold, threshold: t });
  });
}

module.exports = { registerUsageHoldRoute };
