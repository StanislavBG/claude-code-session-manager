'use strict';

/**
 * rateLimitDetect.cjs — the single source of truth for "did this claude -p
 * log tail show a rate-limit death". Shared by spawnJob() (a still-running
 * process that just exited) and reapDeadRunningJobs()/classifyRunOutcome()
 * (a process the reaper found already dead) — see PRD 1117. Before this,
 * only spawnJob checked this; the reaper had no rate-limit branch at all,
 * so a rate-limited exit that the reaper won the race to finalize got
 * stamped terminal 'failed' instead of retryable 'pending'. There must
 * never be a second, independently-drifting regex set at either call site.
 */

const { readTail } = require('./fileTail.cjs');

/** Scan the tail of a job's log for the canonical rate-limit signal. We look
 *  at the last 16 KB — final result event always lands at the end. Covers
 *  both unified-window rate-limit types (five_hour, seven_day), the raw
 *  429 status, and the two human-readable limit-message phrasings the CLI
 *  emits ("You've hit your limit" / "You've reached your <model> limit"). */
function detectRateLimitInLog(logPath) {
  try {
    const text = readTail(logPath, 16384);
    if (!text) return false;
    return /"rateLimitType":"five_hour"/.test(text)
      || /"rateLimitType":"seven_day"/.test(text)
      || /"api_error_status":429/.test(text)
      || /You'?ve hit your limit/.test(text)
      || /You'?ve reached your .* limit/.test(text);
  } catch {
    return false;
  }
}

module.exports = { detectRateLimitInLog };
