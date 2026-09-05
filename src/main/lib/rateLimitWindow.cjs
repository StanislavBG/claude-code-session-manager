'use strict';

/**
 * rateLimitWindow.cjs — reads the BINDING rate-limit window's reset time
 * straight off a run's own log, instead of trusting the billing usage
 * endpoint's five_hour window (PRD 1118). A run can be 429'd by a
 * different window than five_hour (seven_day, seven_day_overage_included)
 * while five_hour utilization is still 0 — pausing against five_hour's
 * reset in that case arms the resume timer against the wrong clock, and
 * the billing endpoint can itself be 429'ing when this is needed most.
 *
 * Pure: log path in, reset value out. No electron import, so it is
 * unit-testable without scheduler.cjs (mirrors reaperHelpers.cjs's split).
 */

const { readTail } = require('./fileTail.cjs');

// Authoritative window block rides on the LAST rate_limit_event in the log
// (often the one attached to the final result), so mirror classifyRunOutcome's
// 64 KB tail rather than detectRateLimitInLog's smaller 16 KB one.
const TAIL_BYTES = 64 * 1024;

/**
 * Scans a run log's tail for rate_limit_event entries and returns the
 * UNIX-seconds resetsAt of the window that actually bound (utilization >= 1.0)
 * in the LAST such event. When multiple windows bind in that event, the
 * latest resetsAt wins. Returns null when no rate_limit_event is found, or
 * none of its windows are at/above 1.0 utilization.
 */
function resolveBindingRateLimitReset(logPath) {
  const text = readTail(logPath, TAIL_BYTES);
  if (!text) return null;

  let lastWindows = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const windows = event?.rate_limit_info?.unifiedWindows;
    if (event?.type === 'rate_limit_event' && windows && typeof windows === 'object') {
      lastWindows = windows;
    }
  }
  if (!lastWindows) return null;

  let latestBoundReset = null;
  for (const window of Object.values(lastWindows)) {
    if (!window || typeof window.utilization !== 'number' || typeof window.resetsAt !== 'number') continue;
    if (window.utilization < 1.0) continue;
    if (latestBoundReset === null || window.resetsAt > latestBoundReset) {
      latestBoundReset = window.resetsAt;
    }
  }
  return latestBoundReset;
}

module.exports = { resolveBindingRateLimitReset };
