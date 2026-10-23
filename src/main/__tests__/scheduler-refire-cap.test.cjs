/**
 * scheduler-refire-cap.test.cjs — post-run downgrade-to-pending re-fire cap.
 *
 * Covers the pieces spawnJob's finalize composes: decideVerifyDowngrade,
 * resetJobFields (clears then the refire path re-sets verifyRefireCount), and
 * the needs_review ladder refusing to touch a `refire_capped` row.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-refire-cap.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'refire-cap-test-'));
const PROJECT_CWD = path.join(process.env.HOME, 'project');
fs.mkdirSync(PROJECT_CWD, { recursive: true });

const { resetJobFields, applyNeedsReviewAutoResolve } = require('../scheduler.cjs');
const { transitionJob } = require('../lib/scheduler/scheduleJobTransitions.cjs');
const { decideVerifyDowngrade } = require('../lib/scheduler/refireCap.cjs');
const ladder = require('../scheduler/reviewLadder.cjs');

const DEPS = { verdict: 'deps_unmet', reason: 'dependency not met', downgradeTo: 'pending' };

// Mirrors the downgrade branch in spawnJob's finalize.
function finalizeDowngrade(job) {
  const d = decideVerifyDowngrade(job, DEPS);
  if (d.action === 'refire') {
    if (resetJobFields(job, DEPS.reason, { source: 'spawnJob:verify-downgrade' })) job.verifyRefireCount = d.nextCount;
    return;
  }
  job.error = d.reason;
  job.verifierVerdict = d.verdict;
  delete job.verifyRefireCount;
  transitionJob(job, 'needs_review', { reason: d.reason, source: 'spawnJob:finalize' });
}

const running = () => {
  const j = { slug: '1-x', status: 'pending', cwd: PROJECT_CWD, runId: 'r1' };
  transitionJob(j, 'running', { reason: 'start', source: 'test' });
  return j;
};
const rerun = (j) => { transitionJob(j, 'running', { reason: 'start', source: 'test' }); };

test('three consecutive downgrades: runs 1-2 re-fire, run 3 parks refire_capped', () => {
  const j = running();
  finalizeDowngrade(j);
  assert.equal(j.status, 'pending');
  assert.equal(j.verifyRefireCount, 1);
  rerun(j); finalizeDowngrade(j);
  assert.equal(j.status, 'pending');
  assert.equal(j.verifyRefireCount, 2);
  rerun(j); finalizeDowngrade(j);
  assert.equal(j.status, 'needs_review');
  assert.equal(j.verifierVerdict, 'refire_capped');
  assert.match(j.error, /re-fire cap: 3 consecutive/);
  assert.equal(j.verifyRefireCount, undefined);
});

test('a human reset clears the count; a clean outcome (delete) restarts it', () => {
  const j = running();
  finalizeDowngrade(j);
  assert.equal(j.verifyRefireCount, 1);
  rerun(j);
  delete j.verifyRefireCount; // any non-downgrade finalize outcome
  finalizeDowngrade(j);
  assert.equal(j.verifyRefireCount, 1);
  j.verifyRefireCount = 2;
  resetJobFields(j, null, { source: 'ipc:schedule:reset-job' });
  assert.equal(j.verifyRefireCount, undefined);
});

test('ladder never resets, rescans, auto-fixes or auto-resolves a refire_capped row', () => {
  const j = {
    slug: '1-x', status: 'needs_review', cwd: PROJECT_CWD, runId: 'r1',
    verifierVerdict: 'refire_capped', autoFixAttempted: true, autoFixOutcome: 'exhausted',
    looksDone: { rule: 'r', commits: ['abc'] },
  };
  assert.equal(ladder.isRefireCapped(j), true);
  assert.equal(ladder.isRescanCandidate(j), false);
  assert.equal(ladder.isEligibleForNeedsReviewAutoResolve(j, [j]), false);
  assert.deepEqual(ladder.selectAutoFixTargets([j], { fixSlugExists: () => false }), []);
  assert.deepEqual(ladder.selectEvidenceScanTargets([j]), []);
  assert.deepEqual(ladder.selectExhaustedNeedsReviewTargets([j], Date.now() + 1e12, 0), []);
  assert.equal(applyNeedsReviewAutoResolve(j, [j]), null);
  assert.equal(j.status, 'needs_review');
});
