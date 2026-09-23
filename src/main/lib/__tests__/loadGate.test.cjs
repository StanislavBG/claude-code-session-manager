'use strict';
// Run: timeout 120 npx vitest run src/main/lib/__tests__/loadGate.test.cjs
//
// PRD 1085 — CPU-load launch gate. The static per-project cap
// (schedulerBatchProjectCap.test.cjs) cannot see the feedback loop observed
// 2026-09-01 on starry-night-ships: 4 Godot test batteries under Xvfb,
// loadavg 12.95 / 14 cores = 0.93, every battery stretching past its
// executor's timeout and spawning fix-chain reruns that launch more
// batteries. These tests pin the pure decision, the audit rate-limit and the
// escalation, with loadavg/cores/clock all injected.
const assert = require('node:assert/strict');
const { isLoadGated, createLoadGate, topCpuConsumers, AUDIT_INTERVAL_MS } = require('../loadGate.cjs');
const { loadGateThreshold, LOAD_GATE_PER_CORE } = require('../schedulerConfig.cjs');

const ORIGINAL_ENV = process.env.SM_LOAD_GATE_PER_CORE;
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.SM_LOAD_GATE_PER_CORE;
  else process.env.SM_LOAD_GATE_PER_CORE = ORIGINAL_ENV;
});

// ─── isLoadGated ────────────────────────────────────────────────────────────

test('the live incident shape gates: 12.95 / 14 cores = 0.93 > 0.85', () => {
  assert.equal(isLoadGated(12.95, 14, 0.85), true);
});

test('below threshold does not gate', () => {
  assert.equal(isLoadGated(5, 14, 0.85), false);
});

test('exactly AT threshold does not gate (strictly greater)', () => {
  assert.equal(isLoadGated(0.85 * 14, 14, 0.85), false);
});

test('zero cores never gates (unknown topology must not wedge the queue)', () => {
  assert.equal(isLoadGated(100, 0, 0.85), false);
});

test('loadavg [0,0,0] (Windows / unsupported) never gates', () => {
  assert.equal(isLoadGated(0, 14, 0.85), false);
});

test('a disabled threshold (0) never gates regardless of load', () => {
  assert.equal(isLoadGated(1000, 1, 0), false);
});

// ─── loadGateThreshold (env) ────────────────────────────────────────────────

test('default threshold is the documented 0.85', () => {
  delete process.env.SM_LOAD_GATE_PER_CORE;
  assert.equal(LOAD_GATE_PER_CORE, 0.85);
  assert.equal(loadGateThreshold(), 0.85);
});

test('SM_LOAD_GATE_PER_CORE is honored and clamped to [0.25, 4]; 0 disables; garbage falls back', () => {
  process.env.SM_LOAD_GATE_PER_CORE = '1.5';
  assert.equal(loadGateThreshold(), 1.5);
  process.env.SM_LOAD_GATE_PER_CORE = '0.01';
  assert.equal(loadGateThreshold(), 0.25);
  process.env.SM_LOAD_GATE_PER_CORE = '99';
  assert.equal(loadGateThreshold(), 4);
  process.env.SM_LOAD_GATE_PER_CORE = '0';
  assert.equal(loadGateThreshold(), 0);
  process.env.SM_LOAD_GATE_PER_CORE = 'banana';
  assert.equal(loadGateThreshold(), 0.85);
});

// ─── topCpuConsumers: platform-correct ps invocation ───────────────────────
//
// The audit line the scheduler warn-logs when the load gate escalates. Purely
// diagnostic (nothing branches on it) but it was blank on macOS: the code only
// ran the GNU `ps --sort` form, which BSD ps rejects with "illegal option",
// so every Mac logged `top CPU: n/a` exactly when the operator needed to know
// what was saturating the box.

test('Linux uses the GNU ps form (-eo … --sort=-pcpu) and skips the header row', () => {
  const calls = [];
  const fakeExec = (bin, args) => {
    calls.push({ bin, args });
    return 'PID %CPU COMMAND\n  1 90.0 node\n  2 10.0 tsc\n';
  };
  const rows = topCpuConsumers(2, { execImpl: fakeExec, platform: 'linux' });
  assert.deepEqual(calls[0], { bin: 'ps', args: ['-eo', 'pid,pcpu,comm', '--sort=-pcpu'] });
  assert.deepEqual(rows, ['1 90.0 node', '2 10.0 tsc']);
});

test('macOS uses the BSD ps form (-Aco … -r), NOT the GNU --sort that BSD ps rejects', () => {
  const calls = [];
  const fakeExec = (bin, args) => {
    calls.push({ bin, args });
    return '  PID %CPU COMM\n  847 94.4 suggestd\n  443 15.1 WindowServer\n';
  };
  const rows = topCpuConsumers(3, { execImpl: fakeExec, platform: 'darwin' });
  assert.deepEqual(calls[0].args, ['-Aco', 'pid,pcpu,comm', '-r']);
  assert.ok(!calls[0].args.some((a) => String(a).includes('--sort')), 'must not pass the GNU --sort to BSD ps');
  assert.deepEqual(rows, ['847 94.4 suggestd', '443 15.1 WindowServer']);
});

