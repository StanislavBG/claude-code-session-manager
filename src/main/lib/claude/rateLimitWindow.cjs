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

const { readTail } = require('../util/fileTail.cjs');

// Authoritative window block rides on the LAST rate_limit_event in the log
// (often the one attached to the final result), so mirror classifyRunOutcome's
// 64 KB tail rather than detectRateLimitInLog's smaller 16 KB one.
const TAIL_BYTES = 64 * 1024;

/**
 * Scans a run log's tail for rate_limit_event entries. The REJECTED event is
 * authoritative (2026-10-11 incident: an allowed-only log with a seven_day
 * window pause landed on the seven_day reset 4 days out): if any event has
 * status 'rejected', the LAST one's reset wins — rate_limit_info.resetsAt, else
 * unifiedWindows[rateLimitType].resetsAt. Otherwise, a last event carrying a
 * status (allowed / allowed_warning) yields null, even if a window shows
 * utilization >= 1.0 (overage is not a rejection). Legacy: a last event with
 * no status falls back to the latest resetsAt among windows at utilization >= 1.0.
 */
function resolveBindingRateLimitReset(logPath) {
  const text = readTail(logPath, TAIL_BYTES);
  if (!text) return null;

  let lastRejected = null;
  let lastEvent = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event?.type !== 'rate_limit_event' || !event.rate_limit_info) continue;
    lastEvent = event.rate_limit_info;
    if (lastEvent.status === 'rejected') lastRejected = lastEvent;
  }

  if (lastRejected) {
    if (typeof lastRejected.resetsAt === 'number') return lastRejected.resetsAt;
    const typed = lastRejected.unifiedWindows?.[lastRejected.rateLimitType]?.resetsAt;
    return typeof typed === 'number' ? typed : null;
  }
  if (!lastEvent || lastEvent.status !== undefined) return null;

  const lastWindows = lastEvent.unifiedWindows;
  if (!lastWindows || typeof lastWindows !== 'object') return null;

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
