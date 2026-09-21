/**
 * usageCircuit.test.cjs — breaker transitions, jitter bounds, bindingWindow
 * fallback, reset freshness, degraded-budget floor/cap, singleFlight dedup.
 *
 * Run: timeout 300 npx vitest run src/main/lib/__tests__/usageCircuit.test.cjs
 */

'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const {
  createUsageCircuit,
  backoffWithJitter,
  isResetFresh,
  bindingWindow,
  degradedBudget,
  singleFlight,
} = require('../usageCircuit.cjs');

test('state machine: closed -> open after 3 consecutive failures', () => {
  let nowMs = 0;
  const circuit = createUsageCircuit({ now: () => nowMs });
  assert.strictEqual(circuit.state(), 'closed');
  circuit.recordFailure('meter_rate_limited');
  assert.strictEqual(circuit.state(), 'closed');
  circuit.recordFailure('meter_rate_limited');
  assert.strictEqual(circuit.state(), 'closed');
  circuit.recordFailure('meter_rate_limited');
  assert.strictEqual(circuit.state(), 'open');
});

test('open -> half_open after the backoff interval elapses, exactly one probe granted', () => {
  let nowMs = 0;
  const circuit = createUsageCircuit({ now: () => nowMs });
  circuit.recordFailure('a');
  circuit.recordFailure('a');
  circuit.recordFailure('a');
  assert.strictEqual(circuit.state(), 'open');

  nowMs += 10_000; // still inside the (>=15s) minimum backoff window
  assert.strictEqual(circuit.state(), 'open');

  nowMs += 60 * 60 * 1000; // well past any possible backoff interval
  assert.strictEqual(circuit.state(), 'half_open');
  // Re-querying before the probe's result is recorded must not grant a second probe.
  assert.strictEqual(circuit.state(), 'half_open');
});

test('half_open -> closed on a successful probe, resetting backoff', () => {
  let nowMs = 0;
  const circuit = createUsageCircuit({ now: () => nowMs });
  circuit.recordFailure('a');
  circuit.recordFailure('a');
  circuit.recordFailure('a');
  nowMs += 60 * 60 * 1000;
  assert.strictEqual(circuit.state(), 'half_open');
  circuit.recordSuccess({ five_hour: { utilization: 10, resets_at: null } });
  assert.strictEqual(circuit.state(), 'closed');
});

test('half_open -> open on a failed probe, with backoff doubled (probe takes longer to reopen)', () => {
  let nowMs = 0;
  const circuit = createUsageCircuit({ now: () => nowMs });
  circuit.recordFailure('a');
  circuit.recordFailure('a');
  circuit.recordFailure('a');
  nowMs += 60 * 60 * 1000;
  assert.strictEqual(circuit.state(), 'half_open');
  circuit.recordFailure('a');
  assert.strictEqual(circuit.state(), 'open');
  nowMs += 25_000; // below the doubled 2nd-stage backoff's own 30s floor
  assert.strictEqual(circuit.state(), 'open');
  nowMs += 60 * 60 * 1000;
  assert.strictEqual(circuit.state(), 'half_open');
});

test('backoffWithJitter: 1000 samples stay within [0.5x, 1.0x] of the doubled base, floor 30s / cap 8min', () => {
  for (let i = 0; i < 1000; i++) {
    const first = backoffWithJitter(0);
    assert.ok(first >= 15_000 && first <= 30_000, `first=${first}`);

    const second = backoffWithJitter(30_000);
    assert.ok(second >= 30_000 && second <= 60_000, `second=${second}`);

    const atCap = backoffWithJitter(8 * 60 * 1000);
    assert.ok(atCap >= 4 * 60 * 1000 && atCap <= 8 * 60 * 1000, `atCap=${atCap}`);

    const beyondCap = backoffWithJitter(20 * 60 * 1000); // doubling would exceed the 8min cap
    assert.ok(beyondCap >= 4 * 60 * 1000 && beyondCap <= 8 * 60 * 1000, `beyondCap=${beyondCap}`);
  }
});