test('an unsupported platform returns [] without ever spawning ps', () => {
  let spawned = false;
  const rows = topCpuConsumers(3, { execImpl: () => { spawned = true; return ''; }, platform: 'win32' });
  assert.deepEqual(rows, []);
  assert.equal(spawned, false);
});

test('a ps failure (throw) degrades to [] rather than propagating — the audit line is best-effort', () => {
  const rows = topCpuConsumers(3, { execImpl: () => { throw new Error('boom'); }, platform: 'darwin' });
  assert.deepEqual(rows, []);
});

// ─── createLoadGate: decision, 1-minute-only, bypass ───────────────────────

function gateWith({ l1 = 12.95, l5 = 0, l15 = 0, cores = 14, threshold = 0.85, clock }) {
  let t = clock ?? 0;
  const g = createLoadGate({
    loadavg: () => [l1, l5, l15],
    cores: () => cores,
    now: () => t,
    threshold,
  });
  return { g, tick: (ms) => { t += ms; } };
}

test('evaluate() gates on the incident shape and reports ratio/threshold', () => {
  const { g } = gateWith({});
  const r = g.evaluate();
  assert.equal(r.gated, true);
  assert.equal(r.bypassed, false);
  assert.equal(r.ratio, 0.925);
  assert.equal(r.threshold, 0.85);
  assert.equal(r.loadavg1, 12.95);
  assert.equal(r.cores, 14);
});

test('only the 1-minute average is consulted — a saturated 5/15-minute history with a quiet last minute launches', () => {
  const { g } = gateWith({ l1: 2, l5: 13, l15: 13 });
  assert.equal(g.evaluate().gated, false);
});

test('an explicit Run now bypasses the gate but records that it did', () => {
  const { g } = gateWith({});
  const r = g.evaluate({ bypass: true });
  assert.equal(r.gated, false);
  assert.equal(r.bypassed, true);
});

test('bypass on an UNgated tick is not reported as a bypass', () => {
  const { g } = gateWith({ l1: 1 });
  const r = g.evaluate({ bypass: true });
  assert.deepEqual([r.gated, r.bypassed], [false, false]);
});

// ─── audit rate limit + escalation (fake clock) ─────────────────────────────

test('audits once, then not again until AUDIT_INTERVAL_MS has elapsed', () => {
  const { g, tick } = gateWith({});
  assert.equal(g.evaluate().shouldAudit, true, 'first gated tick audits');
  tick(60_000);
  assert.equal(g.evaluate().shouldAudit, false, '1 min later: silent');
  tick(AUDIT_INTERVAL_MS - 60_000 - 1);
  assert.equal(g.evaluate().shouldAudit, false, 'just under the interval: silent');
  tick(1);
  assert.equal(g.evaluate().shouldAudit, true, 'at the interval: audits again');
});

test('an ungated tick never audits', () => {
  const { g } = gateWith({ l1: 1 });
  assert.equal(g.evaluate().shouldAudit, false);
});

test('escalates once the gated stretch exceeds the escalation window, and the stretch only resets once load has stayed sub-threshold past the release window', () => {
  let l1 = 12.95;
  let t = 0;
  const g = createLoadGate({
    loadavg: () => [l1, 0, 0],
    cores: () => 14,
    now: () => t,
    threshold: 0.85,
    escalateAfterMs: 45 * 60_000,
    releaseWindowMs: 2 * 60_000,
  });
  assert.equal(g.evaluate().escalate, false);
  t += 44 * 60_000;
  assert.equal(g.evaluate().escalate, false, 'under 45m: no escalation');
  t += 60_000;
  const r = g.evaluate();
  assert.equal(r.escalate, true, 'at 45m: escalates');
  assert.equal(r.gatedSinceMs, 45 * 60_000);
  // A single sub-threshold sample must NOT reset the stretch (the boundary-
  // hovering bug this PRD fixes) — gatedSinceMs keeps growing.
  l1 = 1; t += 60_000;
  const oneMinBelow = g.evaluate();
  assert.equal(oneMinBelow.gated, false, 'gate decision is immediate');
  assert.equal(oneMinBelow.gatedSinceMs, 46 * 60_000, 'stretch not yet released');
  // Load climbs back above threshold before the release window elapses: the
  // stretch was never actually cleared, so it just keeps accumulating.
  l1 = 12.95; t += 30_000;
  assert.equal(g.evaluate().gatedSinceMs, 46 * 60_000 + 30_000, 'stretch survived the brief dip');
  // Now hold sub-threshold continuously past the release window (the window
  // is measured from the first sub-threshold sample of this sustained drop,
  // so it takes a tick to mark that start, then another once the window has
  // actually elapsed).
  l1 = 1; t += 1;
  g.evaluate();
  t += 2 * 60_000;
  assert.equal(g.evaluate().gatedSinceMs, 0, 'sustained sub-threshold load past the release window clears the stretch');
  l1 = 12.95; t += 60_000;
  assert.equal(g.evaluate().gatedSinceMs, 0, 'a fresh stretch starts from zero');
});

