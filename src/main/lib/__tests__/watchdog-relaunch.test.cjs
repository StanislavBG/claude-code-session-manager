'use strict';

// Run: timeout 120 npx vitest run src/main/lib/__tests__/watchdog-relaunch.test.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  maybeRelaunchApp,
  evaluateDispatchLiveness,
  readLastHeartbeat,
  readRelaunchState,
  DEFAULT_MAX_RELAUNCH_ATTEMPTS,
} = require('../watchdogHelpers.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-relaunch-test-'));
}

function writeHeartbeat(hbPath, tsMs, pid) {
  fs.writeFileSync(hbPath, JSON.stringify({ ts: tsMs, pid }) + '\n');
}

function makeSpawnSpy() {
  const calls = [];
  const fn = (opts) => { calls.push(opts); };
  fn.calls = calls;
  return fn;
}

// heartbeatFresh() reads the real wall clock internally (no injectable `now`),
// so every heartbeat ts below is anchored to actual Date.now() at test start —
// only the `now` passed to maybeRelaunchApp (which drives debounce/cap math)
// is offset from that same anchor.
//
// isPidAlive() treats EPERM (pid exists, owned by another user — e.g. pid 1)
// as alive, so a genuinely-dead pid must actually be gone (ESRCH), not just
// inaccessible. Spawn a short-lived same-user child and use its exited pid —
// guaranteed ESRCH under our own uid, unlike a hardcoded low pid number.
const DEAD_PID = (() => {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return result.pid;
})();

