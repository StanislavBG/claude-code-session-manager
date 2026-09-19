/**
 * scheduler-boot-orphans.test.cjs — boot-time reconciliation of 'running' jobs
 * left behind by an app crash/restart (PRD 686: consolidated in from the
 * external watchdog's reconcileQueueOffline(), which is now deleted from
 * src/main/lib/watchdogHelpers.cjs).
 *
 * Covers:
 *   - a proven-alive row is ADOPTED (left running, never signalled) and only
 *     proven-dead / exited rows are finalized (partitionBootOrphans)
 *   - the ORPHAN_REQUEUE_CAP re-queue/exhaustion boundary (applyOrphanOutcome)
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-boot-orphans.test.cjs
 */

'use strict';

const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  writeSupervisorRecord,
} = require('../lib/jobSupervisorRecord.cjs');
const {
  partitionBootOrphans,
  applyOrphanOutcome,
} = require('../scheduler.cjs');
const { ORPHAN_REQUEUE_CAP } = require('../lib/reaperHelpers.cjs');

function spawnStub() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
}

function withRunsDir(fn) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-boot-runs-'));
  try { return fn(runsDir); } finally { fs.rmSync(runsDir, { recursive: true, force: true }); }
}

test('a running row with a live pid survives boot untouched — adopted, no kill issued', () => {
  const child = spawnStub();
  const killSpy = vi.spyOn(process, 'kill');
  try {
    const jobs = [{ slug: 'alive-orphan', status: 'running', runtime: { pid: child.pid } }];
    const { immediate, adopted } = partitionBootOrphans(jobs, { pidAlive: (pid) => pid === child.pid, runsDir: os.tmpdir() });
    assert.deepEqual(adopted, ['alive-orphan']);
    assert.deepEqual(immediate, []);
    assert.equal(killSpy.mock.calls.length, 0, 'boot classification must never signal an executor');
    assert.equal(jobs[0].status, 'running', 'the row must not transition');
  } finally {
    killSpy.mockRestore();
    child.kill();
  }
});

test('a dead-pid row and a pidless row with no liveness evidence are finalized', () => {
  const jobs = [
    { slug: 'dead-orphan', status: 'running', runtime: { pid: 222 } },
    { slug: 'no-pid-orphan', status: 'running', runtime: {} },
    { slug: 'not-running', status: 'pending' },
  ];
  const { immediate, adopted } = partitionBootOrphans(jobs, { pidAlive: () => false, runsDir: os.tmpdir() });
  assert.deepEqual(immediate.sort(), ['dead-orphan', 'no-pid-orphan']);
  assert.deepEqual(adopted, []);
});

test('a pidless row is adopted on any one of the reaper liveness signals', () => {
  const job = () => ({ slug: 'p', status: 'running', runtime: {} });
  const base = { pidAlive: (pid) => pid === 77, runsDir: os.tmpdir(), now: 1_000_000 };
  assert.deepEqual(partitionBootOrphans([job()], { ...base, getLogMtimeMs: () => 999_000, logFreshWindowMs: 5_000 }).adopted, ['p'], 'fresh log');
  assert.deepEqual(partitionBootOrphans([job()], { ...base, getLogPid: () => 77 }).adopted, ['p'], 'log pid alive');
  assert.deepEqual(partitionBootOrphans([job()], { ...base, findLiveProcess: () => 88 }).adopted, ['p'], '/proc scan');
  assert.deepEqual(partitionBootOrphans([job()], { ...base, getLogMtimeMs: () => 1_000, logFreshWindowMs: 5_000 }).immediate, ['p'], 'stale log');
});

