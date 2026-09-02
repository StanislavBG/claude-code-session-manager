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
const { isLoadGated, createLoadGate, AUDIT_INTERVAL_MS } = require('../loadGate.cjs');
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

test('escalates once the gated stretch exceeds the escalation window, and the stretch resets when load drops', () => {
  let l1 = 12.95;
  let t = 0;
  const g = createLoadGate({
    loadavg: () => [l1, 0, 0],
    cores: () => 14,
    now: () => t,
    threshold: 0.85,
    escalateAfterMs: 45 * 60_000,
  });
  assert.equal(g.evaluate().escalate, false);
  t += 44 * 60_000;
  assert.equal(g.evaluate().escalate, false, 'under 45m: no escalation');
  t += 60_000;
  const r = g.evaluate();
  assert.equal(r.escalate, true, 'at 45m: escalates');
  assert.equal(r.gatedSinceMs, 45 * 60_000);
  l1 = 1; t += 60_000;
  assert.equal(g.evaluate().gatedSinceMs, 0, 'load dropped: stretch resets');
  l1 = 12.95; t += 60_000;
  assert.equal(g.evaluate().gatedSinceMs, 0, 'a fresh stretch starts from zero');
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