test('isResetFresh: past -> false, future -> true, null -> false', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  assert.strictEqual(isResetFresh('2026-09-13T11:59:59Z', now), false); // past
  assert.strictEqual(isResetFresh('2026-09-13T12:00:00Z', now), false); // at now
  assert.strictEqual(isResetFresh('2026-09-13T12:00:01Z', now), true); // future
  assert.strictEqual(isResetFresh(null, now), false);
  assert.strictEqual(isResetFresh(undefined, now), false);
  assert.strictEqual(isResetFresh('not-a-date', now), false);
});

const REAL_LIMITS = [
  { kind: 'session', group: 'session', percent: 6, severity: 'normal', resets_at: '2026-09-22T00:40:00.280514+00:00', scope: null, is_active: false },
  { kind: 'weekly_all', group: 'weekly', percent: 64, severity: 'normal', resets_at: '2026-09-24T17:00:00.280532+00:00', scope: null, is_active: true },
  { kind: 'weekly_scoped', group: 'weekly', percent: 18, severity: 'normal', resets_at: '2026-09-24T17:00:00.280763+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
];

test('bindingWindow: verbatim real payload selects weekly_all 64', () => {
  const payload = {
    five_hour: { utilization: 6, resets_at: '2026-09-22T00:40:00.280514+00:00' },
    seven_day: { utilization: 64, resets_at: '2026-09-24T17:00:00.280532+00:00' },
    limits: REAL_LIMITS,
  };
  assert.deepStrictEqual(bindingWindow(payload), {
    name: 'weekly_all',
    utilization: 64,
    resets_at: '2026-09-24T17:00:00.280532+00:00',
  });
});

test('bindingWindow: max percent wins over is_active (session 95 beats weekly_all 64)', () => {
  const win = bindingWindow({
    limits: [
      { kind: 'session', percent: 95, resets_at: '2026-09-22T00:40:00Z', scope: null, is_active: false },
      { kind: 'weekly_all', percent: 64, resets_at: '2026-09-24T17:00:00Z', scope: null, is_active: true },
    ],
  });
  assert.strictEqual(win.name, 'session');
  assert.strictEqual(win.utilization, 95);
});

test('bindingWindow: is_active breaks a percent tie', () => {
  const win = bindingWindow({
    limits: [
      { kind: 'session', percent: 50, resets_at: null, scope: null, is_active: false },
      { kind: 'weekly_all', percent: 50, resets_at: null, scope: null, is_active: true },
    ],
  });
  assert.strictEqual(win.name, 'weekly_all');
});

test('bindingWindow: a high weekly_scoped entry is never selected', () => {
  const win = bindingWindow({
    limits: [
      { kind: 'session', percent: 6, resets_at: null, scope: null, is_active: false },
      { kind: 'weekly_all', percent: 10, resets_at: null, scope: null, is_active: true },
      { kind: 'weekly_scoped', percent: 99, resets_at: null, scope: { model: { display_name: 'Fable' } }, is_active: false },
    ],
  });
  assert.strictEqual(win.name, 'weekly_all');
  assert.strictEqual(win.utilization, 10);
});

test('bindingWindow: percent over 100 is returned raw, not clamped', () => {
  const win = bindingWindow({ limits: [{ kind: 'session', percent: 112, resets_at: null, scope: null }] });
  assert.strictEqual(win.utilization, 112);
});

test('bindingWindow: null resets_at backfills from the matching flat window', () => {
  const win = bindingWindow({
    five_hour: { utilization: 40, resets_at: '2026-09-22T00:40:00Z' },
    seven_day: { utilization: 5, resets_at: '2026-09-24T17:00:00Z' },
    limits: [
      { kind: 'session', percent: 40, resets_at: null, scope: null },
      { kind: 'weekly_all', percent: 5, resets_at: null, scope: null },
    ],
  });
  assert.strictEqual(win.name, 'session');
  assert.strictEqual(win.resets_at, '2026-09-22T00:40:00Z');
});

test('bindingWindow: limits[] absent falls back to five_hour', () => {
  const payload = { five_hour: { utilization: 42, resets_at: '2026-09-13T15:00:00Z' } };
  const win = bindingWindow(payload);
  assert.strictEqual(win.name, 'five_hour');
  assert.strictEqual(win.utilization, 42);
});

test('bindingWindow: limits[] with only scoped / non-finite entries falls back to five_hour', () => {
  const payload = {
    five_hour: { utilization: 12, resets_at: null },
    limits: [
      { kind: 'weekly_scoped', percent: 81, resets_at: null, scope: { model: { display_name: 'Fable' } } },
      { kind: 'session', resets_at: null, scope: null },
    ],
  };
  const win = bindingWindow(payload);
  assert.strictEqual(win.name, 'five_hour');
  assert.strictEqual(win.utilization, 12);
});

test('degradedBudget: a last-good binding window that genuinely read 0% carries forward as 0, not 100', () => {
  const payload = { five_hour: { utilization: 0, resets_at: null } };
  assert.strictEqual(degradedBudget(payload, {}).utilization, 0);
});

test('degradedBudget: no payload ever received (null/absent) still yields 100, never a blind 0', () => {
  assert.strictEqual(degradedBudget(null, {}).utilization, 100);
  assert.strictEqual(degradedBudget(undefined, {}).utilization, 100);
});

test('degradedBudget: a degraded cycle after a real-shape poll carries forward the real percent (64), not 100', () => {
  const payload = {
    limits: [
      { kind: 'session', percent: 6, resets_at: null, scope: null, is_active: false },
      { kind: 'weekly_all', percent: 64, resets_at: '2026-09-24T17:00:00Z', scope: null, is_active: true },
    ],
  };
  assert.strictEqual(degradedBudget(payload, {}).utilization, 64);
});

test('degradedBudget: carries forward the real last-good BINDING (weekly_all) utilization, e.g. 81%, never 0', () => {
  const payload = {
    five_hour: { utilization: 0, resets_at: null },
    limits: [
      { kind: 'session', is_active: false, percent: 0, resets_at: null, scope: null },
      { kind: 'weekly_all', is_active: true, percent: 81, resets_at: '2026-09-19T00:00:00Z', scope: null },
    ],
  };
  const { utilization } = degradedBudget(payload, {});
  assert.strictEqual(utilization, 81);
});

test('degradedBudget: caps concurrency at 2 regardless of a higher configured cap', () => {
  const payload = { five_hour: { utilization: 30, resets_at: null } };
  const { concurrencyCap } = degradedBudget(payload, { configuredCap: 5 });
  assert.strictEqual(concurrencyCap, 2);
});

test('degradedBudget: respects a configured cap below 2', () => {
  const payload = { five_hour: { utilization: 30, resets_at: null } };
  const { concurrencyCap } = degradedBudget(payload, { configuredCap: 1 });
  assert.strictEqual(concurrencyCap, 1);
});

test('degradedBudget: an executor-observed 429 whose window has not passed pins utilization to 100', () => {
  const payload = { five_hour: { utilization: 5, resets_at: null } };
  const now = Date.parse('2026-09-13T12:00:00Z');
  const { utilization } = degradedBudget(payload, {
    observed429: true,
    resetsAt: '2026-09-13T13:00:00Z', // still in the future
    now,
  });
  assert.strictEqual(utilization, 100);
});

test('degradedBudget: once the 429 window passes, it stops pinning to 100 and falls back to real utilization', () => {
  const payload = { five_hour: { utilization: 5, resets_at: null } };
  const now = Date.parse('2026-09-13T12:00:00Z');
  const { utilization } = degradedBudget(payload, {
    observed429: true,
    resetsAt: '2026-09-13T11:00:00Z', // already passed
    now,
  });
  assert.strictEqual(utilization, 5);
});

test('singleFlight: concurrent callers share the same in-flight promise, fn invoked once', async () => {
  let calls = 0;
  let resolveFn;
  const fn = () => new Promise((resolve) => { resolveFn = resolve; calls += 1; });
  const wrapped = singleFlight(fn);

  const p1 = wrapped();
  const p2 = wrapped();
  assert.strictEqual(p1, p2);
  assert.strictEqual(calls, 1);
  resolveFn('done');
  assert.strictEqual(await p1, 'done');

  const p3 = wrapped();
  assert.notStrictEqual(p3, p1);
  assert.strictEqual(calls, 2);
  resolveFn('done2');
  await p3;
});

test('openedAt: null while closed, stamped the moment it opens, stays stamped through a failed half_open probe, clears on success', () => {
  let nowMs = 1000;
  const circuit = createUsageCircuit({ now: () => nowMs });
  assert.strictEqual(circuit.openedAt(), null);
  circuit.recordFailure('a');
  circuit.recordFailure('a');
  assert.strictEqual(circuit.openedAt(), null); // still closed, 2 of 3
  circuit.recordFailure('a');
  assert.strictEqual(circuit.state(), 'open');
  assert.strictEqual(circuit.openedAt(), 1000);

  nowMs += 60 * 60 * 1000;
  assert.strictEqual(circuit.state(), 'half_open');
  assert.strictEqual(circuit.openedAt(), 1000); // unchanged through the probe

  circuit.recordFailure('a'); // failed probe -> reopens
  assert.strictEqual(circuit.state(), 'open');
  assert.strictEqual(circuit.openedAt(), 1000); // still the ORIGINAL open time, not re-stamped

  circuit.recordSuccess({});
  assert.strictEqual(circuit.openedAt(), null);
});

test('getConsecutiveFailures: tracks failures, resets on success', () => {
  const circuit = createUsageCircuit({ now: () => 0 });
  assert.strictEqual(circuit.getConsecutiveFailures(), 0);
  circuit.recordFailure('a');
  circuit.recordFailure('a');
  assert.strictEqual(circuit.getConsecutiveFailures(), 2);
  circuit.recordSuccess({});
  assert.strictEqual(circuit.getConsecutiveFailures(), 0);
});

test('SM_USAGE_CIRCUIT=0 bypasses the breaker entirely: state stays closed no matter how many failures', () => {
  const prev = process.env.SM_USAGE_CIRCUIT;
  process.env.SM_USAGE_CIRCUIT = '0';
  try {
    const circuit = createUsageCircuit({ now: () => 0 });
    circuit.recordFailure('a');
    circuit.recordFailure('a');
    circuit.recordFailure('a');
    circuit.recordFailure('a');
    assert.strictEqual(circuit.state(), 'closed');
    assert.strictEqual(circuit.openedAt(), null);
  } finally {
    if (prev === undefined) delete process.env.SM_USAGE_CIRCUIT; else process.env.SM_USAGE_CIRCUIT = prev;
  }
});

test('SM_USAGE_DEGRADED_CAP overrides degradedBudget concurrencyCap outright, bypassing min(cap, 2)', () => {
  const prev = process.env.SM_USAGE_DEGRADED_CAP;
  process.env.SM_USAGE_DEGRADED_CAP = '7';
  try {
    const payload = { five_hour: { utilization: 30, resets_at: null } };
    const { concurrencyCap } = degradedBudget(payload, { configuredCap: 2 });
    assert.strictEqual(concurrencyCap, 7);
  } finally {
    if (prev === undefined) delete process.env.SM_USAGE_DEGRADED_CAP; else process.env.SM_USAGE_DEGRADED_CAP = prev;
  }
});

test('singleFlight: de-dupes even when fn rejects, next call gets a fresh attempt', async () => {
  let calls = 0;
  const fn = () => (calls++ === 0 ? Promise.reject(new Error('boom')) : Promise.resolve('ok'));
  const wrapped = singleFlight(fn);

  const p1 = wrapped();
  const p2 = wrapped();
  assert.strictEqual(p1, p2);
  await assert.rejects(p1, /boom/);

  const p3 = wrapped();
  assert.strictEqual(await p3, 'ok');
  assert.strictEqual(calls, 2);
});
