module.exports = {
  // Steady-state billing-usage poll cadence (success path). Drives when the
  // `when-available` policy notices the 5h window crossing the utilization
  // threshold — i.e. when to stop (util ≥ threshold) and start (util < threshold)
  // jobs around the 5-hour limit. Reset-time resume is scheduled exactly (not
  // poll-bound), so 10 min only bounds how late we react to utilization drift.
  POLL_INTERVAL_MS: 10 * 60_000,
  POLL_MIN_INTERVAL_MS: 90_000,
  USAGE_REFRESH_INTERVAL_MS: 15_000,
  HTTP_TIMEOUT_MS: 30_000,
  HTTP_RETRY_DELAY_MS: 1_000,
  OFFSET_MINUTES_MAX: 180,
  CONCURRENCY_CAP_MAX: 20,
  MAX_JOB_DURATION_MS: 4 * 60 * 60_000,
  SUPERVISOR_INTERVAL_MS: 15 * 60_000,
  SUPERVISOR_PROBE_STALE_MS: 10 * 60_000,
};
