/**
 * scheduler-reset-job-fields-guard.test.cjs — unit tests for resetJobFields'
 * terminal-status guard.
 *
 * A 'completed' job already landed its deliverable — resetting it back to
 * 'pending' re-fires the PRD and re-executes already-shipped work (the
 * incident: PRD 812-workbench-review-nits-cleanup was reset and re-run this
 * way, burning a full claude -p job + Opus investigation over a correct
 * no-op). resetJobFields must refuse (no-op) on a 'completed' job unless
 * opts.force is true, and must still reset normally for every non-terminal
 * status (pending/running/failed/needs_review).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-reset-job-fields-guard.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { resetJobFields } = require('../scheduler.cjs');

function makeJob(status, overrides = {}) {
  return {
    slug: 'test-slug',
    status,
    runId: 'run-123',
    startedAt: '2026-07-31T00:00:00.000Z',
    finishedAt: '2026-07-31T00:05:00.000Z',
    exitCode: 0,
    error: null,
    runtime: { pid: 999 },
    verifierVerdict: 'pass',
    landedCommit: 'abc1234',
    ...overrides,
  };
}

test('resetJobFields: refuses and does not mutate a completed job', () => {
  const job = makeJob('completed');
  const snapshot = { ...job };
  const result = resetJobFields(job, 'some error');
  expect(result).toBe(false);
  expect(job).toEqual(snapshot);
});

test('resetJobFields: force:true overrides the guard on a completed job', () => {
  const job = makeJob('completed');
  const result = resetJobFields(job, 'forced reset', { force: true });
  expect(result).toBe(true);
  expect(job.status).toBe('pending');
  expect(job.runId).toBeNull();
  expect(job.startedAt).toBeNull();
  expect(job.finishedAt).toBeNull();
  expect(job.exitCode).toBeNull();
  expect(job.error).toBe('forced reset');
  expect(job.runtime).toBeUndefined();
  expect(job.verifierVerdict).toBeUndefined();
  // landedCommit must survive even a forced reset — it feeds the
  // pass_no_commit_prior_run_verified exemption on a later re-run.
  expect(job.landedCommit).toBe('abc1234');
});

for (const status of ['pending', 'running', 'failed', 'needs_review']) {
  test(`resetJobFields: resets normally for non-terminal status '${status}'`, () => {
    const job = makeJob(status);
    const result = resetJobFields(job, 'retry reason');
    expect(result).toBe(true);
    expect(job.status).toBe('pending');
    expect(job.runId).toBeNull();
    expect(job.startedAt).toBeNull();
    expect(job.finishedAt).toBeNull();
    expect(job.exitCode).toBeNull();
    expect(job.error).toBe('retry reason');
    expect(job.runtime).toBeUndefined();
    expect(job.verifierVerdict).toBeUndefined();
    expect(job.landedCommit).toBe('abc1234');
  });
}