test('fresh heartbeat → no relaunch, no spawn', () => {
  const dir = tmpDir();
  try {
    const hbPath = path.join(dir, 'heartbeat.log');
    const statePath = path.join(dir, 'state.json');
    const now = Date.now();
    writeHeartbeat(hbPath, now - 1_000, DEAD_PID); // 1s old — fresh
    const spawnFn = makeSpawnSpy();

    const result = maybeRelaunchApp({
      heartbeatPath: hbPath,
      maxAgeMs: 180_000,
      statePath,
      now,
      spawnFn,
    });

    assert.equal(result.relaunched, false);
    assert.equal(result.reason, 'alive');
    assert.equal(spawnFn.calls.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stale heartbeat + dead pid → relaunch fires', () => {
  const dir = tmpDir();
  try {
    const hbPath = path.join(dir, 'heartbeat.log');
    const statePath = path.join(dir, 'state.json');
    const now = Date.now();
    writeHeartbeat(hbPath, now - 10 * 60_000, DEAD_PID);
    const spawnFn = makeSpawnSpy();

    const result = maybeRelaunchApp({
      heartbeatPath: hbPath,
      maxAgeMs: 180_000,
      statePath,
      debounceMs: 90_000,
      now,
      spawnFn,
    });

    assert.equal(result.relaunched, true);
    assert.equal(result.attemptCount, 1);
    assert.equal(spawnFn.calls.length, 1);

    const state = readRelaunchState(statePath);
    assert.equal(state.attemptCount, 1);
    assert.equal(state.lastAttemptTs, now);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stale heartbeat but debounce window not elapsed → no relaunch', () => {
  const dir = tmpDir();
  try {
    const hbPath = path.join(dir, 'heartbeat.log');
    const statePath = path.join(dir, 'state.json');
    const now = Date.now();
    writeHeartbeat(hbPath, now - 10 * 60_000, DEAD_PID);

    // First tick: relaunch fires.
    const spawnFn1 = makeSpawnSpy();
    const first = maybeRelaunchApp({
      heartbeatPath: hbPath, maxAgeMs: 180_000, statePath, debounceMs: 90_000, now, spawnFn: spawnFn1,
    });
    assert.equal(first.relaunched, true);

    // Second tick 30s later — inside the 90s debounce window.
    const spawnFn2 = makeSpawnSpy();
    const second = maybeRelaunchApp({
      heartbeatPath: hbPath, maxAgeMs: 180_000, statePath, debounceMs: 90_000, now: now + 30_000, spawnFn: spawnFn2,
    });

    assert.equal(second.relaunched, false);
    assert.equal(second.reason, 'debounce');
    assert.equal(spawnFn2.calls.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('3 failed attempts → stops attempting and logs, no 4th attempt', () => {
  const dir = tmpDir();
  try {
    const hbPath = path.join(dir, 'heartbeat.log');
    const statePath = path.join(dir, 'state.json');
    const logPath = path.join(dir, 'relaunch.log');
    let now = Date.now();
    writeHeartbeat(hbPath, now - 10 * 60_000, DEAD_PID); // stays stale/dead throughout

    let lastResult;
    for (let i = 0; i < DEFAULT_MAX_RELAUNCH_ATTEMPTS; i++) {
      const spawnFn = makeSpawnSpy();
      lastResult = maybeRelaunchApp({
        heartbeatPath: hbPath, maxAgeMs: 180_000, statePath, logPath, debounceMs: 90_000, now, spawnFn,
      });
      assert.equal(lastResult.relaunched, true, `attempt ${i + 1} should relaunch`);
      assert.equal(spawnFn.calls.length, 1);
      now += 100_000; // past the 90s debounce for the next tick
    }

    // 4th tick: capped — must NOT spawn again.
    const spawnFn4 = makeSpawnSpy();
    const fourth = maybeRelaunchApp({
      heartbeatPath: hbPath, maxAgeMs: 180_000, statePath, logPath, debounceMs: 90_000, now, spawnFn: spawnFn4,
    });

    assert.equal(fourth.relaunched, false);
    assert.equal(fourth.reason, 'capped');
    assert.equal(spawnFn4.calls.length, 0);
    assert.equal(fourth.attemptCount, DEFAULT_MAX_RELAUNCH_ATTEMPTS);

    const logContent = fs.readFileSync(logPath, 'utf8');
    assert.match(logContent, /giving up/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('attemptCount resets to 0 once a fresh heartbeat is observed', () => {
  const dir = tmpDir();
  try {
    const hbPath = path.join(dir, 'heartbeat.log');
    const statePath = path.join(dir, 'state.json');
    const now = Date.now();
    writeHeartbeat(hbPath, now - 10 * 60_000, DEAD_PID);

    const spawnFn = makeSpawnSpy();
    maybeRelaunchApp({ heartbeatPath: hbPath, maxAgeMs: 180_000, statePath, debounceMs: 90_000, now, spawnFn });
    assert.equal(readRelaunchState(statePath).attemptCount, 1);

    // App comes back up — fresh heartbeat observed on a later tick, recorded
    // with this test process's own (guaranteed-alive) pid.
    const later = now + 200_000;
    writeHeartbeat(hbPath, later - 1_000, process.pid);
    const result = maybeRelaunchApp({
      heartbeatPath: hbPath, maxAgeMs: 180_000, statePath, debounceMs: 90_000, now: later, spawnFn,
    });

    assert.equal(result.relaunched, false);
    assert.equal(result.reason, 'alive');
    assert.equal(readRelaunchState(statePath).attemptCount, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatch-dead (fresh heartbeat, dead dispatch chain) never relaunches', () => {
  const dir = tmpDir();
  try {
    const hbPath = path.join(dir, 'heartbeat.log');
    const statePath = path.join(dir, 'state.json');
    const now = Date.now();
    fs.writeFileSync(hbPath, JSON.stringify({
      ts: now - 1_000,
      pid: process.pid,
      dispatch: {
        lastDispatchAttemptAt: new Date(now - 1_000).toISOString(),
        lastRunAt: new Date(now - 2 * 60 * 60_000).toISOString(),
        lastTickReason: 'held',
        pendingDispatchable: 5,
        runningCount: 0,
        paused: false,
      },
    }) + '\n');
    assert.equal(evaluateDispatchLiveness(readLastHeartbeat(hbPath), now).dead, true);

    const spawnFn = makeSpawnSpy();
    const result = maybeRelaunchApp({ heartbeatPath: hbPath, maxAgeMs: 180_000, statePath, now, spawnFn });
    assert.equal(result.relaunched, false);
    assert.equal(result.reason, 'alive');
    assert.equal(spawnFn.calls.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── restarting marker (drain-restart exit window) ───────────────────────────

test('stale heartbeat + active restarting marker → no relaunch; expired marker → relaunch', () => {
  const dir = tmpDir();
  try {
    const hbPath = path.join(dir, 'heartbeat.log');
    const statePath = path.join(dir, 'state.json');
    const markerPath = path.join(dir, 'restarting.json');
    const now = Date.now();
    writeHeartbeat(hbPath, now - 10 * 60_000, DEAD_PID);
    fs.writeFileSync(markerPath, JSON.stringify({ pid: DEAD_PID, at: now - 1_000, expiresAt: now + 60_000 }));
    const spawnFn = makeSpawnSpy();

    const held = maybeRelaunchApp({ heartbeatPath: hbPath, maxAgeMs: 180_000, statePath, restartingMarkerPath: markerPath, now, spawnFn });
    assert.equal(held.relaunched, false);
    assert.equal(held.reason, 'restarting');
    assert.equal(spawnFn.calls.length, 0);
    assert.equal(fs.existsSync(statePath), false, 'a held relaunch must not burn an attempt');

    // Bounded lifetime: once the marker expires the watchdog resumes duty.
    const lapsed = maybeRelaunchApp({ heartbeatPath: hbPath, maxAgeMs: 180_000, statePath, restartingMarkerPath: markerPath, now: now + 61_000, spawnFn });
    assert.equal(lapsed.relaunched, true);
    assert.equal(spawnFn.calls.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh heartbeat carrying dispatch.drain is not dispatch-dead', () => {
  const now = Date.now();
  const entry = {
    ts: now - 1_000,
    dispatch: {
      lastRunAt: new Date(now - 5 * 60 * 60_000).toISOString(),
      pendingDispatchable: 5, runningCount: 0, paused: false,
      drain: { since: new Date(now - 60_000).toISOString(), requestedAt: new Date(now - 60_000).toISOString() },
    },
  };
  assert.deepEqual(evaluateDispatchLiveness(entry, now), { dead: false, reason: 'draining' });
});
