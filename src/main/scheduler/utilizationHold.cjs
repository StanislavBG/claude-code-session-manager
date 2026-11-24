// @ts-check
'use strict';

/**
 * scheduler/utilizationHold.cjs — the one rule deciding whether an automatic
 * (non-human) scheduler tick may dispatch. Pure: no I/O, no clock (`now` is a
 * parameter), so every caller (when-available, job-finish, dispatch-loop,
 * slot-release ticks) agrees.
 *
 * Why every window: during a meter outage the top window (a 5-hour session
 * at 97%) can reset while weekly_all in the same payload is still at 92%
 * until Thursday. Reading only the binding window drops the hold at the
 * session reset and the queue dispatches into the weekly limit (Self,
 * 2026-11-23). A window whose reset has passed is skipped — never read as
 * "no hold" for the others.
 */

/**
 * @typedef {{ window: string | null, percent: number | null, resetsAt: string | null }} UsageWindow
 * @typedef {{
 *   percent: number | null,
 *   window: string | null,
 *   resetsAt: string | null,
 *   known: boolean,
 *   windows: UsageWindow[] | null,
 * }} UtilizationReading
 * @typedef {{
 *   reason: 'manual-fire-policy' | 'utilization-held',
 *   window: string | null,
 *   percent: number | null,
 *   threshold: number | null,
 *   resetsAt: string | null,
 *   detail: string,
 * }} AutoDispatchHold
 */

/**
 * Reset time as ms, or +Infinity when null/unparseable (counts as "resets last").
 * @param {string | null | undefined} resetsAt
 * @returns {number}
 */
function resetMs(resetsAt) {
  const ms = typeof resetsAt === 'string' ? Date.parse(resetsAt) : NaN;
  return Number.isFinite(ms) ? ms : Infinity;
}

/**
 * @param {{
 *   firePolicy: string | null | undefined,
 *   threshold: number | null | undefined,
 *   reading: UtilizationReading | null | undefined,
 *   now: number,
 * }} args
 * @returns {AutoDispatchHold | null}
 */
function evaluateAutoDispatchHold({ firePolicy, threshold, reading, now }) {
  if (firePolicy === 'manual') {
    return {
      reason: 'manual-fire-policy',
      window: null,
      percent: null,
      threshold: null,
      resetsAt: null,
      detail: 'fire policy is manual: only Run now dispatches',
    };
  }
  if (reading == null || reading.known !== true) return null;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) return null;
  const limit = threshold;

  /** @type {UsageWindow[]} */
  const candidates = Array.isArray(reading.windows) && reading.windows.length > 0
    ? reading.windows
    : [{ window: reading.window, percent: reading.percent, resetsAt: reading.resetsAt }];

  /** @type {{ window: string | null, percent: number, resetsAt: string | null, resetAt: number } | null} */
  let pick = null;
  for (const c of candidates) {
    if (!c) continue;
    const percent = c.percent;
    if (typeof percent !== 'number' || !Number.isFinite(percent)) continue;
    const resetAt = resetMs(c.resetsAt);
    if (resetAt <= now) continue; // already reset: its old reading no longer applies
    if (percent < limit) continue;
    if (pick === null || resetAt > pick.resetAt || (resetAt === pick.resetAt && percent > pick.percent)) {
      pick = { window: c.window ?? null, percent, resetsAt: c.resetsAt ?? null, resetAt };
    }
  }
  if (pick === null) return null;

  return {
    reason: 'utilization-held',
    window: pick.window,
    percent: pick.percent,
    threshold: limit,
    resetsAt: pick.resetsAt,
    detail: `${pick.window ?? 'binding'} window at ${String(pick.percent)}% ≥ ${String(limit)}%, resets ${pick.resetsAt ?? 'unknown'}`,
  };
}

module.exports = { evaluateAutoDispatchHold };
