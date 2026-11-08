/**
 * scheduler-finalize-worktree-snapshot.test.cjs — finalizeJobWorktree returns
 * the uncommitted-work snapshot its cleanupJobWorktree call took (PRD 2893),
 * so spawnJob can stamp it on the terminal row next to salvagePatch.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-finalize-worktree-snapshot.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { finalizeJobWorktree } = require('../scheduler.cjs');

function makeDeps(cleanupResult, overrides = {}) {
  const calls = [];
  const jobWorktree = {
    salvageJobWorktreeDiff: async () => ({ ok: false }),
    reconcileWorktreeHead: async () => ({ action: 'on-branch', finalHead: null }),
    integrateJobBranch: async () => ({ ok: true, integrated: false, reason: 'branch has no new commits' }),
    pinUnlandedWorktreeCommits: async () => [],
    cleanupJobWorktree: async (args) => { calls.push(args); return cleanupResult; },
    ...overrides,
  };
  return {
    calls,
    deps: {
      jobWorktree,
      uncommittedChanges: async () => ['src/a.js'],
      reportSchedulerError: () => {},
      isRunCancelled: async () => false,
    },
  };
}

function run(deps) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-finalize-snap-'));
  return finalizeJobWorktree({
    job: { slug: 'snap-job' },
    runId: 'r1',
    runDir,
    worktree: { dir: path.join(runDir, 'wt'), branch: 'sm-job/snap-job', baseBranch: 'main' },
    guardCwd: runDir,
    carriedPaths: [],
    deps,
  }).finally(() => fs.rmSync(runDir, { recursive: true, force: true }));
}

test('returns the snapshot cleanupJobWorktree took', async () => {
  const snap = { sha: 'cafe1234', ref: 'refs/sm-uncommitted/snap-job/cafe1234', paths: ['src/a.js'] };
  const { deps, calls } = makeDeps({ removed: true, snapshot: snap });
  const out = await run(deps);
  assert.equal(calls.length, 1);
  assert.deepEqual(out.uncommittedSnapshot, { sha: 'cafe1234', ref: 'refs/sm-uncommitted/snap-job/cafe1234' });
});

test('returns null when the removal took no snapshot', async () => {
  const { deps } = makeDeps({ removed: true, snapshot: null });
  const out = await run(deps);
  assert.equal(out.uncommittedSnapshot, null);
});

test('returns the snapshot from the cancelled-run cleanup path', async () => {
  const snap = { sha: 'beef5678', ref: 'refs/sm-uncommitted/snap-job/beef5678' };
  const { deps } = makeDeps({ removed: true, snapshot: snap });
  deps.isRunCancelled = async () => true;
  const out = await run(deps);
  assert.equal(out.cancelled, true);
  assert.deepEqual(out.uncommittedSnapshot, { sha: 'beef5678', ref: 'refs/sm-uncommitted/snap-job/beef5678' });
});

test('returns the snapshot from the error-path cleanup', async () => {
  const snap = { sha: 'f00d9abc', ref: 'refs/sm-uncommitted/snap-job/f00d9abc' };
  const { deps } = makeDeps({ removed: true, snapshot: snap }, {
    integrateJobBranch: async () => { throw new Error('boom'); },
  });
  const out = await run(deps);
  assert.match(out.worktreeIntegrationFailure, /boom/);
  assert.deepEqual(out.uncommittedSnapshot, { sha: 'f00d9abc', ref: 'refs/sm-uncommitted/snap-job/f00d9abc' });
});
