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

const { readTail } = require('../util/fileTail.cjs');

/** Scan the tail of a job's log for a GENUINE rate-limit rejection. Parses the
 *  last 16 KB line by line as JSON (non-JSON / partial lines are skipped) and
 *  returns true only for: (a) a rate_limit_event whose rate_limit_info.status
 *  is 'rejected'; (b) a result event with api_error_status 429; (c) an
 *  is_error result event whose `result` text is the CLI's limit message
 *  ("You've hit your ... limit" / "You've reached your ... limit").
 *
 *  Never substring-match the raw text: informational rate_limit_event lines
 *  (status 'allowed' / 'allowed_warning') carry rateLimitType on every run, so
 *  the old substring match turned any non-zero exit (e.g. a watchdog SIGTERM,
 *  exit 143) into a machine-wide rate_limit pause (2026-10-11 incident: 4-day
 *  pause at 58% weekly). Tool output may also mention 429 or "rate limit". */
function detectRateLimitInLog(logPath) {
  try {
    const text = readTail(logPath, 16384);
    if (!text) return false;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      let ev;
      try { ev = JSON.parse(t); } catch { continue; }
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type === 'rate_limit_event') {
        if (ev.rate_limit_info && ev.rate_limit_info.status === 'rejected') return true;
      } else if (ev.type === 'result') {
        if (ev.api_error_status === 429) return true;
        if (ev.is_error === true && typeof ev.result === 'string'
          && (/You'?ve hit your .*limit/.test(ev.result) || /You'?ve reached your .* limit/.test(ev.result))) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

module.exports = { detectRateLimitInLog };
