'use strict';

/**
 * loadGate.cjs — CPU-load launch gate for the scheduler (PRD 1085).
 *
 * The scheduler already gates launches on free memory (scheduler.cjs's
 * memoryLimitedBatchSize) and on a static per-project cap
 * (schedulerConfig.projectJobCap). Neither sees CPU. Observed 2026-09-01 on
 * starry-night-ships: 4 concurrent executors each running a Godot test
 * battery under its own Xvfb, loadavg 12.95 on 14 cores. Under that
 * contention every 8-minute battery stretches, executors hit their own
 * `timeout`, the verifier files FAIL/FATAL → needs_review → an auto-fix
 * chain with inflated estimates launches MORE batteries. A static cap cannot
 * see that feedback loop; the 1-minute load average can.
 *
 * Gate ordering at the call site (scheduler.cjs tickQueue):
 *   global sessionSlots pool → per-project cap → memory → LOAD (innermost).
 * This is one more predicate inside the existing pick path — never a second
 * pool, and it only WITHHOLDS launches; running jobs are never touched.
 *
 * Everything here is pure and injectable (`loadavg`, `cores`, `now`) so the
 * decision, the audit rate-limit and the escalation are unit-testable without
 * real load or a fake clock hack on `Date`.
 */

const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { loadGateThreshold, JOB_OVERRUN_FLOOR_MS } = require('./schedulerConfig.cjs');

// One audit row per this interval while continuously gated — the poll loop
// ticks every 60 s and a saturated box stays saturated for a while; auditing
// every tick would bury the signal in its own noise.
const AUDIT_INTERVAL_MS = 10 * 60_000;

/**
 * isLoadGated(loadavg1, cores, threshold) → boolean
 *
 * True when the 1-minute load average per core exceeds `threshold`. The 5-
 * and 15-minute averages are deliberately NOT consulted: a finished battery
 * should free launches within a minute or two, not a quarter hour. A
 * threshold of 0 (or anything non-positive) disables the gate. Zero/unknown
 * cores never gates (os.cpus() can be empty in some containers).
 */
function isLoadGated(loadavg1, cores, threshold) {
  if (!(threshold > 0)) return false;
  if (!(cores > 0)) return false;
  if (!Number.isFinite(loadavg1) || loadavg1 <= 0) return false; // [0,0,0] on Windows/unsupported
  return loadavg1 / cores > threshold;
}

/** Best-effort top-N CPU consumers (Linux only). Returns [] anywhere else or on error. */
function topCpuConsumers(n = 3) {
  if (process.platform !== 'linux') return [];
  try {
    const out = execFileSync('ps', ['-eo', 'pid,pcpu,comm', '--sort=-pcpu'], { encoding: 'utf8', timeout: 2000 });
    return out.split('\n').slice(1, 1 + n).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * createLoadGate(opts) → { evaluate, snapshot }
 *
 * Holds the small amount of state the gate needs across ticks (when it was
 * last audited, when the current gated stretch began). `evaluate({ bypass })`
 * returns the decision for THIS tick:
 *   { gated, ratio, threshold, loadavg1, cores, bypassed,
 *     shouldAudit, escalate, gatedSinceMs }
 * - shouldAudit: true at most once per AUDIT_INTERVAL_MS while gated.
 * - escalate: true once the current gated stretch exceeds JOB_OVERRUN_FLOOR_MS
 *   (45 min by default) — the caller warn-logs with topCpuConsumers().
 * - bypassed: `bypass` was set (an explicit human Run now) and the gate would
 *   otherwise have held; the caller launches anyway and logs that it did.
 *
 * `snapshot()` is what buildScheduleStatePayload exposes as `loadGate`.
 */
function createLoadGate({
  loadavg = () => os.loadavg(),
  cores = () => (os.cpus() || []).length,
  now = () => Date.now(),
  threshold = loadGateThreshold,
  auditIntervalMs = AUDIT_INTERVAL_MS,
  escalateAfterMs = JOB_OVERRUN_FLOOR_MS,
} = {}) {
  let lastAuditAt = null; // null = never audited; the first gated tick always audits
  let gatedSince = null;
  let last = null;

  function evaluate({ bypass = false } = {}) {
    const t = now();
    const [l1] = loadavg();
    const c = cores();
    const th = typeof threshold === 'function' ? threshold() : threshold;
    const ratio = c > 0 && Number.isFinite(l1) ? l1 / c : 0;
    const wouldGate = isLoadGated(l1, c, th);

    if (wouldGate) {
      if (gatedSince === null) gatedSince = t;
    } else {
      gatedSince = null;
    }
    const gated = wouldGate && !bypass;
    const bypassed = wouldGate && bypass;

    let shouldAudit = false;
    if (gated && (lastAuditAt === null || t - lastAuditAt >= auditIntervalMs)) {
      shouldAudit = true;
      lastAuditAt = t;
    }
    const gatedSinceMs = gatedSince === null ? 0 : t - gatedSince;
    const escalate = gated && gatedSinceMs >= escalateAfterMs;

    last = {
      gated,
      bypassed,
      ratio: Number(ratio.toFixed(3)),
      threshold: th,
      loadavg1: Number.isFinite(l1) ? Number(l1.toFixed(2)) : null,
      cores: c,
      gatedSinceMs,
      at: new Date(t).toISOString(),
    };
    return { ...last, shouldAudit, escalate };
  }

  function snapshot() {
    return last;
  }

  return { evaluate, snapshot };
}

module.exports = { isLoadGated, createLoadGate, topCpuConsumers, AUDIT_INTERVAL_MS };
