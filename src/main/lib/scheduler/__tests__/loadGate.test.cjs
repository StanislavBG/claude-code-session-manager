'use strict';
// Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/loadGate.test.cjs
//
// PRD 1085 — CPU-load launch gate. The static per-project cap
// (schedulerBatchProjectCap.test.cjs) cannot see the feedback loop observed
// 2026-09-01 on starry-night-ships: 4 Godot test batteries under Xvfb,
// loadavg 12.95 / 14 cores = 0.93, every battery stretching past its
// executor's timeout and spawning fix-chain reruns that launch more
// batteries. These tests pin the pure decision, the audit rate-limit and the
// escalation, with loadavg/cores/clock all injected.
const assert = require('node:assert/strict');
const { isLoadGated, createLoadGate, topCpuConsumers, AUDIT_INTERVAL_MS, SATURATED_BUSY } = require('../loadGate.cjs');
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

const NO_CPU = { observe() {}, sample: () => null };
const cpuAt = (busyFraction, iowaitFraction = 0) => ({ observe() {}, sample: () => ({ busyFraction, iowaitFraction, windowMs: 61_000 }) });

function gateWith({ l1 = 12.95, l5 = 0, l15 = 0, cores = 14, threshold = 0.85, clock, cpu = NO_CPU }) {
  let t = clock ?? 0;
  const g = createLoadGate({
    loadavg: () => [l1, l5, l15],
    cores: () => cores,
    now: () => t,
    threshold,
    cpu,
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

function clockGate(opts = {}) {
  const state = { l1: 12.95, t: 0 };
  const g = createLoadGate({
    loadavg: () => [state.l1, 0, 0],
    cores: () => 14,
    now: () => state.t,
    threshold: 0.85,
    ...opts,
  });
  return { g, state };
}

test('heldMs: first gated tick adds 0, later gated ticks add the gap', () => {
  const { g, state } = clockGate();
  assert.equal(g.evaluate().heldMs, 0);
  state.t += 60_000;
  assert.equal(g.evaluate().heldMs, 60_000);
  state.t += 60_000;
  assert.equal(g.evaluate().heldMs, 120_000);
});

test('a launch ends the hold: a non-holding evaluate() resets heldMs to 0', () => {
  const { g, state } = clockGate();
  g.evaluate();
  state.t += 60_000;
  assert.equal(g.evaluate().heldMs, 60_000);
  state.l1 = 1; state.t += 60_000;
  const r = g.evaluate();
  assert.equal(r.gated, false);
  assert.equal(r.heldMs, 0, 'a non-holding tick reports 0');
  g.endHold(); // tickBody calls this once a spawn was issued
  state.l1 = 12.95; state.t += 60_000;
  assert.equal(g.evaluate().heldMs, 0, 'a fresh hold starts from zero');
});

test('a non-holding evaluate() does not clear the clock; only endHold() does', () => {
  const { g, state } = clockGate();
  g.evaluate();
  state.t += 60_000;
  assert.equal(g.evaluate().heldMs, 60_000);
  state.l1 = 1; state.t += 60_000;
  assert.equal(g.evaluate().heldMs, 0);
  state.l1 = 12.95; state.t += 60_000;
  assert.equal(g.evaluate().heldMs, 180_000, 'clock survived the low tick (gap credited, capped at 2 min)');
  g.endHold();
  state.t += 60_000;
  assert.equal(g.evaluate().heldMs, 0);
});

test('a backward clock step cannot shrink heldMs', () => {
  const { g, state } = clockGate();
  g.evaluate();
  state.t += 60_000;
  assert.equal(g.evaluate().heldMs, 60_000);
  state.t -= 10 * 60_000;
  assert.equal(g.evaluate().heldMs, 60_000);
});

test('a hovering box: low ticks launch, so heldMs never exceeds one tick', () => {
  const SEQUENCE = [11.07, 13.31, 11.51, 12.8];
  const { g, state } = clockGate();
  for (let i = 0; i < 50; i += 1) {
    state.l1 = SEQUENCE[i % SEQUENCE.length];
    const r = g.evaluate();
    assert.ok(r.heldMs <= 60_000, `heldMs ${r.heldMs} exceeded one tick`);
    if (!r.gated) g.endHold(); // the low tick launches, so tickBody ends the hold
    assert.equal(r.yielded, false);
    state.t += 60_000;
  }
});

test('holdCreditCapMs caps the credit for a long gap between gated ticks', () => {
  const { g, state } = clockGate();
  g.evaluate();
  state.t += 30 * 60_000;
  assert.equal(g.evaluate().heldMs, 2 * 60_000);
});

test('yield then re-arm: reaching yieldAfterMs yields once, reports heldMs, and needs another full window', () => {
  const { g, state } = clockGate({ yieldAfterMs: 5 * 60_000 });
  g.evaluate();
  let r;
  for (let i = 0; i < 4; i += 1) { state.t += 60_000; r = g.evaluate(); assert.equal(r.yielded, false); assert.equal(r.gated, true); }
  state.t += 60_000;
  r = g.evaluate();
  assert.equal(r.yielded, true);
  assert.equal(r.gated, false);
  assert.equal(r.heldMs, 5 * 60_000);
  state.t += 60_000;
  r = g.evaluate();
  assert.equal(r.yielded, true, 'stays armed until endHold()');
  assert.equal(r.gated, false);
  g.endHold();
  state.t += 60_000;
  r = g.evaluate();
  assert.equal(r.gated, true, 're-armed: holds again');
  assert.equal(r.heldMs, 0);
  assert.equal(r.yielded, false);
});

function cpuOrNull(busy) {
  return { observe() {}, sample: () => (busy === null ? null : { busyFraction: busy, iowaitFraction: 0, windowMs: 61_000 }) };
}

test('SATURATED_BUSY is 0.85', () => {
  assert.equal(SATURATED_BUSY, 0.85);
});

test('46 minutes at 0.95 busy keeps holding and escalates once per window', () => {
  const { g, state } = clockGate({ yieldAfterMs: 45 * 60_000, cpu: cpuOrNull(0.95) });
  g.evaluate();
  let escalations = 0;
  let r;
  for (let i = 0; i < 46; i += 1) {
    state.t += 60_000;
    r = g.evaluate();
    if (r.escalated) escalations += 1;
  }
  assert.equal(r.gated, true);
  assert.equal(r.yielded, false);
  assert.equal(escalations, 1);
  assert.equal(g.snapshot().escalated, undefined, 'escalated stays out of snapshot()');
  // heldMs keeps growing past the limit
  state.t += 60_000;
  assert.ok(g.evaluate().heldMs > 45 * 60_000);
  // a full window later it escalates again
  for (let i = 0; i < 45; i += 1) { state.t += 60_000; r = g.evaluate(); if (r.escalated) escalations += 1; }
  assert.equal(escalations, 2);
  g.endHold();
  assert.equal(g.evaluate().escalated, false);
});

test('46 minutes at 0.6 busy yields without escalating', () => {
  const { g, state } = clockGate({ yieldAfterMs: 45 * 60_000, cpu: cpuOrNull(0.6) });
  g.evaluate();
  let r;
  for (let i = 0; i < 46; i += 1) { state.t += 60_000; r = g.evaluate(); }
  assert.equal(r.yielded, true);
  assert.equal(r.gated, false);
  assert.equal(r.escalated, false);
});

test('46 minutes with a null sample yields', () => {
  const { g, state } = clockGate({ yieldAfterMs: 45 * 60_000, cpu: cpuOrNull(null) });
  g.evaluate();
  let r;
  for (let i = 0; i < 46; i += 1) { state.t += 60_000; r = g.evaluate(); }
  assert.equal(r.yielded, true);
  assert.equal(r.gated, false);
  assert.equal(r.escalated, false);
});

test('win32 never escalates', () => {
  const { g } = clockGate({ platform: 'win32' });
  assert.equal(g.evaluate().escalated, false);
});

test('bypass ends the hold', () => {
  const { g, state } = clockGate();
  g.evaluate();
  state.t += 60_000;
  assert.equal(g.evaluate().heldMs, 60_000);
  state.t += 60_000;
  const r = g.evaluate({ bypass: true });
  assert.equal(r.bypassed, true);
  assert.equal(r.gated, false);
  assert.equal(r.heldMs, 0);
  g.endHold();
  state.t += 60_000;
  assert.equal(g.evaluate().heldMs, 0);
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

test('snapshot() exposes gated, ratio, threshold, loadavg1, cores, heldMs and yielded (what buildScheduleStatePayload surfaces as loadGate)', () => {
  const { g } = gateWith({});
  g.evaluate();
  const s = g.snapshot();
  assert.equal(typeof s.gated, 'boolean');
  assert.equal(typeof s.ratio, 'number');
  assert.equal(typeof s.threshold, 'number');
  assert.equal(typeof s.loadavg1, 'number');
  assert.equal(typeof s.cores, 'number');
  assert.equal(typeof s.heldMs, 'number');
  assert.equal(typeof s.yielded, 'boolean');
});

// ─── CPU sample confirmation ───────────────────────────────────────────────

test('high loadavg with an idle CPU stands down', () => {
  const { g } = gateWith({ cpu: cpuAt(0.13) });
  const r = g.evaluate();
  assert.equal(r.gated, false);
  assert.equal(r.standDown, true);
  assert.equal(r.cpuBusy, 0.13);
  assert.equal(r.cpuWindowMs, 61_000);
  assert.equal(r.shouldAuditStandDown, true);
  assert.equal(g.evaluate().shouldAuditStandDown, false);
});

test('high loadavg with 10% busy and 60% iowait stands down and reports cpuIowait', () => {
  const { g } = gateWith({ cpu: cpuAt(0.1, 0.6) });
  const r = g.evaluate();
  assert.equal(r.gated, false);
  assert.equal(r.standDown, true);
  assert.equal(r.cpuIowait, 0.6);
  assert.equal(g.snapshot().cpuIowait, 0.6);
});

test('cpuIowait is null with no sample and on win32', () => {
  assert.equal(gateWith({}).g.evaluate().cpuIowait, null);
  assert.equal(createLoadGate({ platform: 'win32', cores: () => 4 }).evaluate().cpuIowait, null);
});

test('high loadavg with a busy CPU keeps holding', () => {
  const r = gateWith({ cpu: cpuAt(0.91) }).g.evaluate();
  assert.equal(r.gated, true);
  assert.equal(r.standDown, false);
});

test('a 60% busy middle band still holds', () => {
  const r = gateWith({ cpu: cpuAt(0.6) }).g.evaluate();
  assert.equal(r.gated, true);
  assert.equal(r.standDown, false);
});

test('a null sample keeps the loadavg verdict', () => {
  const r = gateWith({}).g.evaluate();
  assert.equal(r.gated, true);
  assert.equal(r.cpuBusy, null);
  assert.equal(r.cpuWindowMs, null);
  assert.equal(r.standDown, false);
});

test('threshold 0.25 holds at 40% busy (bar is min(threshold, 0.5))', () => {
  const r = gateWith({ threshold: 0.25, cpu: cpuAt(0.4) }).g.evaluate();
  assert.equal(r.gated, true);
  assert.equal(r.standDown, false);
});

test('observe() feeds the sampler except on win32; snapshot carries the cpu fields', () => {
  let n = 0;
  const cpu = { observe() { n++; }, sample: () => null };
  createLoadGate({ loadavg: () => [1, 0, 0], cores: () => 4, cpu }).observe();
  createLoadGate({ platform: 'win32', cpu }).observe();
  assert.equal(n, 1);
  const w = createLoadGate({ platform: 'win32', cores: () => 4, cpu });
  const r = w.evaluate();
  assert.deepEqual([r.cpuBusy, r.cpuWindowMs, r.standDown, r.shouldAuditStandDown], [null, null, false, false]);
  const { g } = gateWith({ cpu: cpuAt(0.2) });
  g.evaluate();
  assert.equal(g.snapshot().standDown, true);
});

test('saturated is a per-tick flag: true at 0.95, false at 0.6, false with no sample, true at 0.4 with threshold 0.25', () => {
  assert.equal(gateWith({ cpu: cpuAt(0.95) }).g.evaluate().saturated, true);
  assert.equal(gateWith({ cpu: cpuAt(0.6) }).g.evaluate().saturated, false);
  assert.equal(gateWith({}).g.evaluate().saturated, false);
  assert.equal(gateWith({ threshold: 0.25, cpu: cpuAt(0.4) }).g.evaluate().saturated, true);
});

test('saturated stays out of snapshot() and is false on win32', () => {
  const { g } = gateWith({ cpu: cpuAt(0.95) });
  g.evaluate();
  assert.equal('saturated' in g.snapshot(), false);
  const w = createLoadGate({ platform: 'win32', cores: () => 4, cpu: cpuAt(0.95) });
  assert.equal(w.evaluate({ bypass: true }).saturated, false);
});

test('isSaturated: true at 0.95, false at 0.6 / no sample / threshold 0 / win32; leaves heldMs alone', () => {
  assert.equal(gateWith({ cpu: cpuAt(0.95) }).g.isSaturated(), true);
  assert.equal(gateWith({ cpu: cpuAt(0.6) }).g.isSaturated(), false);
  assert.equal(gateWith({}).g.isSaturated(), false);
  assert.equal(gateWith({ threshold: 0, cpu: cpuAt(0.95) }).g.isSaturated(), false);
  assert.equal(createLoadGate({ platform: 'win32', cores: () => 4, cpu: cpuAt(0.95) }).isSaturated(), false);
  const { g } = gateWith({ cpu: cpuAt(0.95) });
  const before = g.evaluate().heldMs;
  g.isSaturated();
  g.isSaturated();
  assert.equal(g.snapshot().heldMs, before);
});
