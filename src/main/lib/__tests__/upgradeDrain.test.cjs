'use strict';

// Run: timeout 120 npx vitest run src/main/lib/__tests__/upgradeDrain.test.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ud = require('../upgradeDrain.cjs');

const T0 = Date.parse('2026-09-18T00:00:00Z');
const req = (extra = {}) => ({ reason: 'r', requestedBy: 'u', requestedAt: new Date(T0).toISOString(), ...extra });
const ev = (o) => ud.evaluateDrain({ now: T0 + 1000, ...o }).action;

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-drain-')); }

describe('evaluateDrain state machine', () => {
  test('no request → none', () => {
    assert.equal(ev({ request: null, queueSnapshot: { running: 2 }, drainState: null }), 'none');
  });
  test('pending request, drain not active → pause (even when idle)', () => {
    assert.equal(ev({ request: req(), queueSnapshot: { running: 0, investigating: 0 }, drainState: null }), 'pause');
    assert.equal(ev({ request: req(), queueSnapshot: { running: 3 }, drainState: null }), 'pause');
  });
  test('drain active + running or investigating → wait', () => {
    assert.equal(ev({ request: req(), queueSnapshot: { running: 1, investigating: 0 }, drainState: { active: true } }), 'wait');
    assert.equal(ev({ request: req(), queueSnapshot: { running: 0, investigating: 1 }, drainState: { active: true } }), 'wait');
  });
  test('drain active + zero busy → restart', () => {
    assert.equal(ev({ request: req(), queueSnapshot: { running: 0, investigating: 0 }, drainState: { active: true } }), 'restart');
  });
  test('deadline converts to abort, default 4 h', () => {
    const now = T0 + ud.DEFAULT_DRAIN_DEADLINE_MS;
    assert.equal(ud.DEFAULT_DRAIN_DEADLINE_MS, 4 * 60 * 60_000);
    assert.equal(ud.evaluateDrain({ request: req(), queueSnapshot: { running: 1 }, drainState: { active: true }, now }).action, 'abort');
    assert.equal(ud.evaluateDrain({ request: req(), queueSnapshot: { running: 1 }, drainState: { active: true }, now: now - 1 }).action, 'wait');
    assert.equal(ud.evaluateDrain({ request: req(), queueSnapshot: {}, drainState: { active: true }, now: T0 + 500, deadlineMs: 100 }).action, 'abort');
  });
  test('completed request → none; stale drain without request → abort', () => {
    assert.equal(ev({ request: req({ drainCompletedAt: 'x' }), queueSnapshot: {}, drainState: { active: true } }), 'none');
    assert.equal(ev({ request: null, queueSnapshot: {}, drainState: { active: true } }), 'abort');
  });
  test('a rate-limit pause during a drain does not change the verdict: drain is its own field', () => {
    // evaluateDrain never sees state.paused; a rate_limit pause overwriting
    // `paused` leaves the drain field (and the verdict) untouched.
    const state = { paused: { reason: 'rate_limit' }, drain: { active: true } };
    assert.equal(ev({ request: req(), queueSnapshot: { running: 0, investigating: 0 }, drainState: state.drain }), 'restart');
    assert.equal(ud.effectivePaused(state).reason, 'rate_limit');
    assert.equal(ud.effectivePaused({ paused: null, drain: { active: true } }).reason, 'drain-for-upgrade');
    assert.equal(ud.effectivePaused({ paused: null, drain: null }), null);
  });
});

describe('request file lifecycle', () => {
  test('requestRestart writes atomically and is idempotent while pending', () => {
    const dir = tmp();
    try {
      const file = path.join(dir, 'restart-request.json');
      const a = ud.requestRestart({ reason: 'x', requestedBy: 'user' }, { file, now: T0 });
      const b = ud.requestRestart({ reason: 'y', requestedBy: 'auto' }, { file, now: T0 + 5000 });
      assert.deepEqual(b, a, 'a second request must not reset the deadline');
      assert.deepEqual(fs.readdirSync(dir), ['restart-request.json'], 'no tmp file left behind');
      assert.equal(ud.readRestartRequest(file).requestedBy, 'user');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('stampDrainCompleted marks it; a new request after completion starts fresh', () => {
    const dir = tmp();
    try {
      const file = path.join(dir, 'restart-request.json');
      ud.requestRestart({ reason: 'x', requestedBy: 'u' }, { file, now: T0 });
      assert.ok(ud.stampDrainCompleted(T0 + 1, file).drainCompletedAt);
      const fresh = ud.requestRestart({ reason: 'again', requestedBy: 'u' }, { file, now: T0 + 9 });
      assert.equal(fresh.reason, 'again');
      assert.equal(fresh.drainCompletedAt, undefined);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('abort retires the request file', () => {
    const dir = tmp();
    try {
      const file = path.join(dir, 'restart-request.json');
      ud.requestRestart({ reason: 'x', requestedBy: 'u' }, { file, now: T0 });
      ud.retireRestartRequest(file);
      assert.equal(ud.readRestartRequest(file), null);
      ud.retireRestartRequest(file); // absent → no throw
      // With the request gone, a re-evaluation is 'none' — no abort flap.
      assert.equal(ev({ request: ud.readRestartRequest(file), queueSnapshot: {}, drainState: null }), 'none');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('boot', () => {
  test('clears a leftover drain whose request is complete or gone; keeps a pending one', () => {
    assert.equal(ud.bootDrainAction({ drainState: { active: true }, request: req({ drainCompletedAt: 'x' }) }), 'clear');
    assert.equal(ud.bootDrainAction({ drainState: { active: true }, request: null }), 'clear');
    assert.equal(ud.bootDrainAction({ drainState: { active: true }, request: req() }), 'keep');
    assert.equal(ud.bootDrainAction({ drainState: null, request: req() }), 'none');
  });
});

describe('automatic trigger', () => {
  test('only when both shas are known and differ — never from npm', () => {
    assert.equal(ud.installedBuildDiffers({ running: 'aaa', installed: 'bbb' }), true);
    assert.equal(ud.installedBuildDiffers({ running: 'aaa', installed: 'aaa' }), false);
    assert.equal(ud.installedBuildDiffers({ running: null, installed: 'bbb' }), false);
    assert.equal(ud.installedBuildDiffers({ running: 'aaa', installed: null }), false);
  });
});

describe('queueBusyCount', () => {
  test('counts running + investigating only', () => {
    const jobs = [{ status: 'running' }, { status: 'investigating' }, { status: 'pending' }, { status: 'needs_review' }];
    assert.equal(ud.queueBusyCount(jobs), 2);
    assert.equal(ud.queueBusyCount(jobs, 1), 3);
  });
});

describe('restarting marker', () => {
  test('active until expiry, then lapses', () => {
    const dir = tmp();
    try {
      const file = path.join(dir, 'restarting.json');
      assert.equal(ud.isRestartingMarkerActive({ file, now: T0 }), false);
      ud.markRestarting({ file, now: T0, ttlMs: 1000 });
      assert.equal(ud.isRestartingMarkerActive({ file, now: T0 + 999 }), true);
      assert.equal(ud.isRestartingMarkerActive({ file, now: T0 + 1000 }), false);
      ud.clearRestartingMarker(file);
      assert.equal(ud.isRestartingMarkerActive({ file, now: T0 }), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
