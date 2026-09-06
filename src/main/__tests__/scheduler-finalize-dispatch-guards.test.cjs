/**
 * scheduler-finalize-dispatch-guards.test.cjs — regression cover for the
 * 2026-09-06 incident: PRD 1133 (reaper integration check) shipped correctly
 * in commit 5de4134, but its finalize mutate's silent early-return dropped
 * three subsequent no-op re-verifications of the same already-shipped slug
 * with no audit trail, leaving the row stuck 'pending' forever and causing
 * the dispatcher to re-fire it three more times.
 *
 * Covers the three pure decision helpers extracted for this fix:
 *  - evaluateFinalizeDrop: never silently discard a finalize (row missing,
 *    or row moved off 'running' by a concurrent cancel) — always says so,
 *    and still lets a genuinely-landed commit be stamped as a durable fact.
 *  - evaluateDispatchSidecarReconcile: refuse to re-dispatch a pending row
 *    whose newest run sidecar already shows a completed-equivalent outcome
 *    for THIS queueing episode.
 *  - isQueueRowRegression: detect (never repair) a running->pending change
 *    whose statusHistory got shorter — evidence of lost state, not a real
 *    transition.
 *
 * HOME is overridden to a tmp dir BEFORE requiring scheduler.cjs, matching
 * scheduler-reap-dead-running-jobs.test.cjs's pattern — every path this
 * module touches is baked into a top-level const from os.homedir() at
 * require time.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-finalize-dispatch-guards.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-finalize-dispatch-guards-test-'));
process.env.HOME = tmpHome;

const {
  evaluateFinalizeDrop,
  evaluateDispatchSidecarReconcile,
  isQueueRowRegression,
} = require('../scheduler.cjs');

describe('evaluateFinalizeDrop', () => {
  it('drops loudly (row-missing) with nothing to stamp when the row vanished from s.jobs', () => {
    const decision = evaluateFinalizeDrop({
      rowExists: false,
      rowStatus: null,
      rowRunId: null,
      rowLandedCommit: null,
      runId: 'run-2',
      landedCommit: 'deadbeef',
    });
    assert.equal(decision.drop, true);
    assert.equal(decision.reason, 'row-missing');
    assert.equal(decision.stampLandedCommit, null);
  });

  it('drops the status change (row-not-running) but stamps landedCommit when this run owns the row', () => {
    const decision = evaluateFinalizeDrop({
      rowExists: true,
      rowStatus: 'failed', // e.g. remote.cancelJob already finalized it (PRD 1024)
      rowRunId: 'run-2',
      rowLandedCommit: null,
      runId: 'run-2',
      landedCommit: 'deadbeef',
    });
    assert.equal(decision.drop, true);
    assert.equal(decision.reason, 'row-not-running');
    assert.equal(decision.stampLandedCommit, 'deadbeef');
  });

  it('stamps landedCommit even when the row carries a different runId, as long as it has none of its own', () => {
    const decision = evaluateFinalizeDrop({
      rowExists: true,
      rowStatus: 'pending',
      rowRunId: 'some-other-run',
      rowLandedCommit: null,
      runId: 'run-2',
      landedCommit: 'deadbeef',
    });
    assert.equal(decision.drop, true);
    assert.equal(decision.stampLandedCommit, 'deadbeef');
  });

  it('never overwrites a row that already carries its own newer landedCommit from a different run', () => {
    const decision = evaluateFinalizeDrop({
      rowExists: true,
      rowStatus: 'failed',
      rowRunId: 'some-other-run',
      rowLandedCommit: 'already-there',
      runId: 'run-2',
      landedCommit: 'deadbeef',
    });
    assert.equal(decision.drop, true);
    assert.equal(decision.stampLandedCommit, null);
  });

  it('never re-legalizes a cancelled (failed) row back to completed — the PRD-1024 protection', () => {
    // The finalize call site never even reaches transitionJob for a dropped
    // finalize; this test documents the contract evaluateFinalizeDrop enforces:
    // drop:true means the caller MUST NOT change job.status.
    const decision = evaluateFinalizeDrop({
      rowExists: true,
      rowStatus: 'failed',
      rowRunId: 'run-2',
      rowLandedCommit: null,
      runId: 'run-2',
      landedCommit: 'deadbeef',
    });
    assert.equal(decision.drop, true);
  });

  it('does not drop when the row is still running — the normal finalize path', () => {
    const decision = evaluateFinalizeDrop({
      rowExists: true,
      rowStatus: 'running',
      rowRunId: 'run-2',
      rowLandedCommit: null,
      runId: 'run-2',
      landedCommit: 'deadbeef',
    });
    assert.equal(decision.drop, false);
    assert.equal(decision.stampLandedCommit, null);
  });
});

describe('evaluateDispatchSidecarReconcile', () => {
  const baseRow = {
    rowStatus: 'pending',
    rowRunId: null,
    statusHistory: [
      { from: 'running', to: 'pending', at: '2026-09-06T19:30:00.000Z' },
    ],
    queuedAt: '2026-09-06T17:02:07.815Z',
  };

  it('skips dispatch when a prior run of this slug already completed after the last pending transition', () => {
    const decision = evaluateDispatchSidecarReconcile({
      ...baseRow,
      outcome: { status: 'completed', runId: '2026-09-06T19-26-54-681Z', finishedAt: '2026-09-06T19:35:00.000Z' },
    });
    assert.equal(decision.skip, true);
    assert.equal(decision.runId, '2026-09-06T19-26-54-681Z');
  });

  it('proceeds with dispatch when a deliberate human re-queue postdates the earlier completion', () => {
    // The re-queue's own pending transition (19:30) is AFTER the completed
    // sidecar's finishedAt (18:00) — an OLDER episode's completion, not this one.
    const decision = evaluateDispatchSidecarReconcile({
      ...baseRow,
      outcome: { status: 'completed', runId: 'old-run', finishedAt: '2026-09-06T18:00:00.000Z' },
    });
    assert.equal(decision.skip, false);
  });

  it('proceeds with dispatch when there is no sidecar at all (guard is a no-op)', () => {
    const decision = evaluateDispatchSidecarReconcile({ ...baseRow, outcome: null });
    assert.equal(decision.skip, false);
  });

  it('proceeds with dispatch when the sidecar belongs to this row\'s own current runId', () => {
    const decision = evaluateDispatchSidecarReconcile({
      ...baseRow,
      rowRunId: 'run-x',
      outcome: { status: 'completed', runId: 'run-x', finishedAt: '2026-09-06T19:35:00.000Z' },
    });
    assert.equal(decision.skip, false);
  });

  it('proceeds with dispatch when the row is not pending (e.g. needs_review resume-recovery)', () => {
    const decision = evaluateDispatchSidecarReconcile({
      ...baseRow,
      rowStatus: 'needs_review',
      outcome: { status: 'completed', runId: 'some-run', finishedAt: '2026-09-06T19:35:00.000Z' },
    });
    assert.equal(decision.skip, false);
  });

  it('proceeds with dispatch when the newest sidecar reports a failed (not completed-equivalent) outcome', () => {
    const decision = evaluateDispatchSidecarReconcile({
      ...baseRow,
      outcome: { status: 'failed', runId: 'some-run', finishedAt: '2026-09-06T19:35:00.000Z' },
    });
    assert.equal(decision.skip, false);
  });

  it('falls back to queuedAt when the row has never been reset (no pending statusHistory entry)', () => {
    const decision = evaluateDispatchSidecarReconcile({
      rowStatus: 'pending',
      rowRunId: null,
      statusHistory: [],
      queuedAt: '2026-09-06T17:02:07.815Z',
      outcome: { status: 'completed', runId: 'some-run', finishedAt: '2026-09-06T19:35:00.000Z' },
    });
    assert.equal(decision.skip, true);
  });
});

describe('isQueueRowRegression', () => {
  it('flags a running->pending change whose statusHistory got shorter', () => {
    assert.equal(
      isQueueRowRegression({ statusBefore: 'running', statusAfter: 'pending', historyLenBefore: 5, historyLenAfter: 3 }),
      true,
    );
  });

  it('does not flag a running->pending change with a normal appended (equal or longer) history', () => {
    assert.equal(
      isQueueRowRegression({ statusBefore: 'running', statusAfter: 'pending', historyLenBefore: 5, historyLenAfter: 6 }),
      false,
    );
    assert.equal(
      isQueueRowRegression({ statusBefore: 'running', statusAfter: 'pending', historyLenBefore: 20, historyLenAfter: 20 }),
      false,
    );
  });

  it('does not flag a shortened history on transitions other than running->pending', () => {
    assert.equal(
      isQueueRowRegression({ statusBefore: 'pending', statusAfter: 'completed', historyLenBefore: 5, historyLenAfter: 3 }),
      false,
    );
    assert.equal(
      isQueueRowRegression({ statusBefore: 'running', statusAfter: 'completed', historyLenBefore: 5, historyLenAfter: 3 }),
      false,
    );
  });
});