test('the gate decision itself is unaffected by hysteresis: a sub-threshold tick is never gated, even mid-stretch', () => {
  let l1 = 12.95;
  let t = 0;
  const g = createLoadGate({
    loadavg: () => [l1, 0, 0],
    cores: () => 14,
    now: () => t,
    threshold: 0.85,
    releaseWindowMs: 5 * 60_000,
  });
  assert.equal(g.evaluate().gated, true);
  l1 = 1; t += 60_000;
  assert.equal(g.evaluate().gated, false, 'below threshold: gated:false immediately, hysteresis notwithstanding');
});

test('snapshot() reflects the last evaluation and is null before any', () => {
  const { g } = gateWith({});
  assert.equal(g.snapshot(), null);
  g.evaluate();
  const s = g.snapshot();
  assert.equal(s.gated, true);
  assert.equal(typeof s.at, 'string');
  assert.equal('shouldAudit' in s, false, 'per-tick flags are not part of the persisted snapshot');
});

test('snapshot() exposes gated, ratio, threshold, loadavg1, cores and gatedSinceMs (what buildScheduleStatePayload surfaces as loadGate)', () => {
  const { g } = gateWith({});
  g.evaluate();
  const s = g.snapshot();
  assert.equal(typeof s.gated, 'boolean');
  assert.equal(typeof s.ratio, 'number');
  assert.equal(typeof s.threshold, 'number');
  assert.equal(typeof s.loadavg1, 'number');
  assert.equal(typeof s.cores, 'number');
  assert.equal(typeof s.gatedSinceMs, 'number');
});

// ─── hysteresis: the real observed boundary-hovering sequence ──────────────

test('a boundary-hovering box (real observed sequence, alternating above/below threshold) grows gatedSinceMs monotonically across 50 simulated minutes and eventually escalates', () => {
  // 14 cores, 0.85/core = 11.9 threshold; loadavg1 observed 2026-09-12
  // oscillating 11.07 - 13.31, straddling the threshold every tick. Before
  // this PRD, the immediate reset on ANY sub-threshold sample meant every
  // one of these ticks reset gatedSince to null and escalate never fired.
  const CORES = 14;
  const THRESHOLD = 0.85;
  const SEQUENCE = [11.07, 13.31, 11.51, 12.8];
  let l1 = SEQUENCE[0];
  let t = 0;
  const g = createLoadGate({
    loadavg: () => [l1, 0, 0],
    cores: () => CORES,
    now: () => t,
    threshold: THRESHOLD,
    escalateAfterMs: 20 * 60_000, // shorter than the 45m default so 50 sim-minutes crosses it
  });

  const TICK_MS = 60_000;
  const TOTAL_MS = 50 * 60_000;
  let prevGatedSinceMs = -1;
  let sawEscalate = false;
  let i = 0;
  for (let elapsed = 0; elapsed < TOTAL_MS; elapsed += TICK_MS) {
    l1 = SEQUENCE[i % SEQUENCE.length];
    i += 1;
    const r = g.evaluate();
    assert.ok(r.gatedSinceMs >= prevGatedSinceMs, `gatedSinceMs must not shrink (was ${prevGatedSinceMs}, now ${r.gatedSinceMs})`);
    prevGatedSinceMs = r.gatedSinceMs;
    if (r.escalate) sawEscalate = true;
    t += TICK_MS;
  }
  assert.equal(sawEscalate, true, 'escalate must fire once the (never-reset) stretch exceeds escalateAfterMs');
});

test('the release window actually releases: sustained sub-threshold load past the window reports gated:false and gatedSinceMs:0 on the next tick', () => {
  let l1 = 13.31;
  let t = 0;
  const g = createLoadGate({
    loadavg: () => [l1, 0, 0],
    cores: () => 14,
    now: () => t,
    threshold: 0.85,
    releaseWindowMs: 2 * 60_000,
  });
  assert.equal(g.evaluate().gated, true);
  l1 = 5;
  t += 1;
  g.evaluate(); // marks the start of the sustained sub-threshold run
  t += 2 * 60_000;
  const r = g.evaluate();
  assert.equal(r.gated, false);
  assert.equal(r.gatedSinceMs, 0);
});
