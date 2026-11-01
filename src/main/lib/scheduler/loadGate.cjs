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
const { createCpuSampler } = require('./cpuSample.cjs');

// A high loadavg only keeps holding launches when the measured CPU is NOT mostly
// idle. loadavg counts D-state tasks and short bursts, so it can read high on an
// idle CPU. The bar is 0.5, not 0.85: on SMT and hybrid chips half the logical
// CPUs is already most of the real capacity, and the gate exists to stop test
// batteries stretching past their timeouts (2026-09-01: loadavg 12.95 on 14
// cores), so a machine at 70% busy is not spare capacity. No sample = no
// evidence, so loadavg decides (a broken reader must never disable the gate).
const MOSTLY_IDLE_BUSY = 0.5;

// Three bands by measured CPU busy fraction (with loadavg over threshold):
//   < MOSTLY_IDLE_BUSY (0.5): the gate stands down at once.
//   0.5 .. SATURATED_BUSY (0.85): it holds, and at the yield limit lets ONE job
//     through, because capacity remains.
//   >= SATURATED_BUSY: it keeps holding past the limit and escalates to a human
//     (once per yield window), because launching there is what the gate exists
//     to prevent. A null sample cannot prove saturation, so it yields at the limit.
// Both bars use Math.min(threshold, bar) so a strict threshold stays strict.
const SATURATED_BUSY = 0.85;

// One audit row per this interval while continuously gated — the poll loop
// ticks every 60 s and a saturated box stays saturated for a while; auditing
// every tick would bury the signal in its own noise.
const AUDIT_INTERVAL_MS = 10 * 60_000;

// A gated tick credits at most this much held time. A longer gap between gated
// ticks means slots or memory were the limiter in between (evaluate() runs only
// once they admit a batch), and that time is not this gate's.
const HOLD_CREDIT_CAP_MS = 2 * 60_000;

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

/**
 * Best-effort top-N CPU consumers, for the audit line the scheduler warn-logs
 * when the load gate yields a job or escalates a saturated hold at its limit. Diagnostic only
 * — nothing downstream branches on the result, so it fails to [] rather than
 * throwing. Supported on Linux AND macOS (the two platforms this app targets);
 * [] anywhere else or on any error.
 *
 * The `ps` invocation is platform-specific and NOT interchangeable:
 *  - Linux (GNU/procps): `ps -eo pid,pcpu,comm --sort=-pcpu`. `--sort` is a
 *    GNU long option.
 *  - macOS (BSD ps): has NO `--sort` (`ps: illegal option -- -`, which threw
 *    and left the gate audit logging `top CPU: n/a` on every Mac). BSD sorts
 *    with `-r` (by CPU usage) and takes `-A` for all processes, `-c` for the
 *    executable comm without its path. `ps -Aco pid,pcpu,comm -r` is the
 *    column-and-sort equivalent.
 * Both print a `PID %CPU COMM` header we skip, so downstream parsing is shared.
 * `execImpl` is injected only by the unit test; production uses execFileSync.
 */