test('a row whose supervisor record says exited is finalized from its meta, not adopted', () => {
  withRunsDir((runsDir) => {
    const runDir = path.join(runsDir, 'run-1');
    fs.mkdirSync(runDir, { recursive: true });
    writeSupervisorRecord({ runDir, slug: 'exited-row', pid: 4242, runId: 'run-1', startedAt: Date.now() });
    fs.writeFileSync(path.join(runDir, 'exited-row.meta.json'), JSON.stringify({ slug: 'exited-row', exitCode: 0 }));
    const job = { slug: 'exited-row', status: 'running', runId: 'run-1', runtime: { pid: 4242 } };
    // Even with the pid reported alive (recycled/lingering), the exit marker wins.
    const { immediate, adopted } = partitionBootOrphans([job], { pidAlive: () => true, runsDir });
    assert.deepEqual(immediate, ['exited-row']);
    assert.deepEqual(adopted, []);
    applyOrphanOutcome(job, 'success');
    assert.equal(job.status, 'completed');
  });
});

test('a record with a live, same-identity pid is adopted; a dead record without an exit marker is finalized', () => {
  withRunsDir((runsDir) => {
    const runDir = path.join(runsDir, 'run-2');
    fs.mkdirSync(runDir, { recursive: true });
    writeSupervisorRecord({ runDir, slug: 'live-rec', pid: 31337, runId: 'run-2', startedAt: Date.now() });
    writeSupervisorRecord({ runDir, slug: 'dead-rec', pid: 31338, runId: 'run-2', startedAt: Date.now() });
    const jobs = [
      { slug: 'live-rec', status: 'running', runId: 'run-2', runtime: { pid: 31337 } },
      { slug: 'dead-rec', status: 'running', runId: 'run-2', runtime: { pid: 31338 } },
    ];
    const { immediate, adopted } = partitionBootOrphans(jobs, { pidAlive: (pid) => pid === 31337, identityOf: () => null, runsDir });
    assert.deepEqual(adopted, ['live-rec']);
    assert.deepEqual(immediate, ['dead-rec']);
  });
});

test('partitionBootOrphans ignores non-running jobs entirely', () => {
  const jobs = [
    { slug: 'a', status: 'completed', runtime: { pid: 1 } },
    { slug: 'b', status: 'failed', runtime: { pid: 2 } },
  ];
  const { immediate, adopted } = partitionBootOrphans(jobs, { pidAlive: () => true, runsDir: os.tmpdir() });
  assert.deepEqual(immediate, []);
  assert.deepEqual(adopted, []);
});

test('applyOrphanOutcome: success finalizes to completed, clears runtime', () => {
  const job = { slug: 's', status: 'running', runtime: { pid: 1 }, exitCode: null };
  applyOrphanOutcome(job, 'success');
  assert.equal(job.status, 'completed');
  assert.equal(job.exitCode, 0);
  assert.equal(job.error, null);
  assert.ok(job.finishedAt);
  assert.equal(job.runtime, undefined);
});

test('applyOrphanOutcome: failed finalizes to failed with orphan note', () => {
  const job = { slug: 's', status: 'running', runtime: { pid: 1 }, exitCode: null };
  applyOrphanOutcome(job, 'failed', ' (orphan pid=1: killed)');
  assert.equal(job.status, 'failed');
  assert.equal(job.exitCode, 1);
  assert.match(job.error, /orphaned: app restarted while running \(orphan pid=1: killed\)/);
  assert.equal(job.runtime, undefined);
});

test('applyOrphanOutcome: no_result re-queues to pending under the cap and increments orphanRetries', () => {
  const job = { slug: 's', status: 'running', runtime: { pid: 1 }, orphanRetries: 0 };
  applyOrphanOutcome(job, 'no_result');
  assert.equal(job.status, 'pending');
  assert.equal(job.orphanRetries, 1);
  assert.match(job.error, /re-queued \(attempt 1/);
  assert.equal(job.runtime, undefined);
});

test('applyOrphanOutcome: no_result at the cap fails terminally instead of re-queuing again', () => {
  const job = { slug: 's', status: 'running', runtime: { pid: 1 }, orphanRetries: ORPHAN_REQUEUE_CAP };
  applyOrphanOutcome(job, 'unknown');
  assert.equal(job.status, 'failed');
  assert.match(job.error, new RegExp(`exhausted ${ORPHAN_REQUEUE_CAP} re-queue attempts`));
  assert.equal(job.runtime, undefined);
});
