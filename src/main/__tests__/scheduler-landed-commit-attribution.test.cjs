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

test('in-place run: foreign commit in range, sibling overlap, no transcript sha gives null', () => {
  assert.deepEqual(
    resolveRunCommitAttribution({
      ranInWorktree: false, integratedSha: null, headBefore: 'aaa', headAtExit: 'fff',
      committedInWindow: true, rangeCommits: ['f'.repeat(40)], transcriptCommitShas: [], siblingOverlap: true,
    }),
    { landedCommit: null, committedDuringRun: false },
  );
});

test('in-place run: own transcript short sha resolves to the full range sha', () => {
  const own = '347641f' + '0'.repeat(33);
  assert.deepEqual(
    resolveRunCommitAttribution({
      ranInWorktree: false, integratedSha: null, headBefore: 'aaa', headAtExit: own,
      committedInWindow: true, rangeCommits: ['f'.repeat(40), own], transcriptCommitShas: ['347641f'], siblingOverlap: true,
    }),
    { landedCommit: own, committedDuringRun: true },
  );
});

test('in-place run: no transcript shas and no sibling overlap keeps legacy HEAD delta', () => {
  assert.deepEqual(
    resolveRunCommitAttribution({
      ranInWorktree: false, integratedSha: null, headBefore: 'aaa', headAtExit: 'bbb',
      committedInWindow: false, rangeCommits: ['b'.repeat(40)], transcriptCommitShas: [], siblingOverlap: false,
    }),
    { landedCommit: 'bbb', committedDuringRun: true },
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