function topCpuConsumers(n = 3, { execImpl = execFileSync, platform = process.platform } = {}) {
  let args;
  if (platform === 'linux') {
    args = ['-eo', 'pid,pcpu,comm', '--sort=-pcpu'];
  } else if (platform === 'darwin') {
    args = ['-Aco', 'pid,pcpu,comm', '-r'];
  } else {
    return [];
  }
  try {
    const out = execImpl('ps', args, { encoding: 'utf8', timeout: 2000 });
    return String(out).split('\n').slice(1, 1 + n).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * createLoadGate(opts) → { evaluate, observe, snapshot, endHold }
 *
 * Decision: loadavg over threshold AND the CPU sample not mostly idle (busy
 * fraction >= min(threshold, MOSTLY_IDLE_BUSY)) holds; over threshold with a
 * mostly idle sample stands down (standDown:true); no sample keeps the loadavg
 * verdict. observe() feeds the sampler and must run every tick.
 *
 * Holds the small amount of state the gate needs across ticks (when it was
 * last audited, the time this gate itself has held a batch). `evaluate({ bypass })`
 * returns the decision for THIS tick:
 *   { gated, ratio, threshold, loadavg1, cores, bypassed,
 *     shouldAudit, shouldAuditStandDown, heldMs, yielded, escalated }
 * - shouldAudit: true at most once per AUDIT_INTERVAL_MS while gated.
 * - heldMs: time this gate itself held a batch. Each gated tick adds
 *   max(0, min(gap since previous gated tick, holdCreditCapMs)); only
 *   endHold() resets it (evaluate() never does).
 * - yielded: heldMs reached yieldAfterMs (JOB_OVERRUN_FLOOR_MS, 45 min by
 *   default) AND the CPU is not saturated (busy < min(threshold, SATURATED_BUSY),
 *   or no sample). gated is false, it stays true on later ticks until the caller
 *   calls endHold() after a real launch, and the caller launches one job.
 * - saturated at the limit: gated stays true, yielded false, heldMs keeps
 *   growing, and `escalated` is true at most once per yieldAfterMs of wall clock
 *   (per-tick only, never in snapshot()). endHold() clears that clock.
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
  holdCreditCapMs = HOLD_CREDIT_CAP_MS,
  yieldAfterMs = JOB_OVERRUN_FLOOR_MS,
  platform = process.platform,
  cpu = createCpuSampler(),
} = {}) {
  let lastAuditAt = null; // null = never audited; the first gated tick always audits
  let heldMs = 0;
  let lastHeldAt = null;
  let lastStandDownAuditAt = null;
  let lastEscalatedAt = null;
  let last = null;

  function observe() {
    if (platform !== 'win32') cpu.observe();
  }

  function evaluate({ bypass = false } = {}) {
    const t = now();
    if (platform === 'win32') {
      // os.loadavg() is always [0,0,0] on Windows — the gate is open, not computed.
      last = {
        gated: false,
        bypassed: false,
        ratio: 0,
        threshold: typeof threshold === 'function' ? threshold() : threshold,
        loadavg1: null,
        cpuBusy: null,
        cpuIowait: null,
        cpuWindowMs: null,
        standDown: false,
        cores: cores(),
        heldMs: 0,
        yielded: false,
        reason: 'loadavg-unavailable-win32',
        at: new Date(t).toISOString(),
      };
      return { ...last, shouldAudit: false, shouldAuditStandDown: false, escalated: false };
    }
    const [l1] = loadavg();
    const c = cores();
    const th = typeof threshold === 'function' ? threshold() : threshold;
    const ratio = c > 0 && Number.isFinite(l1) ? l1 / c : 0;
    const sample = cpu.sample();
    const overLoad = isLoadGated(l1, c, th);
    const standDown = overLoad && sample !== null && sample.busyFraction < Math.min(th, MOSTLY_IDLE_BUSY);
    const wouldGate = overLoad && !standDown;

    const holding = wouldGate && !bypass;
    if (holding) {
      if (lastHeldAt !== null) heldMs += Math.max(0, Math.min(t - lastHeldAt, holdCreditCapMs));
      lastHeldAt = t;
    }
    // A yield stays armed until the caller proves a launch with endHold().
    const saturated = sample !== null && sample.busyFraction >= Math.min(th, SATURATED_BUSY);
    const atLimit = holding && heldMs >= yieldAfterMs;
    const yielded = atLimit && !saturated;
    const gated = holding && !yielded;
    let escalated = false;
    if (atLimit && saturated && (lastEscalatedAt === null || t - lastEscalatedAt >= yieldAfterMs)) {
      escalated = true;
      lastEscalatedAt = t;
    }
    const bypassed = wouldGate && bypass;

    let shouldAudit = false;
    if (gated && (lastAuditAt === null || t - lastAuditAt >= auditIntervalMs)) {
      shouldAudit = true;
      lastAuditAt = t;
    }
    let shouldAuditStandDown = false;
    if (standDown && (lastStandDownAuditAt === null || t - lastStandDownAuditAt >= auditIntervalMs)) {
      shouldAuditStandDown = true;
      lastStandDownAuditAt = t;
    }
    last = {
      gated,
      bypassed,
      ratio: Number(ratio.toFixed(3)),
      threshold: th,
      loadavg1: Number.isFinite(l1) ? Number(l1.toFixed(2)) : null,
      cpuBusy: sample ? Number(sample.busyFraction.toFixed(3)) : null,
      cpuIowait: sample ? Number(sample.iowaitFraction.toFixed(3)) : null,
      cpuWindowMs: sample ? sample.windowMs : null,
      standDown,
      cores: c,
      heldMs: holding ? heldMs : 0,
      yielded,
      at: new Date(t).toISOString(),
    };
    return { ...last, shouldAudit, shouldAuditStandDown, escalated };
  }

  // Only the caller knows a launch really happened (or that nothing is waiting
  // on this gate), so only the caller ends a hold.
  function endHold() {
    heldMs = 0;
    lastHeldAt = null;
    lastEscalatedAt = null;
  }

  function snapshot() {
    return last;
  }

  return { evaluate, observe, snapshot, endHold };
}

module.exports = { isLoadGated, createLoadGate, topCpuConsumers, AUDIT_INTERVAL_MS, MOSTLY_IDLE_BUSY, SATURATED_BUSY };
