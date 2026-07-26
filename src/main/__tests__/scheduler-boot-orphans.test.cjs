/**
 * scheduler-boot-orphans.test.cjs — boot-time reconciliation of 'running' jobs
 * left behind by an app crash/restart (PRD 686: consolidated in from the
 * external watchdog's reconcileQueueOffline(), which is now deleted from
 * scripts/lib/watchdogHelpers.cjs).
 *
 * Covers the two behaviors most likely to drift in the move:
 *   - a still-alive orphaned pid must be DEFERRED, never classified from its
 *     (possibly still-being-written) log in the same pass (partitionBootOrphans)
 *   - the ORPHAN_REQUEUE_CAP re-queue/exhaustion boundary (applyOrphanOutcome)
 *
 * Run: timeout 120 node --test src/main/__tests__/scheduler-boot-orphans.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  partitionBootOrphans,
  applyOrphanOutcome,
  feedbackSweepDue,
  FEEDBACK_SWEEP_TICK_INTERVAL,
  sweepFeedback,
} = require('../scheduler.cjs');
const { ORPHAN_REQUEUE_CAP } = require('../lib/reaperHelpers.cjs');

test('partitionBootOrphans defers a running job whose pid is still alive', () => {
  const jobs = [
    { slug: 'alive-orphan', status: 'running', runtime: { pid: 111 } },
    { slug: 'dead-orphan', status: 'running', runtime: { pid: 222 } },
    { slug: 'no-pid-orphan', status: 'running', runtime: {} },
    { slug: 'not-running', status: 'pending' },
  ];
  const isAlive = (pid) => pid === 111;

  const { immediate, deferred } = partitionBootOrphans(jobs, isAlive);

  assert.deepEqual(deferred, ['alive-orphan']);
  assert.deepEqual(immediate.sort(), ['dead-orphan', 'no-pid-orphan']);
});

test('partitionBootOrphans ignores non-running jobs entirely', () => {
  const jobs = [
    { slug: 'a', status: 'completed', runtime: { pid: 1 } },
    { slug: 'b', status: 'failed', runtime: { pid: 2 } },
  ];
  const { immediate, deferred } = partitionBootOrphans(jobs, () => true);
  assert.deepEqual(immediate, []);
  assert.deepEqual(deferred, []);
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

// ── feedback sweep moved into the 60s poll tick (PRD 686) ───────────────────

test('feedbackSweepDue gates on the tick interval, not every tick', () => {
  for (let i = 1; i < FEEDBACK_SWEEP_TICK_INTERVAL; i++) {
    assert.equal(feedbackSweepDue(i), false, `tick ${i} should not be due yet`);
  }
  assert.equal(feedbackSweepDue(FEEDBACK_SWEEP_TICK_INTERVAL), true);
  assert.equal(feedbackSweepDue(FEEDBACK_SWEEP_TICK_INTERVAL + 1), true);
});

test('scheduler.cjs reuses watchdogHelpers.sweep verbatim (no forked copy)', () => {
  const { sweep } = require('../../../scripts/lib/watchdogHelpers.cjs');
  assert.equal(sweepFeedback, sweep, 'scheduler.cjs must import the same sweep function, not reimplement it');
});

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-boot-sweep-'));
}

function makeQueue(base) {
  const queuePath = path.join(base, 'queue.json');
  fs.writeFileSync(queuePath, JSON.stringify({ version: 1, jobs: [], paused: null }, null, 2));
  return queuePath;
}

const FAKE_SKILL = '---\nname: process-feedback\ndescription: x\n---\n\n# process-feedback\n\nbody\n';
const FAKE_STANDARDS = '# Engineering standards\n\nbody\n';

test('the poll-tick sweep call emits a PRD for an active project with open feedback, and skips one outside the 90-min window', () => {
  const base = makeTmpDir();
  try {
    // Active project (10 min ago) with open feedback → should emit.
    const activeProj = path.join(base, 'active-proj');
    fs.mkdirSync(path.join(activeProj, 'session-manager-operations', 'feedback'), { recursive: true });
    fs.writeFileSync(path.join(activeProj, 'session-manager-operations', 'feedback', '2026-01-01-item.md'), '# Item\n');

    // Stale project (120 min ago, outside the 90-min window) with open feedback → should NOT be scanned at all.
    const staleProj = path.join(base, 'stale-proj');
    fs.mkdirSync(path.join(staleProj, 'session-manager-operations', 'feedback'), { recursive: true });
    fs.writeFileSync(path.join(staleProj, 'session-manager-operations', 'feedback', '2026-01-01-item.md'), '# Item\n');

    // Active project with no open feedback → scanned but not emitted.
    const noFeedbackProj = path.join(base, 'no-feedback-proj');
    fs.mkdirSync(noFeedbackProj, { recursive: true });

    const projectsDir = path.join(base, 'projects');
    const recent = new Date(Date.now() - 10 * 60 * 1000);
    const stale = new Date(Date.now() - 120 * 60 * 1000);
    for (const [slug, cwd, mtime] of [
      ['slug-active', activeProj, recent],
      ['slug-stale', staleProj, stale],
      ['slug-no-feedback', noFeedbackProj, recent],
    ]) {
      const projDir = path.join(projectsDir, slug);
      fs.mkdirSync(projDir, { recursive: true });
      const fp = path.join(projDir, 'a.jsonl');
      fs.writeFileSync(fp, JSON.stringify({ cwd }) + '\n');
      fs.utimesSync(fp, mtime, mtime);
    }

    const prdsDir = path.join(base, 'prds');
    fs.mkdirSync(prdsDir);
    const queuePath = makeQueue(base);
    const skillPath = path.join(base, 'SKILL.md');
    const standardsPath = path.join(base, 'standards.md');
    fs.writeFileSync(skillPath, FAKE_SKILL);
    fs.writeFileSync(standardsPath, FAKE_STANDARDS);

    const result = sweepFeedback({ projectsDir, prdsDir, queuePath, skillPath, standardsPath });

    assert.equal(result.scanned, 2, 'only the two in-window projects should be scanned');
    assert.equal(result.emitted, 1, 'only the active project with open feedback should get a PRD');

    const emittedFiles = fs.readdirSync(prdsDir).filter((f) => f.endsWith('.md'));
    assert.equal(emittedFiles.length, 1);
    assert.match(emittedFiles[0], /feedback-active-proj\.md$/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
