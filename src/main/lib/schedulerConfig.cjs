module.exports = {
  // Steady-state billing-usage poll cadence (success path). Drives when the
  // `when-available` policy notices the 5h window crossing the utilization
  // threshold — i.e. when to stop (util ≥ threshold) and start (util < threshold)
  // jobs around the 5-hour limit. Reset-time resume is scheduled exactly (not
  // poll-bound), so 1 min only bounds how late we react to utilization drift
  // (e.g. freed host memory unblocking a pending job in another project).
  // Tradeoff accepted: this raises billing.fetchUsage() calls from 6x/hour to
  // 60x/hour against Anthropic's usage endpoint (src/main/usage.cjs) — not a
  // job-execution cost, just a lighter-weight polling GET.
  POLL_INTERVAL_MS: 60_000,
  // Exponential backoff floor for polling retries after transient failures.
  POLL_MIN_INTERVAL_MS: 90_000,
  // Cadence for refreshing the AppStatusBar's 5h-usage chip (billing meter).
  USAGE_REFRESH_INTERVAL_MS: 15_000,
  // Timeout for HTTP requests to Anthropic API (billing endpoint, etc).
  HTTP_TIMEOUT_MS: 30_000,
  HTTP_RETRY_DELAY_MS: 1_000,
  OFFSET_MINUTES_MAX: 180,
  CONCURRENCY_CAP_MAX: 20,
  MAX_JOB_DURATION_MS: 4 * 60 * 60_000,
  SUPERVISOR_INTERVAL_MS: 15 * 60_000,
  SUPERVISOR_PROBE_STALE_MS: 10 * 60_000,
  // Trailing-edge debounce window for schedule:state broadcasts. A burst of
  // mutations (boot reverify healing several rows, poll-loop refreshes,
  // queue-linter fixups) arms one timer and sends a single push with the
  // latest state, instead of one full-payload IPC broadcast per mutation.
  // Lone mutations still arrive promptly (~200ms). State-machine transitions
  // (pause/resume, job start/finish/reap/reset) bypass this via
  // broadcast({ flush: true }).
  BROADCAST_COALESCE_MS: 200,
  // Terminal (completed/failed) jobs older than this move from queue.json's
  // hot jobs[] into the append-only history.jsonl sidecar. See
  // src/main/lib/queueHistory.cjs.
  HISTORY_RETENTION_MS: 7 * 24 * 60 * 60_000,
};
