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
 *   baseThreshold?: number | null,
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

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * The pro-rated threshold reaches this in a window's final stretch. 99, not
 * 100: automatic work stops one point short of the account limit so
 * interactive chats keep working until the reset (owner's choice, 2026-11-24).
 * A saved 'pause above' at or above it is returned unchanged.
 */
const PRO_RATE_CEILING = 99;
/** Share of a window left at which the threshold reaches the ceiling (last 2 days of a week). */
const PRO_RATE_FULL_FRACTION = 2 / 7;
/** Length of each usage window kind. */
const WINDOW_LENGTH_MS = Object.freeze({ weekly: 7 * DAY_MS, fiveHour: 5 * HOUR_MS });

/**
 * Window length from its name, or null for an unknown window.
 * @param {string | null | undefined} window
 * @returns {number | null}
 */
function windowLengthMs(window) {
  if (typeof window !== 'string') return null;
  if (/weekly|seven_day/i.test(window)) return WINDOW_LENGTH_MS.weekly;
  if (/five_hour|session/i.test(window)) return WINDOW_LENGTH_MS.fiveHour;
  return null;
}

/**
 * Effective 'pause above' value for one window: the owner would rather touch
 * the limit than leave credits unspent, so the threshold rises from `base`
 * (whole window left) linearly to PRO_RATE_CEILING once only
 * PRO_RATE_FULL_FRACTION of the window is left. Never below `base`; unknown
 * window, missing/unparseable reset, or non-finite base -> base unchanged.
 * @param {{ base: number, window: string | null | undefined, resetsAt: string | null | undefined, now: number }} args
 * @returns {number}
 */
function proRatedThreshold({ base, window, resetsAt, now }) {
  if (typeof base !== 'number' || !Number.isFinite(base)) return base;
  if (base >= PRO_RATE_CEILING) return base;
  const length = windowLengthMs(window);
  if (length === null) return base;
  const reset = resetMs(resetsAt);
  if (!Number.isFinite(reset)) return base;
  const f = (reset - now) / length;
  if (!Number.isFinite(f)) return base;
  if (f >= 1) return base;
  if (f <= PRO_RATE_FULL_FRACTION) return PRO_RATE_CEILING;
  const value = base + (PRO_RATE_CEILING - base) * (1 - f) / (1 - PRO_RATE_FULL_FRACTION);
  return Math.max(base, value);
}

/**
 * Human time left: "1.7 days", "4.0 h", "25 min".
 * @param {number} ms
 * @returns {string}
 */
function formatTimeLeft(ms) {
  if (ms >= DAY_MS) return `${(ms / DAY_MS).toFixed(1)} days`;
  if (ms >= HOUR_MS) return `${(ms / HOUR_MS).toFixed(1)} h`;
  return `${String(Math.max(0, Math.round(ms / 60_000)))} min`;
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

  /** @type {UsageWindow[]} */
  const candidates = Array.isArray(reading.windows) && reading.windows.length > 0
    ? reading.windows
    : [{ window: reading.window, percent: reading.percent, resetsAt: reading.resetsAt }];

  /** @type {{ window: string | null, percent: number, resetsAt: string | null, resetAt: number, limit: number } | null} */
  let pick = null;
  for (const c of candidates) {
    if (!c) continue;
    const percent = c.percent;
    if (typeof percent !== 'number' || !Number.isFinite(percent)) continue;
    const resetAt = resetMs(c.resetsAt);
    if (resetAt <= now) continue; // already reset: its old reading no longer applies
    const limit = utilizationHold.proRatedThreshold({ base: threshold, window: c.window, resetsAt: c.resetsAt, now });
    if (percent < limit) continue;
    if (pick === null || resetAt > pick.resetAt || (resetAt === pick.resetAt && percent > pick.percent)) {
      pick = { window: c.window ?? null, percent, resetsAt: c.resetsAt ?? null, resetAt, limit };
    }
  }
  if (pick === null) return null;

  const proRated = pick.limit !== threshold
    ? ` (pause above ${String(threshold)}%, pro-rated: ${formatTimeLeft(pick.resetAt - now)} to reset)`
    : '';
  const shownLimit = Math.round(pick.limit * 10) / 10;
  return {
    reason: 'utilization-held',
    window: pick.window,
    percent: pick.percent,
    threshold: pick.limit,
    baseThreshold: threshold,
    resetsAt: pick.resetsAt,
    detail: `${pick.window ?? 'binding'} window at ${String(pick.percent)}% ≥ ${String(shownLimit)}%${proRated}, resets ${pick.resetsAt ?? 'unknown'}`,
  };
}

const MINUTE_MS = 60_000;

/**
 * Identity of one auto-dispatch hold: reason + window + reset, for the
 * once-per-hold audit keys. The usage API returns a different resets_at string
 * for the same reset on almost every fetch (329 distinct strings for one
 * weekly reset across 640 heartbeat lines, about ±0.5 s either side of the
 * minute), so the reset is rounded to the nearest whole minute. An unparseable
 * resetsAt is used raw ('' when absent) so the key stays stable.
 * @param {{ reason: string, window?: string | null, resetsAt?: string | null }} hold
 * @returns {string}
 */
function holdIdentityKey(hold) {
  const raw = hold.resetsAt ?? '';
  const ms = typeof hold.resetsAt === 'string' ? Date.parse(hold.resetsAt) : NaN;
  const reset = Number.isFinite(ms) ? new Date(Math.round(ms / MINUTE_MS) * MINUTE_MS).toISOString() : raw;
  return `${hold.reason}|${hold.window ?? ''}|${reset}`;
}

const utilizationHold = {
  evaluateAutoDispatchHold,
  holdIdentityKey,
  proRatedThreshold,
  PRO_RATE_CEILING,
  PRO_RATE_FULL_FRACTION,
  WINDOW_LENGTH_MS,
};
module.exports = utilizationHold;
