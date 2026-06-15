'use strict';

// Run: timeout 120 node --test scripts/__tests__/watchdog-reconcile.test.cjs

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// We need to load watchdogHelpers — it requires reaperHelpers which reads
// /proc/<pid>/cmdline. We'll stub reaperHelpers from within the test by
// manipulating the require cache before loading watchdogHelpers.

function makeRunDir(base, runId, slug, logContent) {
  const dir = path.join(base, 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.log`), logContent ?? '');
  return dir;
}

function makeQueue(base, jobs) {
  const queuePath = path.join(base, 'queue.json');
  fs.writeFileSync(queuePath, JSON.stringify({ version: 1, jobs, paused: null }, null, 2));
  return queuePath;
}

function makeHeartbeat(base, tsMs, extra = {}) {
  const hbPath = path.join(base, 'heartbeat.log');
  fs.writeFileSync(hbPath, JSON.stringify({ ts: tsMs, ...extra }) + '\n');
  return hbPath;
}

function readQueue(base) {
  return JSON.parse(fs.readFileSync(path.join(base, 'queue.json'), 'utf8'));
}

function hasTmp(base) {
  return fs.readdirSync(base).some(f => f.startsWith('queue.json.tmp-'));
}

// Monkey-patch helper: temporarily install fake reaperHelpers in the module cache.
function withFakeReaper({ pidAlive, outcome }, watchdogHelpersPath, fn) {
  const fakeReaperPath = path.resolve(
    path.dirname(watchdogHelpersPath),
    '../../src/main/lib/reaperHelpers.cjs',
  );
  const originalEntry = require.cache[watchdogHelpersPath];
  const originalReaper = require.cache[fakeReaperPath];

  // Install fake reaper
  require.cache[fakeReaperPath] = {
    id: fakeReaperPath,
    filename: fakeReaperPath,
    loaded: true,
    exports: {
      claudePidAlive: () => pidAlive,
      classifyRunOutcome: () => outcome,
    },
  };

  // Force-reload watchdogHelpers with the fake reaper in place.
  delete require.cache[watchdogHelpersPath];
  const helpers = require(watchdogHelpersPath);

  try {
    return fn(helpers);
  } finally {
    // Restore original cache entries.
    if (originalEntry) {
      require.cache[watchdogHelpersPath] = originalEntry;
    } else {
      delete require.cache[watchdogHelpersPath];
    }
    if (originalReaper) {
      require.cache[fakeReaperPath] = originalReaper;
    } else {
      delete require.cache[fakeReaperPath];
    }
  }
}

const WATCHDOG_HELPERS = path.resolve(__dirname, '../lib/watchdogHelpers.cjs');

// ── (a) fresh heartbeat → queue.json byte-identical (no-op) ─────────────────
test('fresh heartbeat → queue.json untouched (no-op)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-'));
  try {
    const job = {
      slug: 'test-job', status: 'running', runId: 'run-001',
      runtime: { pid: 9999999 }, orphanRetries: 0,
      startedAt: new Date().toISOString(), finishedAt: null,
    };
    const queuePath = makeQueue(base, [job]);
    const beforeBytes = fs.readFileSync(queuePath);

    // Fresh heartbeat (just now)
    const hbPath = makeHeartbeat(base, Date.now());

    withFakeReaper({ pidAlive: false, outcome: 'no_result' }, WATCHDOG_HELPERS, (helpers) => {
      helpers.reconcileQueueOffline({
        heartbeatPath: hbPath,
        maxAgeMs: 180_000,
        queuePath,
        runsDir: path.join(base, 'runs'),
      });
    });

    const afterBytes = fs.readFileSync(queuePath);
    assert.deepEqual(beforeBytes, afterBytes, 'queue.json must be byte-identical after fresh no-op');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── (b) stale + running job with dead PID + no success in log → pending ──────
test('stale + dead PID + no_result log → re-queued to pending, orphanRetries===1', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-'));
  try {
    const job = {
      slug: 'test-job', status: 'running', runId: 'run-001',
      runtime: { pid: 9999999 }, orphanRetries: 0,
      startedAt: new Date().toISOString(), finishedAt: null,
      exitCode: null, error: null,
    };
    makeRunDir(base, 'run-001', 'test-job', '{"type":"assistant","message":"working"}\n');
    const queuePath = makeQueue(base, [job]);

    // Stale heartbeat (10 min old)
    const hbPath = makeHeartbeat(base, Date.now() - 10 * 60 * 1000);

    withFakeReaper({ pidAlive: false, outcome: 'no_result' }, WATCHDOG_HELPERS, (helpers) => {
      helpers.reconcileQueueOffline({
        heartbeatPath: hbPath,
        maxAgeMs: 180_000,
        queuePath,
        runsDir: path.join(base, 'runs'),
      });
    });

    const q = readQueue(base);
    const j = q.jobs[0];
    assert.equal(j.status, 'pending', 'job should be re-queued to pending');
    assert.equal(j.orphanRetries, 1, 'orphanRetries should be 1');
    assert.equal(j.runtime, undefined, 'runtime should be deleted');
    assert.equal(j.runId, null, 'runId should be null after re-queue');
    assert.equal(j.startedAt, null, 'startedAt should be null after re-queue');
    assert.equal(hasTmp(base), false, 'no .tmp- sibling left behind');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── (c) stale + running job whose log shows result:success → completed ────────
test('stale + success log → completed', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-'));
  try {
    const job = {
      slug: 'test-job', status: 'running', runId: 'run-002',
      runtime: { pid: 9999999 }, orphanRetries: 0,
      startedAt: new Date().toISOString(), finishedAt: null,
      exitCode: null, error: null,
    };
    makeRunDir(base, 'run-002', 'test-job',
      '{"type":"result","subtype":"success","is_error":false}\n');
    const queuePath = makeQueue(base, [job]);

    const hbPath = makeHeartbeat(base, Date.now() - 10 * 60 * 1000);

    withFakeReaper({ pidAlive: false, outcome: 'success' }, WATCHDOG_HELPERS, (helpers) => {
      helpers.reconcileQueueOffline({
        heartbeatPath: hbPath,
        maxAgeMs: 180_000,
        queuePath,
        runsDir: path.join(base, 'runs'),
      });
    });

    const q = readQueue(base);
    const j = q.jobs[0];
    assert.equal(j.status, 'completed', 'job should be marked completed');
    assert.equal(j.exitCode, 0, 'exitCode should be 0');
    assert.equal(j.error, null, 'error should be null');
    assert.ok(j.finishedAt, 'finishedAt should be set');
    assert.equal(j.runtime, undefined, 'runtime should be deleted');
    assert.equal(hasTmp(base), false, 'no .tmp- sibling left behind');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── (d) no .tmp left in the dir ──────────────────────────────────────────────
test('no .tmp- sibling files left after reconcile (already covered in b+c, explicit check)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-'));
  try {
    const job = {
      slug: 'test-job', status: 'running', runId: 'run-003',
      runtime: { pid: 9999999 }, orphanRetries: 0,
      startedAt: new Date().toISOString(), finishedAt: null,
      exitCode: null, error: null,
    };
    makeRunDir(base, 'run-003', 'test-job', '');
    const queuePath = makeQueue(base, [job]);

    const hbPath = makeHeartbeat(base, Date.now() - 10 * 60 * 1000);

    withFakeReaper({ pidAlive: false, outcome: 'unknown' }, WATCHDOG_HELPERS, (helpers) => {
      helpers.reconcileQueueOffline({
        heartbeatPath: hbPath,
        maxAgeMs: 180_000,
        queuePath,
        runsDir: path.join(base, 'runs'),
      });
    });

    // Verify no tmp files remain
    const files = fs.readdirSync(base);
    const tmpFiles = files.filter(f => f.startsWith('queue.json.tmp-'));
    assert.equal(tmpFiles.length, 0, `tmp files found: ${tmpFiles.join(', ')}`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── bonus: stale + alive PID → SIGTERM sent, then re-queued ─────────────────
test('stale + alive PID → SIGTERM attempt, then outcome classification', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-'));
  try {
    const job = {
      slug: 'test-job', status: 'running', runId: 'run-004',
      runtime: { pid: 9999999 }, orphanRetries: 0,
      startedAt: new Date().toISOString(), finishedAt: null,
      exitCode: null, error: null,
    };
    makeRunDir(base, 'run-004', 'test-job', '');
    const queuePath = makeQueue(base, [job]);

    const hbPath = makeHeartbeat(base, Date.now() - 10 * 60 * 1000);

    withFakeReaper({ pidAlive: true, outcome: 'no_result' }, WATCHDOG_HELPERS, (helpers) => {
      // Should not throw even though kill(9999999) will ESRCH — just ignored
      helpers.reconcileQueueOffline({
        heartbeatPath: hbPath,
        maxAgeMs: 180_000,
        queuePath,
        runsDir: path.join(base, 'runs'),
      });
    });

    const q = readQueue(base);
    const j = q.jobs[0];
    // Should still be re-queued since outcome is no_result
    assert.equal(j.status, 'pending');
    assert.equal(j.orphanRetries, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── PID liveness guard: stale heartbeat + live app pid → NO reap ─────────────
test('stale heartbeat + live app pid → reconcileQueueOffline is a no-op (no SIGTERM of job pid)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-'));
  try {
    const job = {
      slug: 'test-job', status: 'running', runId: 'run-live-app',
      runtime: { pid: 9999999 }, orphanRetries: 0,
      startedAt: new Date().toISOString(), finishedAt: null,
      exitCode: null, error: null,
    };
    makeRunDir(base, 'run-live-app', 'test-job', '');
    const queuePath = makeQueue(base, [job]);
    const beforeBytes = fs.readFileSync(queuePath);

    // Stale heartbeat (10 min old) but stamped with OUR OWN pid — guaranteed alive.
    const hbPath = makeHeartbeat(base, Date.now() - 10 * 60 * 1000, { pid: process.pid });

    // reaperHelpers stub is irrelevant here — the PID guard fires before we reach it.
    withFakeReaper({ pidAlive: true, outcome: 'no_result' }, WATCHDOG_HELPERS, (helpers) => {
      const result = helpers.reconcileQueueOffline({
        heartbeatPath: hbPath,
        maxAgeMs: 180_000,
        queuePath,
        runsDir: path.join(base, 'runs'),
      });
      assert.equal(result.reconciled, false, 'should be a no-op');
      assert.equal(result.reapedCount, 0, 'reapedCount must be 0');
    });

    // queue.json must be byte-identical — job PID must NOT have been SIGTERMed via fake reaper
    const afterBytes = fs.readFileSync(queuePath);
    assert.deepEqual(beforeBytes, afterBytes, 'queue.json must be byte-identical — no reap occurred');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── PID liveness guard: stale heartbeat + dead app pid → reap proceeds ───────
test('stale heartbeat + dead app pid → reconcileQueueOffline reaps normally', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-'));
  try {
    // Use a pid that is guaranteed not running — PID 1 is init/systemd, not a claude process.
    // We need a pid that process.kill(pid, 0) will throw ESRCH for.
    // Use a very large non-existent pid.
    const deadAppPid = 9999998;
    const job = {
      slug: 'test-job', status: 'running', runId: 'run-dead-app',
      runtime: { pid: 9999997 }, orphanRetries: 0,
      startedAt: new Date().toISOString(), finishedAt: null,
      exitCode: null, error: null,
    };
    makeRunDir(base, 'run-dead-app', 'test-job',
      '{"type":"result","subtype":"success","is_error":false}\n');
    const queuePath = makeQueue(base, [job]);

    // Stale heartbeat with a dead app pid.
    const hbPath = makeHeartbeat(base, Date.now() - 10 * 60 * 1000, { pid: deadAppPid });

    withFakeReaper({ pidAlive: false, outcome: 'success' }, WATCHDOG_HELPERS, (helpers) => {
      const result = helpers.reconcileQueueOffline({
        heartbeatPath: hbPath,
        maxAgeMs: 180_000,
        queuePath,
        runsDir: path.join(base, 'runs'),
      });
      assert.equal(result.reconciled, true, 'should have reconciled');
      assert.equal(result.reapedCount, 1, 'reapedCount must be 1');
    });

    const q = readQueue(base);
    assert.equal(q.jobs[0].status, 'completed', 'job should be marked completed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── PID liveness guard: stale heartbeat + no pid field → legacy fallback ─────
test('stale heartbeat + no pid field → legacy age-only behavior (reaps)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-'));
  try {
    const job = {
      slug: 'test-job', status: 'running', runId: 'run-legacy',
      runtime: { pid: 9999999 }, orphanRetries: 0,
      startedAt: new Date().toISOString(), finishedAt: null,
      exitCode: null, error: null,
    };
    makeRunDir(base, 'run-legacy', 'test-job', '');
    const queuePath = makeQueue(base, [job]);

    // Stale heartbeat with NO pid field (legacy format).
    const hbPath = makeHeartbeat(base, Date.now() - 10 * 60 * 1000); // no extra

    withFakeReaper({ pidAlive: false, outcome: 'no_result' }, WATCHDOG_HELPERS, (helpers) => {
      const result = helpers.reconcileQueueOffline({
        heartbeatPath: hbPath,
        maxAgeMs: 180_000,
        queuePath,
        runsDir: path.join(base, 'runs'),
      });
      assert.equal(result.reconciled, true, 'should reconcile (legacy fallback)');
      assert.equal(result.reapedCount, 1, 'reapedCount must be 1');
    });

    const q = readQueue(base);
    assert.equal(q.jobs[0].status, 'pending', 'job should be re-queued (no_result → pending)');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── orphanRetries exhausted → failed ─────────────────────────────────────────
test('stale + dead PID + orphanRetries at cap → failed', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-'));
  try {
    const ORPHAN_REQUEUE_CAP = 2;
    const job = {
      slug: 'test-job', status: 'running', runId: 'run-005',
      runtime: { pid: 9999999 }, orphanRetries: ORPHAN_REQUEUE_CAP,
      startedAt: new Date().toISOString(), finishedAt: null,
      exitCode: null, error: null,
    };
    makeRunDir(base, 'run-005', 'test-job', '');
    const queuePath = makeQueue(base, [job]);

    const hbPath = makeHeartbeat(base, Date.now() - 10 * 60 * 1000);

    withFakeReaper({ pidAlive: false, outcome: 'no_result' }, WATCHDOG_HELPERS, (helpers) => {
      helpers.reconcileQueueOffline({
        heartbeatPath: hbPath,
        maxAgeMs: 180_000,
        queuePath,
        runsDir: path.join(base, 'runs'),
      });
    });

    const q = readQueue(base);
    const j = q.jobs[0];
    assert.equal(j.status, 'failed', 'should fail when retries exhausted');
    assert.ok(j.finishedAt, 'finishedAt should be set');
    assert.equal(j.runtime, undefined, 'runtime should be deleted');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
