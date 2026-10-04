/**
 * scheduler-landed-commit-attribution.test.cjs — a worktree-isolated run takes
 * landed-commit credit only from its own integration result, never from a
 * concurrent job's commit moving the shared checkout's HEAD.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-landed-commit-attribution.test.cjs
 */

'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const { resolveRunCommitAttribution, finalizeJobWorktree } = require('../scheduler.cjs');

test('worktree run: foreign HEAD move with no own integration gets no credit', () => {
  const r = resolveRunCommitAttribution({
    ranInWorktree: true, integratedSha: null, headBefore: 'aaa', headAtExit: 'bbb', committedInWindow: true,
  });
  assert.deepEqual(r, { landedCommit: null, committedDuringRun: false });
});

test('worktree run: own integratedSha is the landed commit', () => {
  const r = resolveRunCommitAttribution({
    ranInWorktree: true, integratedSha: 'ccc', headBefore: 'aaa', headAtExit: 'bbb', committedInWindow: false,
  });
  assert.deepEqual(r, { landedCommit: 'ccc', committedDuringRun: true });
});

test('in-place run: legacy behaviour unchanged', () => {
  assert.deepEqual(
    resolveRunCommitAttribution({ ranInWorktree: false, integratedSha: null, headBefore: 'aaa', headAtExit: 'bbb', committedInWindow: false }),
    { landedCommit: 'bbb', committedDuringRun: true },
  );
  assert.deepEqual(
    resolveRunCommitAttribution({ ranInWorktree: false, integratedSha: null, headBefore: 'aaa', headAtExit: 'aaa', committedInWindow: true }),
    { landedCommit: null, committedDuringRun: true },
  );
  assert.deepEqual(
    resolveRunCommitAttribution({ ranInWorktree: false, integratedSha: null, headBefore: 'aaa', headAtExit: 'aaa', committedInWindow: false }),
    { landedCommit: null, committedDuringRun: false },
  );
});

function finalizeWith(integration) {
  return finalizeJobWorktree({
    job: { slug: 'x' },
    runDir: '/tmp/none',
    worktree: { dir: '/tmp/wt', branch: 'sm-job/x', baseBranch: 'main' },
    guardCwd: '/tmp/repo',
    carriedPaths: [],
    deps: {
      jobWorktree: {
        integrateJobBranch: async () => integration,
        cleanupJobWorktree: async () => ({ ok: true }),
        salvageJobWorktreeDiff: async () => ({ ok: false }),
      },
      uncommittedChanges: async () => [],
      reportSchedulerError: () => {},
    },
  });
}

test('finalizeJobWorktree propagates integratedSha when integrated', async () => {
  const r = await finalizeWith({ ok: true, integrated: true, fastForward: true, sha: 'abc123' });
  assert.equal(r.integratedSha, 'abc123');
});

test('finalizeJobWorktree integratedSha is null for no new commits', async () => {
  const r = await finalizeWith({ ok: true, integrated: false, reason: 'branch has no new commits' });
  assert.equal(r.integratedSha, null);
});
