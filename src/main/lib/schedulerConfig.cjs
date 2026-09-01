const sessionSlots = require('./sessionSlots.cjs');

// The global sessionSlots pool (default 5, [0,10]) is machine-wide and
// project-blind: all of it can land on one project. Measured 2026-08-31 in a
// sibling project — 4 concurrent executors, loadavg 25.89/14 cores, one test
// process pinned at 522% CPU for 30 minutes — CPU contention silently
// downgraded that project's own timing-sensitive test gate into a no-op
// ("CONTENDED ... load/core 1.92 > 0.50"). This is an INNER constraint layered
// under the existing pool (schedulerBatch.cjs's pickForProject), never a
// second pool — sessionSlots.acquire() in spawnJob is untouched and remains
// the outer limit. Override with SM_PROJECT_JOB_CAP (integer, clamped to
// [1, sessionSlots.MAX_SLOTS]).
const DEFAULT_PROJECT_JOB_CAP = 2;

/** Per-project concurrent-job cap. `cwd` is accepted for future per-project
 * tuning; today every project shares the same default/env-overridden value. */
function projectJobCap(cwd) { // eslint-disable-line no-unused-vars
  if (process.env.SM_PROJECT_JOB_CAP !== undefined) {
    const parsed = parseInt(process.env.SM_PROJECT_JOB_CAP, 10);
    if (Number.isFinite(parsed)) {
      return Math.min(sessionSlots.MAX_SLOTS, Math.max(1, parsed));
    }
  }
  return DEFAULT_PROJECT_JOB_CAP;
}

module.exports = {
  DEFAULT_PROJECT_JOB_CAP,
  projectJobCap,
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
  // Cadence for the in-app intraday refresher that keeps TODAY's History
  // rollup line current (see historyAggregator.cjs's refreshIntradayToday).
  // Cheap: LRU-warm live parse, no full transcript re-read.
  HISTORY_INTRADAY_REFRESH_MS: 5 * 60_000,
  // A 'quarantined' PRD (no createdVia provenance) sitting un-adopted past
  // this age is escalated: warn-logged naming project + slug + age, and
  // surfaced distinctly on Home (see homeNeedsYou.ts's matching constant)
  // so it cannot be stranded indefinitely with nothing looking at it — see
  // findStaleQuarantinedJobs in scheduler.cjs. Overridable via
  // SM_QUARANTINE_ESCALATE_HOURS for testing/tuning.
  QUARANTINE_ESCALATE_MS: 24 * 60 * 60_000,

  // A RUNNING job that has overrun its own PRD's `estimateMinutes` by this
  // factor is escalated. Distinct from MAX_JOB_DURATION_MS (4h), which is a
  // deadman kill: a 20-minute PRD still running at 3h is 9x over estimate but
  // comfortably under the deadman, and if it keeps writing to its log the
  // 20-minute IDLE_OUTPUT_KILL_MS watchdog never fires either — so before
  // this, the ONLY signal was a human happening to notice. This escalates,
  // it does NOT kill: overrunning is evidence of trouble, not proof of it,
  // and killing on an estimate would murder legitimately-slow work.
  // Override with SM_JOB_OVERRUN_FACTOR.
  JOB_OVERRUN_FACTOR: 3,
  // Floor so a tiny estimate can't escalate almost immediately — a 5-minute
  // PRD at 3x is 15 minutes, which is noise. Override with
  // SM_JOB_OVERRUN_FLOOR_MINUTES.
  JOB_OVERRUN_FLOOR_MS: 45 * 60_000,

  // A 'running' row with no runtime.pid recorded (spawnJob's status:running
  // mutate at scheduler.cjs:~3524 landed, but the pid-bearing runtime={}
  // mutate that follows executeJob's spawn callback never did — the spawn
  // itself never got far enough to produce a pid) is presumed dead once it
  // is older than this. Must comfortably exceed the longest observed gap
  // between those two mutates; the 2026-09-01 repro sat pidless for 464
  // minutes with an empty run dir, so 10 minutes is a wide margin above any
  // legitimate spawn-in-flight window, not a tight one.
  PIDLESS_SPAWN_GRACE_MS: 10 * 60_000,
};
